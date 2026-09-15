# Copiloto QS — Frente A: Banco e fundação

Migrations do módulo `qs_copilot_*` para o Supabase do QS (`SEU_PROJECT_ID`, sa-east-1, Postgres 17.6).

## Arquivos

| Arquivo | O que faz | Depende de |
|---|---|---|
| `001_schema.sql` | Orgs, calls, turnos de transcrição, objeções, respostas versionadas, detecções, feedback, resumos, chunks de playbook, settings. Triggers de `updated_at` e de denormalização. Realtime. | tabelas legadas `qs_*` |
| `002_pgvector.sql` | Extensão `vector`, colunas `embedding vector(1536)`, índices HNSW, `match_objecao`, `match_objecao_hibrido`, `match_playbook`, fila de embeddings pendentes. | 001 |
| `003_rls.sql` | `qs_current_user_id()` multi-fonte, `qs_current_org_id()`, papéis, RLS em todas as tabelas, grants. Bloco comentado com a versão pós-Auth. | 001, 002 |
| `004_views_analytics.sql` | Views `qs_copilot_vw_*`: catálogo de calls, objeções frequentes, taxa de uso por closer, objeções em leads perdidos (× `qs_loss_reasons`), ranking de closers, custo por dia/mês, timeline da call. | 001, 003 |
| `005_alter_qs_meetings.sql` | Adiciona `meeting_url`, `duration_seconds`, `outcome`, `copilot_call_id` em `qs_meetings` + trigger que vincula a call à reunião. | 001 |
| `005_types_meeting.patch` | (opcional) Tipagem das colunas novas em `src/components/sdr/types.ts`. **Já aplicado** no repo do QS. | — |
| `006_fix_handover.sql` | Corrige leads com `status = 'qualificado'` → `em_prospeccao`, loga o que mudou, adiciona CHECK em `qs_leads.status`. | — |
| `006_fix_handover.patch` | Fix em `src/lib/qs/queries.ts` (`handoverLead`). **Já aplicado** no repo do QS. | — |
| `007_seed_objecoes.sql` | 30 objeções de viagem internacional de alto ticket, 13 categorias, resposta primária ≤ 20 palavras. | 001 |

## Pré-requisitos

1. **Restaurar o projeto** (está pausado): Dashboard → Project Settings → General → *Restore project*. Espere o status ficar `ACTIVE_HEALTHY`.
2. **Snapshot antes de tudo:** Database → Backups → *Create backup* (ou `pg_dump` via connection string). `006` altera dados do legado.
3. Confirmar que as tabelas legadas existem: `qs_users, qs_leads, qs_meetings, qs_tasks, qs_notes, qs_handovers, qs_loss_reasons`. `001` aborta com mensagem clara se faltar alguma.
4. Extensão `vector` disponível (Database → Extensions). `002` habilita; em Supabase ela vem instalável por padrão.

## Como aplicar

Qualquer uma das três formas. Sempre na ordem numérica.

**A) SQL Editor do dashboard** — colar o conteúdo de cada arquivo e rodar. Cada arquivo é uma transação (`begin; … commit;`): ou aplica inteiro ou nada.

**B) psql**
```bash
export DATABASE_URL='postgresql://postgres.[ref]:[senha]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres'
for f in sql/00{1,2,3,4,5,6,7}_*.sql; do
  echo "== $f"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break
done
```
Use a porta **5432** (sessão), não 6543 (transaction pooler): `002` usa `SET LOCAL maintenance_work_mem` e `CREATE INDEX` HNSW, que precisam de sessão direta.

**C) MCP Supabase (`apply_migration`)** — um arquivo por chamada, nome = nome do arquivo sem extensão. O MCP roda como `postgres`, então funciona igual ao SQL Editor.

Todas as migrations são **idempotentes**: rodar duas vezes não quebra nem duplica.

## Validação por migration

### 001 — schema
```sql
select table_name from information_schema.tables
 where table_schema = 'public' and table_name like 'qs_copilot%' order by 1;
-- 11 tabelas: orgs, org_members, calls, transcript_turns, objections, objection_responses,
--             detections, feedback, summaries, playbook_chunks, settings
select * from public.qs_copilot_orgs;                          -- 1 linha: inovvatur
select count(*) from public.qs_copilot_org_members;            -- = count(*) de qs_users
select scope, org_id from public.qs_copilot_settings;          -- 1 linha global

-- teste funcional: call + turno + detecção + feedback (roda e desfaz)
begin;
  insert into public.qs_copilot_calls (closer_id, status, started_at)
  select id, 'gravando', now() from public.qs_users where is_active limit 1 returning id \gset
  insert into public.qs_copilot_transcript_turns (call_id, seq, speaker, content, offset_ms)
  values (:'id', 0, 'lead', 'achei bem salgado', 1200);
  select closer_id is not null as denormalizou from public.qs_copilot_transcript_turns where call_id = :'id';
  update public.qs_copilot_calls set status = 'concluida', ended_at = now() + interval '10 min' where id = :'id';
  select duration_seconds, total_cost_brl from public.qs_copilot_calls where id = :'id';  -- 600, 0
rollback;
```
(No SQL Editor, substitua `\gset` por um uuid fixo.)

### 002 — pgvector
```sql
select extname, extversion from pg_extension where extname = 'vector';   -- >= 0.8
select indexname from pg_indexes where indexname like '%emb_hnsw';       -- 2 índices
select column_name, udt_name from information_schema.columns
 where table_name = 'qs_copilot_objections' and column_name = 'embedding';  -- vector
-- função responde (vetor zerado, sem resultados, mas sem erro):
select * from public.match_objecao(array_fill(0, array[1536])::vector, 0.5, 3);
```

