-- ═══════════════════════════════════════════════════════════════════════════
-- 002_pgvector.sql — extensão, colunas de embedding, índices HNSW, busca
-- Depende de: 001_schema.sql
-- Postgres 17.6 · pgvector >= 0.8 (Supabase sa-east-1)
--
-- ┌─ DIMENSÃO: vector(1536) ────────────────────────────────────────────────┐
-- │ Modelo alvo: text-embedding-3-small (1536 dims).                        │
-- │ Por quê:                                                                │
-- │  · Anthropic não fornece embeddings; a camada L2/L3 usa Claude, mas a   │
-- │    busca L1 precisa de um modelo de embedding à parte. 3-small é o      │
-- │    melhor custo/recall para frases curtas em pt-BR (o que o lead fala). │
-- │  · Índice HNSW sobre o tipo `vector` aceita no máximo 2000 dims → 1536  │
-- │    cabe; 3072 (3-large) NÃO caberia sem virar halfvec.                  │
-- │  · Storage: 1536 × 4 B = 6 KB/linha. Com ~500 objeções + ~20k chunks de │
-- │    playbook dá ~125 MB de vetor — irrelevante para o plano.             │
-- │ Trocar de modelo (ex.: Voyage 1024 dims) = re-embedar tudo + ALTER da   │
-- │ coluna. A coluna embedding_model existe para detectar mistura de        │
-- │ modelos e o CHECK de dimensão impede ingestão errada em silêncio.       │
-- └─────────────────────────────────────────────────────────────────────────┘
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- Supabase instala extensões no schema `extensions`. Projetos antigos podem
-- ter `vector` em `public`; por isso não qualificamos o tipo e colocamos
-- os dois schemas no search_path.
create extension if not exists vector with schema extensions;

set local search_path = public, extensions;

do $$
declare
  v_schema text;
  v_version text;
begin
  select n.nspname, e.extversion into v_schema, v_version
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';
  if v_schema is null then
    raise exception 'extensão vector não instalada';
  end if;
  raise notice 'pgvector % instalado no schema %', v_version, v_schema;
  if v_version < '0.8' then
    raise notice 'pgvector < 0.8: hnsw.iterative_scan indisponível (busca filtrada pode devolver menos que match_count).';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Colunas de embedding
-- ───────────────────────────────────────────────────────────────────────────
alter table public.qs_copilot_objections
  add column if not exists embedding            vector(1536),
  add column if not exists embedding_model      text not null default 'text-embedding-3-small',
  add column if not exists embedding_updated_at timestamptz,
  -- texto que foi embedado (titulo + exemplo + gatilhos). Se mudar, o
  -- embedding está desatualizado → a view de pendentes pega.
  add column if not exists embedding_source_hash text;

alter table public.qs_copilot_playbook_chunks
  add column if not exists embedding            vector(1536),
  add column if not exists embedding_model      text not null default 'text-embedding-3-small',
  add column if not exists embedding_updated_at timestamptz;

-- vector(1536) já rejeita outra dimensão no INSERT; o CHECK abaixo é
-- defesa em profundidade para o caso de alguém alterar a coluna para
-- vector sem dimensão.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'qs_copilot_objections_emb_dim_chk') then
    alter table public.qs_copilot_objections
      add constraint qs_copilot_objections_emb_dim_chk
      check (embedding is null or vector_dims(embedding) = 1536);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qs_copilot_playbook_emb_dim_chk') then
    alter table public.qs_copilot_playbook_chunks
      add constraint qs_copilot_playbook_emb_dim_chk
      check (embedding is null or vector_dims(embedding) = 1536);
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Índices HNSW
--
-- HNSW e não IVFFlat: IVFFlat precisa "treinar" as listas com dados já
-- carregados e degrada conforme a base cresce sem REINDEX. O playbook é
-- escrito continuamente pela curadoria. HNSW é incremental e tem recall
-- maior — o único aceitável no caminho de latência de uma call ao vivo.
--
-- vector_cosine_ops / operador <=>: embeddings da OpenAI vêm normalizados,
-- então cosine e inner product ordenam igual; cosine devolve distância em
-- [0,2] e `1 - distância` é a similaridade em que o similarity_threshold
-- (0.78) está calibrado. Trocar para ip/l2 quebraria o threshold.
--
-- m = 16: conexões por nó. Sustenta recall ~0.98 até milhões de vetores;
--         nossa base é de centenas (objeções) a dezenas de milhares (chunks).
--         Subir m só custa memória e tempo de build.
-- ef_construction = 64 (objeções): grafo minúsculo, build em milissegundos.
-- ef_construction = 128 (playbook): compra recall extra num build que leva
--         segundos — custo irrelevante, benefício permanente.
-- Índice PARCIAL (is_active): objeção desativada não entra no grafo →
--         busca mais rápida e zero risco de sugerir conteúdo desligado.
-- ef_search fica no RUNTIME (SET LOCAL por transação), porque o trade-off
--         é diferente por caminho: tempo real quer latência, RAG quer recall.
-- ───────────────────────────────────────────────────────────────────────────
set local maintenance_work_mem = '256MB';

create index if not exists qs_copilot_objections_emb_hnsw
  on public.qs_copilot_objections
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where is_active and embedding is not null;

create index if not exists qs_copilot_playbook_emb_hnsw
  on public.qs_copilot_playbook_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where is_active and embedding is not null;

-- backfill / re-embed
create index if not exists qs_copilot_objections_sem_emb_idx
  on public.qs_copilot_objections (updated_at) where embedding is null and is_active;
create index if not exists qs_copilot_playbook_sem_emb_idx
  on public.qs_copilot_playbook_chunks (updated_at) where embedding is null and is_active;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Hash do texto embedado — detecta objeção editada sem re-embed
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.qs_copilot_objection_embed_text(o public.qs_copilot_objections)
returns text
language sql
immutable
parallel safe
as $$
  select concat_ws(' | ', o.titulo, o.exemplo_lead, array_to_string(o.gatilhos, ' ; '))
$$;

comment on function public.qs_copilot_objection_embed_text(public.qs_copilot_objections) is
  'Texto canônico que o gateway deve embedar para uma objeção. O hash disso vai em embedding_source_hash.';

-- Fila de (re)embedding para o gateway: o que está sem vetor ou com texto alterado
create or replace view public.qs_copilot_vw_embeddings_pendentes as
select
  'objecao'::text                              as tipo,
  o.id,
  o.org_id,
  public.qs_copilot_objection_embed_text(o)    as texto,
  o.embedding is null                          as sem_embedding,
  o.embedding_source_hash is distinct from encode(sha256(convert_to(public.qs_copilot_objection_embed_text(o), 'UTF8')), 'hex')
                                               as texto_alterado
from public.qs_copilot_objections o
where o.is_active
  and ( o.embedding is null
        or o.embedding_source_hash is distinct from encode(sha256(convert_to(public.qs_copilot_objection_embed_text(o), 'UTF8')), 'hex') )
union all
select
  'chunk'::text,
  p.id,
  p.org_id,
  coalesce(p.heading, '') || E'\n' || p.content,
  true,
  false
from public.qs_copilot_playbook_chunks p
where p.is_active and p.embedding is null;

comment on view public.qs_copilot_vw_embeddings_pendentes is
  'Fila de embeddings a gerar. O gateway lê, chama o modelo, grava embedding + embedding_source_hash.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. match_objecao — busca vetorial no caminho crítico da call (L1)
--    Retorna a objeção E a resposta primária, num só round-trip.
--    Uso (gateway, dentro de uma transação):
--      set local hnsw.ef_search = 40;      -- p95 < 10 ms numa base de centenas
--      select * from match_objecao($1, 0.78, 3, $org);
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.match_objecao(
  query_embedding  vector(1536),
  match_threshold  double precision default 0.78,
  match_count      integer          default 3,
  p_org_id         uuid             default null,
  p_categorias     text[]           default null,
  p_momento        text             default null
)
returns table (
  objection_id     uuid,
  categoria        text,
  titulo           text,
  exemplo_lead     text,
  severidade       text,
  momento          text,
  response_id      uuid,
  resposta         text,
  similarity       double precision
)
language sql
stable
security invoker
parallel safe
set search_path = public, extensions, pg_temp
as $$
  select
    o.id,
    o.categoria,
    o.titulo,
    o.exemplo_lead,
    o.severidade,
    o.momento,
    r.id,
    r.texto,
    (1 - (o.embedding <=> query_embedding))::double precision
  from public.qs_copilot_objections o
  left join public.qs_copilot_objection_responses r
         on r.objection_id = o.id and r.is_primary
  where o.is_active
    and o.embedding is not null
    and o.org_id = coalesce(p_org_id, public.qs_default_org_id())
    and (p_categorias is null or o.categoria = any (p_categorias))
    and (p_momento is null or o.momento in ('qualquer', p_momento))
    and (1 - (o.embedding <=> query_embedding)) >= match_threshold
  order by o.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 3), 1)
$$;

comment on function public.match_objecao(vector, double precision, integer, uuid, text[], text) is
  'L1: busca cosine nas objeções ativas da org. similarity = 1 - distância. Antes: SET LOCAL hnsw.ef_search = 40.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. match_objecao_hibrido — vetorial + léxico com Reciprocal Rank Fusion