### 003 — RLS
```sql
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename like 'qs_copilot%';           -- todas true
select count(*) from pg_policies where tablename like 'qs_copilot%';     -- ~35 policies

-- simular um closer (fonte 3: GUC) e verificar que só vê as próprias calls
begin;
  set local role authenticated;
  set local app.qs_user_id = '<uuid de um closer>';
  select public.qs_current_user_id(), public.qs_current_role(), public.qs_current_org_id();
  select count(*) from public.qs_copilot_calls;    -- só dele
rollback;

-- simular gestor
begin;
  set local role authenticated;
  set local app.qs_user_id = '<uuid de um gestor>';
  select count(*) from public.qs_copilot_calls;    -- todas da org
rollback;

-- anônimo: deve dar 0 linhas (ou permission denied)
begin; set local role anon; select count(*) from public.qs_copilot_objections; rollback;
```

### 004 — views
```sql
select viewname from pg_views where viewname like 'qs_copilot_vw%';     -- 9 views (8 + embeddings_pendentes)
select * from public.qs_copilot_vw_calls limit 5;
select * from public.qs_copilot_vw_custo_por_mes;
select * from public.qs_copilot_vw_objecoes_leads_perdidos;             -- vazia até ter ≥ 3 calls com desfecho
```

### 005 — qs_meetings
```sql
select column_name, data_type from information_schema.columns
 where table_name = 'qs_meetings' order by ordinal_position;             -- 4 colunas novas no fim
select count(*) from public.qs_meetings;                                 -- mesmo número de antes
-- o app continua funcionando: fetchQsMeetings faz select *, colunas novas vêm NULL
```

### 006 — fix handover
```sql
select status, count(*) from public.qs_leads group by 1;                 -- sem 'qualificado'
select * from public.qs_leads_status_fix_log;                            -- quem foi corrigido
select conname from pg_constraint where conname = 'qs_leads_status_chk'; -- existe
```
E no front: `git diff` em `qs-system` mostra `HANDOVER_STATUS: LeadStatus = "em_prospeccao"` em `handoverLead`.

### 007 — seed
```sql
select categoria, count(*) from public.qs_copilot_objections group by 1 order by 1;   -- 13 linhas, total 30
select count(*) from public.qs_copilot_objection_responses where is_primary;         -- 30
select count(*) from public.qs_copilot_vw_embeddings_pendentes;                      -- 30 até o backfill
```

## Depois de aplicar: backfill de embeddings

O seed deixa `embedding = NULL`. O gateway (Frente B) precisa, uma vez:

```
for row in select * from qs_copilot_vw_embeddings_pendentes:
    vec  = embed(row.texto)                       # text-embedding-3-small → 1536 floats
    hash = sha256(row.texto).hex()
    update qs_copilot_objections
       set embedding = vec, embedding_updated_at = now(), embedding_source_hash = hash
     where id = row.id           # (ou qs_copilot_playbook_chunks para tipo = 'chunk')
```

Sem isso `match_objecao` devolve vazio e o copiloto funciona só com a camada L0 (gatilhos literais).

## Como o gateway deve conversar com o banco

| Operação | Conexão | RLS |
|---|---|---|
| Escrever turnos, detecções, resumos | `service_role` (ou pool direto com `SET LOCAL app.qs_user_id`) | bypass / GUC |
| QS lendo histórico, playbook, analytics | anon key + `Authorization: Bearer <JWT do gateway com claim qs_user_id>` | policies de 003 |
| `match_objecao` no caminho crítico | pool direto, `SET LOCAL hnsw.ef_search = 40` | invoker |

O JWT do gateway é assinado com o **JWT Secret** do projeto (Settings → API). Ver bloco final de `003_rls.sql`.

## Rollback

Cada arquivo tem o bloco `ROLLBACK` comentado no fim. Ordem inversa: `007 → 006 → 005 → 004 → 003 → 002 → 001`. `005` precisa cair antes de `001` (FK em `qs_meetings`).

## Riscos conhecidos

1. **Projeto pausado** — nada disto foi executado contra o banco real. A sintaxe foi validada com o parser do Postgres (`pglast`/libpg_query), mas semântica (tipos de colunas legadas, extensões) só se confirma ao aplicar. Rode em ordem, um arquivo por vez, e leia os `NOTICE`.
2. **`qs_products` com schema desconhecido** — `001` cria a FK `produto_id → qs_products` só se a tabela tiver `id uuid`; caso contrário a coluna fica solta e um `NOTICE` avisa.
4. **`006` altera dados de produção** — faça backup antes. O log `qs_leads_status_fix_log` permite reverter linha a linha.
5. **CHECK em `qs_leads.status`** — se no futuro alguém quiser um status novo, precisa alterar `LeadStatus`, `STATUS_LABELS`, os filtros em `queries.ts` **e** essa constraint.
6. **Threshold 0.78** é chute calibrado para 3-small. Meça com frases reais antes de confiar; ajusta em `qs_copilot_settings.similarity_threshold` sem migration.
7. **Realtime** — `001` adiciona `qs_copilot_calls` e `qs_copilot_detections` à publicação `supabase_realtime` com `REPLICA IDENTITY FULL`. Turnos **não** entram: interim deve ir por Broadcast.