--    Pega o que o embedding perde: gíria, nome de concorrente, número.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.match_objecao_hibrido(
  query_embedding vector(1536),
  query_text      text,
  match_threshold double precision default 0.72,
  match_count     integer          default 3,
  p_org_id        uuid             default null,
  rrf_k           integer          default 60
)
returns table (
  objection_id uuid,
  categoria    text,
  titulo       text,
  response_id  uuid,
  resposta     text,
  similarity   double precision,
  rrf_score    double precision
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with org as (
    select coalesce(p_org_id, public.qs_default_org_id()) as id
  ),
  vec as (
    select o.id,
           (1 - (o.embedding <=> query_embedding))::double precision as sim,
           row_number() over (order by o.embedding <=> query_embedding) as rnk
    from public.qs_copilot_objections o, org
    where o.is_active and o.embedding is not null and o.org_id = org.id
    order by o.embedding <=> query_embedding
    limit 30
  ),
  lex as (
    select o.id,
           row_number() over (
             order by ts_rank_cd(o.busca_tsv, websearch_to_tsquery('portuguese', query_text)) desc
           ) as rnk
    from public.qs_copilot_objections o, org
    where o.is_active and o.org_id = org.id
      and o.busca_tsv @@ websearch_to_tsquery('portuguese', query_text)
    limit 30
  ),
  fused as (
    select coalesce(v.id, l.id) as oid,
           coalesce(v.sim, 0)   as sim,
           coalesce(1.0 / (rrf_k + v.rnk), 0) + coalesce(1.0 / (rrf_k + l.rnk), 0) as score
    from vec v full outer join lex l on l.id = v.id
  )
  select o.id, o.categoria, o.titulo, r.id, r.texto, f.sim, f.score
  from fused f
  join public.qs_copilot_objections o on o.id = f.oid
  left join public.qs_copilot_objection_responses r on r.objection_id = o.id and r.is_primary
  where f.sim >= match_threshold or f.sim = 0     -- sim = 0 → veio só do léxico
  order by f.score desc
  limit greatest(coalesce(match_count, 3), 1)
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. match_playbook — RAG sobre chunks (contexto para o L3 / resumo)
--    Uso: set local hnsw.ef_search = 100;  (aqui queremos recall)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.match_playbook(
  query_embedding vector(1536),
  match_threshold double precision default 0.70,
  match_count     integer          default 5,
  p_org_id        uuid             default null,
  p_doc_tipo      text             default null,
  p_destino       text             default null,
  p_tags          text[]           default null
)
returns table (
  chunk_id   uuid,
  doc_id     uuid,
  doc_titulo text,
  doc_tipo   text,
  heading    text,
  content    text,
  similarity double precision
)
language sql
stable
security invoker
parallel safe
set search_path = public, extensions, pg_temp
as $$
  select p.id, p.doc_id, p.doc_titulo, p.doc_tipo, p.heading, p.content,
         (1 - (p.embedding <=> query_embedding))::double precision
  from public.qs_copilot_playbook_chunks p
  where p.is_active
    and p.embedding is not null
    and p.org_id = coalesce(p_org_id, public.qs_default_org_id())
    and (p_doc_tipo is null or p.doc_tipo = p_doc_tipo)
    and (p_destino  is null or p.destino ilike p_destino)
    and (p_tags     is null or p.tags && p_tags)
    and (1 - (p.embedding <=> query_embedding)) >= match_threshold
  order by p.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 5), 1)
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Notas de runtime (não são SQL executável — ficam aqui para não se perder)
--   · pgvector >= 0.8 com filtro seletivo (categoria/momento/org):
--       set local hnsw.iterative_scan = 'relaxed_order';
--       set local hnsw.max_scan_tuples = 20000;
--     Sem isso, o filtro pós-índice pode devolver MENOS linhas que match_count.
--   · Calibração do threshold: 0.78 é conservador para frases curtas em
--     português. Meça com o seed + 50 frases reais de call e ajuste em
--     qs_copilot_settings.similarity_threshold (sem migration).
-- ───────────────────────────────────────────────────────────────────────────

commit;

-- ROLLBACK:
--   drop function if exists public.match_playbook(vector,double precision,integer,uuid,text,text,text[]);
--   drop function if exists public.match_objecao_hibrido(vector,text,double precision,integer,uuid,integer);
--   drop function if exists public.match_objecao(vector,double precision,integer,uuid,text[],text);
--   drop view if exists public.qs_copilot_vw_embeddings_pendentes;
--   drop function if exists public.qs_copilot_objection_embed_text(public.qs_copilot_objections);
--   alter table public.qs_copilot_objections drop column if exists embedding, drop column if exists embedding_model,
--     drop column if exists embedding_updated_at, drop column if exists embedding_source_hash;
--   alter table public.qs_copilot_playbook_chunks drop column if exists embedding, drop column if exists embedding_model,
--     drop column if exists embedding_updated_at;
--   (a extensão vector pode ficar; outros módulos podem usá-la)
