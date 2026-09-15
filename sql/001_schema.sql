-- ═══════════════════════════════════════════════════════════════════════════
-- 001_schema.sql — Copiloto QS · tabelas qs_copilot_*
-- Projeto  : Supabase SEU_PROJECT_ID (sa-east-1) · Postgres 17.6
-- Frente   : A — Banco e fundação
-- Idempotente: sim (IF NOT EXISTS / ON CONFLICT / CREATE OR REPLACE)
--
-- Convenções (herdadas do legado qs_*, verificadas em types.ts e queries.ts):
--   · PK uuid gen_random_uuid()            (pgcrypto já vem no Supabase)
--   · Enum = TEXT + CHECK, nunca CREATE TYPE (o legado é TEXT solto)
--   · Soft delete por flag is_active
--   · updated_at por trigger (o legado seta na mão; aqui não dependemos disso)
--   · Toda tabela tem org_id desde o dia 1 (multi-tenant sem retrofit)
--
-- Este arquivo NÃO depende de pgvector. As colunas `embedding` são
-- adicionadas em 002_pgvector.sql, para que a extensão possa ser tratada
-- de forma isolada (habilitar, justificar dimensão, indexar).
--
-- Origem do desenho: server/src/sessoes.js (formato JSON do protótipo)
--   Sessao.turnos     → qs_copilot_transcript_turns
--   Sessao.deteccoes  → qs_copilot_detections
--   Sessao.resumo     → qs_copilot_summaries
--   Sessao.custo      → qs_copilot_calls.{stt_cost_usd, llm_cost_usd, total_cost_brl}
-- ═══════════════════════════════════════════════════════════════════════════

begin;

set local search_path = public, extensions;

-- ───────────────────────────────────────────────────────────────────────────
-- 0. Pré-checagem: as tabelas legadas que referenciamos precisam existir.
--    Se alguma faltar, a migration aborta AQUI, com mensagem clara,
--    em vez de falhar no meio com erro de FK.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['qs_users','qs_leads','qs_meetings','qs_tasks','qs_notes','qs_handovers','qs_loss_reasons']
  loop
    if to_regclass('public.' || t) is null then
      raise exception 'Tabela legada public.% não existe. Restaure o projeto/aplique o schema do QS antes.', t;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Funções utilitárias
-- ───────────────────────────────────────────────────────────────────────────

-- Org padrão (Grupo Inovvatur). UUID fixo e estável: aparece em defaults de
-- coluna, seeds e no gateway. Quando o produto virar multi-tenant, cada
-- cliente ganha um uuid próprio em qs_copilot_orgs; nada precisa mudar aqui.
create or replace function public.qs_default_org_id()
returns uuid
language sql
immutable
parallel safe
as $$
  select 'a0000000-0000-4000-8000-000000000001'::uuid
$$;

comment on function public.qs_default_org_id() is
  'UUID fixo da org padrão (Grupo Inovvatur). Usado como default de org_id em todas as tabelas qs_copilot_*.';

-- Trigger genérico de updated_at
create or replace function public.qs_copilot_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Organizações e membros (multi-tenant desde o dia 1)
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_orgs (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  nome        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_qs_copilot_orgs_touch on public.qs_copilot_orgs;
create trigger trg_qs_copilot_orgs_touch
  before update on public.qs_copilot_orgs
  for each row execute function public.qs_copilot_touch_updated_at();

insert into public.qs_copilot_orgs (id, slug, nome)
values (public.qs_default_org_id(), 'inovvatur', 'Grupo Inovvatur')
on conflict (id) do nothing;

-- Membros: liga qs_users a uma org. Hoje todo mundo é da org padrão.
-- Não alteramos qs_users (legado) — a relação vive aqui.
create table if not exists public.qs_copilot_org_members (
  org_id      uuid not null references public.qs_copilot_orgs(id) on delete cascade,
  user_id     uuid not null references public.qs_users(id)        on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index if not exists qs_copilot_org_members_user_idx
  on public.qs_copilot_org_members (user_id);

-- Backfill: todos os usuários existentes entram na org padrão.
insert into public.qs_copilot_org_members (org_id, user_id)
select public.qs_default_org_id(), u.id
from public.qs_users u
on conflict do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. qs_copilot_calls — a sessão da call (1 linha por call)
--    ← Sessao {id, iniciadaEm, encerradaEm, duracaoMs, leadNome, closerNome, custo}
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_calls (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.qs_default_org_id()
                        references public.qs_copilot_orgs(id) on delete restrict,

  -- vínculo com o QS (Q-1). lead_id pode ser NULL numa call de teste/treino.
  lead_id               uuid references public.qs_leads(id)    on delete set null,
  meeting_id            uuid references public.qs_meetings(id) on delete set null,
  closer_id             uuid not null references public.qs_users(id) on delete restrict,

  -- snapshot do que o protótipo guardava como texto (útil quando não há lead vinculado)
  lead_nome_snapshot    text,

  -- origem / plataforma
  platform              text not null default 'google_meet'
                        check (platform in ('google_meet','zoom','teams','whatsapp','telefone','presencial','outro')),
  meeting_url           text,

  -- pipeline de transcrição. Descoberta do spike: nova-3 + language=multi
  -- (pt-BR explícito NÃO funciona no Deepgram). Guardamos por call para
  -- auditoria quando o modelo mudar.
  stt_provider          text not null default 'deepgram',
  stt_model             text not null default 'nova-3',
  stt_language          text not null default 'multi',
  stt_request_id        text,                          -- id da sessão no provedor (reconexão/auditoria)

  -- ciclo de vida
  status                text not null default 'aguardando'
                        check (status in ('aguardando','gravando','pausada','processando','concluida','erro','descartada')),
  started_at            timestamptz,
  ended_at              timestamptz,
  duration_seconds      integer check (duration_seconds >= 0),   -- calculado por trigger

  -- consentimento LGPD com prova (P-2 / critério 6)
  -- consent_proof exemplos:
  --   {"tipo":"verbal","turn_id":123,"offset_ms":18400,"trecho":"pode gravar sim"}
  --   {"tipo":"checkbox_extensao","versao_termo":"2026-09","ip":"...","user_agent":"..."}
  --   {"tipo":"termo_previo","documento":"contrato-123.pdf","assinado_em":"2026-09-01"}
  consent_status        text not null default 'pendente'
                        check (consent_status in ('pendente','concedido','recusado','nao_aplicavel')),
  consent_method        text
                        check (consent_method is null or consent_method in ('verbal_gravado','checkbox_extensao','termo_previo','whatsapp','email')),
  consent_at            timestamptz,
  consent_by            uuid references public.qs_users(id) on delete set null,
  consent_proof         jsonb not null default '{}'::jsonb,

  -- custo (P-6 / critério 10). ← Sessao.custo {sttUsd, iaUsd, totalBrl}
  stt_cost_usd          numeric(10,4) not null default 0 check (stt_cost_usd >= 0),
  llm_cost_usd          numeric(10,4) not null default 0 check (llm_cost_usd >= 0),
  fx_rate_brl           numeric(8,4)  not null default 5.4000 check (fx_rate_brl > 0),  -- dólar usado no fechamento
  total_cost_brl        numeric(12,4) generated always as ((stt_cost_usd + llm_cost_usd) * fx_rate_brl) stored,

  -- observabilidade
  gateway_version       text,
  extension_version     text,
  error_message         text,
  metadata              jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint qs_copilot_calls_periodo_chk
    check (ended_at is null or started_at is null or ended_at >= started_at),
  constraint qs_copilot_calls_consent_chk
    check (consent_status <> 'concedido' or (consent_at is not null and consent_method is not null)),
  constraint qs_copilot_calls_consent_proof_obj_chk
    check (jsonb_typeof(consent_proof) = 'object'),
  constraint qs_copilot_calls_metadata_obj_chk
    check (jsonb_typeof(metadata) = 'object')
);

-- updated_at + duração calculada
create or replace function public.qs_copilot_calls_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.started_at is not null and new.ended_at is not null then
    new.duration_seconds := greatest(0, floor(extract(epoch from (new.ended_at - new.started_at)))::integer);
  end if;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_calls_touch on public.qs_copilot_calls;
create trigger trg_qs_copilot_calls_touch
  before insert or update on public.qs_copilot_calls
  for each row execute function public.qs_copilot_calls_touch();

create index if not exists qs_copilot_calls_closer_idx
  on public.qs_copilot_calls (org_id, closer_id, started_at desc nulls last);
create index if not exists qs_copilot_calls_lead_idx
  on public.qs_copilot_calls (lead_id, started_at desc) where lead_id is not null;
create index if not exists qs_copilot_calls_meeting_idx
  on public.qs_copilot_calls (meeting_id) where meeting_id is not null;
create index if not exists qs_copilot_calls_ativas_idx
  on public.qs_copilot_calls (org_id, status, started_at desc)
  where status in ('aguardando','gravando','pausada','processando');
create index if not exists qs_copilot_calls_periodo_idx
  on public.qs_copilot_calls (org_id, started_at) where started_at is not null;

comment on table  public.qs_copilot_calls is 'Sessão de uma call de fechamento com o copiloto. 1 linha por call.';
comment on column public.qs_copilot_calls.consent_proof is 'Prova do consentimento LGPD (trecho transcrito, checkbox, termo). Sempre um objeto JSON.';
comment on column public.qs_copilot_calls.total_cost_brl is 'Coluna gerada: (stt + llm) * câmbio. Espelha Sessao.custo.totalBrl do protótipo.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. qs_copilot_transcript_turns — turnos de transcrição (tabela mais quente)
--    ← Sessao.turnos [{falante, texto, emMs}]
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_transcript_turns (
  id            bigint generated always as identity primary key,
  org_id        uuid not null default public.qs_default_org_id(),
  call_id       uuid not null references public.qs_copilot_calls(id) on delete cascade,
  closer_id     uuid not null,                       -- DENORMALIZADO p/ RLS sem join (trigger preenche)

  seq           integer not null check (seq >= 0),
  speaker       text not null check (speaker in ('lead','closer','sistema')),
  channel       smallint check (channel in (0,1)),   -- 0 = aba (lead) · 1 = microfone (closer). Diarização por canal, sem IA.
  content       text not null check (length(content) between 1 and 8000),

  offset_ms     integer not null check (offset_ms >= 0),           -- ← emMs
  end_offset_ms integer check (end_offset_ms is null or end_offset_ms >= offset_ms),
  confidence    real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  is_final      boolean not null default true,       -- Deepgram só marca is_final após silêncio/CloseStream
  words         jsonb,                               -- timings palavra a palavra: OPT-IN, engorda ~6x

  created_at    timestamptz not null default now(),

  content_tsv   tsvector generated always as (to_tsvector('portuguese', content)) stored,

  constraint qs_copilot_turns_seq_uq unique (call_id, seq)
);

-- Preenche org_id/closer_id a partir da call (o gateway manda só call_id)
create or replace function public.qs_copilot_fill_from_call()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_closer uuid;
begin
  select c.org_id, c.closer_id into v_org, v_closer
  from public.qs_copilot_calls c where c.id = new.call_id;

  if v_closer is null then
    raise exception 'call_id % não existe em qs_copilot_calls', new.call_id;
  end if;

  new.org_id    := v_org;      -- org SEMPRE vem da call (nunca do cliente)
  new.closer_id := v_closer;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_turns_fill on public.qs_copilot_transcript_turns;
create trigger trg_qs_copilot_turns_fill
  before insert on public.qs_copilot_transcript_turns
  for each row execute function public.qs_copilot_fill_from_call();

create index if not exists qs_copilot_turns_call_idx
  on public.qs_copilot_transcript_turns (call_id, offset_ms);
-- caminho crítico do copiloto: só falas finais do LEAD
create index if not exists qs_copilot_turns_lead_final_idx
  on public.qs_copilot_transcript_turns (call_id, offset_ms)
  where speaker = 'lead' and is_final;
create index if not exists qs_copilot_turns_closer_idx
  on public.qs_copilot_transcript_turns (closer_id, created_at desc);
create index if not exists qs_copilot_turns_tsv_idx
  on public.qs_copilot_transcript_turns using gin (content_tsv);
-- BRIN: purge por data com índice minúsculo
create index if not exists qs_copilot_turns_created_brin
  on public.qs_copilot_transcript_turns using brin (created_at) with (pages_per_range = 64);

comment on table public.qs_copilot_transcript_turns is 'Turnos de fala transcritos. Interim (is_final=false) deve ir por Realtime Broadcast e NÃO ser persistido em produção.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. qs_copilot_objections — playbook: a objeção (I-2: playbook como dado)
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_objections (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.qs_default_org_id()
                references public.qs_copilot_orgs(id) on delete restrict,

  categoria     text not null check (categoria in (
                  'preco','concorrente','decisor','procrastinacao','timing','parcelamento',
                  'confianca','cancelamento_seguro','seguranca_destino','documentacao',
                  'cambio','pesquisando','sinal_compra','outro')),
  titulo        text not null check (length(titulo) between 3 and 120),
  exemplo_lead  text,                                   -- como o lead fala, literalmente
  gatilhos      text[] not null default '{}',           -- L0: match léxico instantâneo (ex-gatilhos.js)

  severidade    text not null default 'media' check (severidade in ('baixa','media','alta')),
  momento       text not null default 'qualquer'
                check (momento in ('abertura','diagnostico','apresentacao','proposta','fechamento','pos_proposta','qualquer')),
  produto_id    uuid,                                   -- FK opcional para qs_products (ver DO abaixo)

  fonte         text not null default 'curadoria' check (fonte in ('curadoria','call_real','mentoria','importacao','ia')),
  uso_total     integer not null default 0 check (uso_total >= 0),
  is_active     boolean not null default true,

  created_by    uuid references public.qs_users(id) on delete set null,
  updated_by    uuid references public.qs_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  busca_tsv     tsvector generated always as (
                  to_tsvector('portuguese',
                    coalesce(titulo,'') || ' ' || coalesce(exemplo_lead,'') || ' ' || array_to_string(gatilhos,' '))
                ) stored,

  constraint qs_copilot_objections_titulo_uq unique (org_id, titulo),
  constraint qs_copilot_objections_gatilhos_chk check (cardinality(gatilhos) <= 20)
);

drop trigger if exists trg_qs_copilot_objections_touch on public.qs_copilot_objections;
create trigger trg_qs_copilot_objections_touch
  before update on public.qs_copilot_objections
  for each row execute function public.qs_copilot_touch_updated_at();

-- FK para qs_products só se a tabela existir com id uuid (schema não inspecionável: projeto pausado)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'qs_products'
      and column_name = 'id' and data_type = 'uuid'
  ) and not exists (
    select 1 from pg_constraint where conname = 'qs_copilot_objections_produto_fk'
  ) then
    alter table public.qs_copilot_objections
      add constraint qs_copilot_objections_produto_fk
      foreign key (produto_id) references public.qs_products(id) on delete set null;
    raise notice 'FK qs_copilot_objections.produto_id -> qs_products criada';
  else
    raise notice 'FK produto_id NÃO criada (qs_products.id ausente ou não-uuid). Coluna fica solta.';
  end if;
end $$;

create index if not exists qs_copilot_objections_cat_idx
  on public.qs_copilot_objections (org_id, categoria) where is_active;
create index if not exists qs_copilot_objections_tsv_idx
  on public.qs_copilot_objections using gin (busca_tsv);
create index if not exists qs_copilot_objections_gatilhos_idx
  on public.qs_copilot_objections using gin (gatilhos);

comment on table  public.qs_copilot_objections is 'Playbook: objeções catalogadas. Editável pelo gestor sem deploy (critério 3).';
comment on column public.qs_copilot_objections.gatilhos is 'Frases literais para a camada L0 (regex/ILIKE). Fallback quando o embedding não está pronto.';

-- ───────────────────────────────────────────────────────────────────────────
-- 6. qs_copilot_objection_responses — respostas VERSIONADAS por objeção
--    Regra: exatamente uma resposta is_primary por objeção; texto curto e
--    falável (≤ 25 palavras — o seed usa ≤ 20). Histórico nunca é apagado:
--    versão nova aponta para a anterior em substitui_id.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_objection_responses (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.qs_default_org_id()
                references public.qs_copilot_orgs(id) on delete restrict,
  objection_id  uuid not null references public.qs_copilot_objections(id) on delete cascade,

  versao        integer not null check (versao >= 1),   -- trigger preenche max+1 se vier NULL
  texto         text not null check (length(texto) between 5 and 220),
  contexto_uso  text,                                    -- quando usar esta variação (ex.: "lead já comparou com OTA")
  tom           text check (tom is null or tom in ('consultivo','direto','empatico','urgencia')),

  status        text not null default 'aprovada' check (status in ('rascunho','aprovada','arquivada')),
  is_primary    boolean not null default false,          -- a que vai para o card do closer
  substitui_id  uuid references public.qs_copilot_objection_responses(id) on delete set null,

  autor_id      uuid references public.qs_users(id) on delete set null,
  aprovado_por  uuid references public.qs_users(id) on delete set null,
  aprovado_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint qs_copilot_responses_versao_uq unique (objection_id, versao),
  -- falável em voz alta: no máximo 25 palavras
  constraint qs_copilot_responses_curta_chk
    check (array_length(regexp_split_to_array(btrim(texto), '\s+'), 1) <= 25),
  -- só resposta aprovada pode ser primária
  constraint qs_copilot_responses_primary_aprovada_chk
    check (not is_primary or status = 'aprovada')
);

-- exatamente UMA primária por objeção
create unique index if not exists qs_copilot_responses_primary_uq
  on public.qs_copilot_objection_responses (objection_id) where is_primary;

create index if not exists qs_copilot_responses_obj_idx
  on public.qs_copilot_objection_responses (objection_id, versao desc);

-- versão automática + org herdada da objeção
create or replace function public.qs_copilot_responses_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select o.org_id into new.org_id from public.qs_copilot_objections o where o.id = new.objection_id;
  if new.org_id is null then
    raise exception 'objection_id % não existe', new.objection_id;
  end if;
  if new.versao is null then
    select coalesce(max(r.versao), 0) + 1 into new.versao
    from public.qs_copilot_objection_responses r where r.objection_id = new.objection_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_responses_bi on public.qs_copilot_objection_responses;
create trigger trg_qs_copilot_responses_bi
  before insert on public.qs_copilot_objection_responses
  for each row execute function public.qs_copilot_responses_before_insert();

-- promover uma resposta a primária rebaixa a anterior (sem violar o índice único)
create or replace function public.qs_copilot_responses_promote()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.qs_copilot_objection_responses r
     set is_primary = false, updated_at = now()
   where r.objection_id = new.objection_id
     and r.id <> new.id
     and r.is_primary;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_responses_promote on public.qs_copilot_objection_responses;
create trigger trg_qs_copilot_responses_promote
  before insert or update of is_primary on public.qs_copilot_objection_responses
  for each row when (new.is_primary) execute function public.qs_copilot_responses_promote();

drop trigger if exists trg_qs_copilot_responses_touch on public.qs_copilot_objection_responses;
create trigger trg_qs_copilot_responses_touch
  before update on public.qs_copilot_objection_responses
  for each row execute function public.qs_copilot_touch_updated_at();

comment on table public.qs_copilot_objection_responses is 'Respostas versionadas do playbook. Uma is_primary por objeção; histórico preservado via substitui_id.';

-- ───────────────────────────────────────────────────────────────────────────
-- 7. qs_copilot_detections — cada vez que o copiloto detectou algo na call
--    ← Sessao.deteccoes [{categoria, resposta, fonte, emMs, latenciaMs, temperatura}]
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_detections (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.qs_default_org_id(),
  call_id           uuid not null references public.qs_copilot_calls(id) on delete cascade,
  closer_id         uuid not null,                                      -- DENORMALIZADO (trigger)
  turn_id           bigint references public.qs_copilot_transcript_turns(id) on delete set null,

  objection_id      uuid references public.qs_copilot_objections(id)          on delete set null,
  response_id       uuid references public.qs_copilot_objection_responses(id) on delete set null,
  categoria         text not null,                                      -- do playbook, ou rótulo livre da IA

  trecho            text not null check (length(trecho) between 1 and 4000),   -- o que o lead disse
  detected_at_ms    integer not null check (detected_at_ms >= 0),               -- ← emMs

  fonte             text not null check (fonte in ('gatilho','vetor','ia','hibrido')),  -- L0 / L1 / L2-L3
  similarity        real check (similarity is null or (similarity >= -1 and similarity <= 1)),
  temperatura       text check (temperatura is null or temperatura in ('frio','morno','quente')),

  sugestao_exibida  text,                       -- snapshot do texto no card (a resposta pode ser reeditada depois)
  shown_at          timestamptz,
  latency_ms        integer check (latency_ms is null or latency_ms >= 0),   -- fala do lead → card na tela

  -- feedback consolidado (fonte da verdade fica em qs_copilot_feedback)
  closer_usou       boolean,                    -- NULL = sem feedback
  feedback_at       timestamptz,

  llm_model         text,
  tokens_in         integer,
  tokens_out        integer,
  custo_usd         numeric(10,6) not null default 0 check (custo_usd >= 0),

  created_at        timestamptz not null default now()
);

create or replace function public.qs_copilot_detections_fill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_closer uuid;
begin
  select c.org_id, c.closer_id into v_org, v_closer
  from public.qs_copilot_calls c where c.id = new.call_id;
  if v_closer is null then
    raise exception 'call_id % não existe em qs_copilot_calls', new.call_id;
  end if;
  new.org_id    := v_org;
  new.closer_id := v_closer;

  -- categoria herdada do playbook quando houver match
  if new.objection_id is not null then
    select o.categoria into new.categoria
    from public.qs_copilot_objections o where o.id = new.objection_id;
  end if;
  if new.categoria is null then
    new.categoria := 'outro';
  end if;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_detections_fill on public.qs_copilot_detections;
create trigger trg_qs_copilot_detections_fill
  before insert on public.qs_copilot_detections
  for each row execute function public.qs_copilot_detections_fill();

create index if not exists qs_copilot_detections_call_idx
  on public.qs_copilot_detections (call_id, detected_at_ms);
create index if not exists qs_copilot_detections_closer_idx
  on public.qs_copilot_detections (org_id, closer_id, created_at desc);
create index if not exists qs_copilot_detections_cat_idx
  on public.qs_copilot_detections (org_id, categoria, created_at desc);
create index if not exists qs_copilot_detections_obj_idx
  on public.qs_copilot_detections (objection_id, created_at desc) where objection_id is not null;
-- covering: taxa de uso e latência sem tocar o heap
create index if not exists qs_copilot_detections_uso_idx
  on public.qs_copilot_detections (org_id, created_at desc)
  include (closer_id, categoria, fonte, closer_usou, latency_ms, similarity);

comment on table public.qs_copilot_detections is 'Detecções por call (objeção, sinal de compra, temperatura). É o ativo analítico do produto: nunca expurgar.';

-- ───────────────────────────────────────────────────────────────────────────
-- 8. qs_copilot_feedback — o closer marca "usei" / "não serviu" (I-6)
--    Uma linha por detecção (upsert). Trigger consolida em detections e
--    atualiza uso_total da objeção.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_feedback (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.qs_default_org_id(),
  detection_id  uuid not null unique references public.qs_copilot_detections(id) on delete cascade,
  call_id       uuid not null references public.qs_copilot_calls(id) on delete cascade,
  closer_id     uuid not null,                        -- DENORMALIZADO (trigger)

  resultado     text not null check (resultado in ('usei','nao_serviu','ignorei')),
  motivo        text check (motivo is null or motivo in (
                  'resposta_errada','fora_de_contexto','chegou_tarde','ja_sabia',
                  'lead_nao_disse_isso','texto_ruim','outro')),
  comentario    text check (comentario is null or length(comentario) <= 1000),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- "não serviu" precisa dizer por quê (é o que alimenta a curadoria)
  constraint qs_copilot_feedback_motivo_chk
    check (resultado <> 'nao_serviu' or motivo is not null)
);

create or replace function public.qs_copilot_feedback_fill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select d.org_id, d.call_id, d.closer_id into new.org_id, new.call_id, new.closer_id
  from public.qs_copilot_detections d where d.id = new.detection_id;
  if new.closer_id is null then
    raise exception 'detection_id % não existe', new.detection_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_feedback_fill on public.qs_copilot_feedback;
create trigger trg_qs_copilot_feedback_fill
  before insert on public.qs_copilot_feedback
  for each row execute function public.qs_copilot_feedback_fill();

-- consolida na detecção + contador de uso na objeção
create or replace function public.qs_copilot_feedback_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_obj uuid;
  v_delta integer := 0;
  v_prev text;                       -- resultado anterior (NULL em INSERT)
begin
  if tg_op = 'UPDATE' then
    v_prev := old.resultado;
  end if;

  update public.qs_copilot_detections d
     set closer_usou = (new.resultado = 'usei'),
         feedback_at = now()
   where d.id = new.detection_id
   returning d.objection_id into v_obj;

  if v_obj is not null then
    if new.resultado = 'usei' and v_prev is distinct from 'usei' then
      v_delta := 1;
    elsif v_prev = 'usei' and new.resultado <> 'usei' then
      v_delta := -1;
    end if;
    if v_delta <> 0 then
      update public.qs_copilot_objections
         set uso_total = greatest(0, uso_total + v_delta)
       where id = v_obj;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_feedback_apply on public.qs_copilot_feedback;
create trigger trg_qs_copilot_feedback_apply
  after insert or update of resultado on public.qs_copilot_feedback
  for each row execute function public.qs_copilot_feedback_apply();

drop trigger if exists trg_qs_copilot_feedback_touch on public.qs_copilot_feedback;
create trigger trg_qs_copilot_feedback_touch
  before update on public.qs_copilot_feedback
  for each row execute function public.qs_copilot_touch_updated_at();

create index if not exists qs_copilot_feedback_closer_idx
  on public.qs_copilot_feedback (org_id, closer_id, created_at desc);
create index if not exists qs_copilot_feedback_call_idx
  on public.qs_copilot_feedback (call_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 9. qs_copilot_summaries — resumo pós-call (1 por call)
--    ← Sessao.resumo · alimenta qs_notes (Q-4) e qs_tasks (Q-3)
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_summaries (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.qs_default_org_id(),
  call_id               uuid not null unique references public.qs_copilot_calls(id) on delete cascade,
  closer_id             uuid not null,                       -- DENORMALIZADO (trigger)
  lead_id               uuid references public.qs_leads(id) on delete set null,   -- DENORMALIZADO (trigger)

  resumo                text not null check (length(resumo) between 1 and 6000),
  perfil_lead           text,                                -- quem é, com quem viaja, o que valoriza
  temperatura           text not null check (temperatura in ('quente','morno','frio')),
  temperatura_score     smallint check (temperatura_score is null or temperatura_score between 0 and 100),

  proximo_passo         text,
  proximo_passo_prazo   date,
  proximo_passo_task_id uuid references public.qs_tasks(id) on delete set null,   -- Q-3: tarefa criada no QS
  nota_id               uuid references public.qs_notes(id) on delete set null,   -- Q-4: nota criada no lead

  o_que_funcionou       text[] not null default '{}',
  o_que_melhorar        text[] not null default '{}',
  objecoes              jsonb not null default '[]'::jsonb,
  -- [{"categoria":"preco","objection_id":"uuid|null","ocorrencias":2,"superada":true}]

  -- dados comerciais extraídos da conversa
  destino_mencionado    text,
  orcamento_mencionado  numeric(12,2),
  janela_viagem         text,
  pax_mencionado        smallint,

  -- métricas de conversa
  talk_ratio_closer     numeric(5,2) check (talk_ratio_closer is null or talk_ratio_closer between 0 and 100),
  perguntas_closer      smallint,

  llm_model             text,
  tokens_in             integer,
  tokens_out            integer,
  custo_usd             numeric(10,6) not null default 0 check (custo_usd >= 0),

  revisado_por          uuid references public.qs_users(id) on delete set null,
  revisado_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint qs_copilot_summaries_objecoes_arr_chk check (jsonb_typeof(objecoes) = 'array')
);

create or replace function public.qs_copilot_summaries_fill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select c.org_id, c.closer_id, c.lead_id into new.org_id, new.closer_id, new.lead_id
  from public.qs_copilot_calls c where c.id = new.call_id;
  if new.closer_id is null then
    raise exception 'call_id % não existe em qs_copilot_calls', new.call_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_summaries_fill on public.qs_copilot_summaries;
create trigger trg_qs_copilot_summaries_fill
  before insert on public.qs_copilot_summaries
  for each row execute function public.qs_copilot_summaries_fill();

drop trigger if exists trg_qs_copilot_summaries_touch on public.qs_copilot_summaries;
create trigger trg_qs_copilot_summaries_touch
  before update on public.qs_copilot_summaries
  for each row execute function public.qs_copilot_touch_updated_at();

create index if not exists qs_copilot_summaries_closer_idx
  on public.qs_copilot_summaries (org_id, closer_id, created_at desc);
create index if not exists qs_copilot_summaries_lead_idx
  on public.qs_copilot_summaries (lead_id) where lead_id is not null;
create index if not exists qs_copilot_summaries_temp_idx
  on public.qs_copilot_summaries (org_id, temperatura, created_at desc);
create index if not exists qs_copilot_summaries_followup_idx
  on public.qs_copilot_summaries (proximo_passo_prazo) where proximo_passo_prazo is not null;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. qs_copilot_playbook_chunks — RAG (scripts, roteiros, políticas, FAQs)
--     embedding é adicionado em 002_pgvector.sql
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_playbook_chunks (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.qs_default_org_id()
                   references public.qs_copilot_orgs(id) on delete restrict,

  doc_id           uuid not null,                     -- agrupa chunks do mesmo documento
  doc_titulo       text not null,
  doc_tipo         text not null default 'playbook'
                   check (doc_tipo in ('script','playbook','faq','estudo_de_caso','politica','destino','proposta_modelo','transcricao_modelo')),
  chunk_index      integer not null check (chunk_index >= 0),
  heading          text,
  content          text not null check (length(content) between 1 and 12000),
  token_count      integer,
  produto_id       uuid,
  destino          text,                              -- "Tailândia", "Porto Rico"… filtro barato antes do vetor
  tags             text[] not null default '{}',

  source_url       text,
  checksum         text not null,                     -- sha256(content) → ingestão idempotente
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  content_tsv      tsvector generated always as
                   (to_tsvector('portuguese', coalesce(heading,'') || ' ' || content)) stored,

  constraint qs_copilot_playbook_chunk_uq    unique (doc_id, chunk_index),
  constraint qs_copilot_playbook_checksum_uq unique (org_id, checksum)
);

drop trigger if exists trg_qs_copilot_playbook_touch on public.qs_copilot_playbook_chunks;
create trigger trg_qs_copilot_playbook_touch
  before update on public.qs_copilot_playbook_chunks
  for each row execute function public.qs_copilot_touch_updated_at();

create index if not exists qs_copilot_playbook_doc_idx
  on public.qs_copilot_playbook_chunks (doc_id, chunk_index);
create index if not exists qs_copilot_playbook_org_tipo_idx
  on public.qs_copilot_playbook_chunks (org_id, doc_tipo) where is_active;
create index if not exists qs_copilot_playbook_tags_idx
  on public.qs_copilot_playbook_chunks using gin (tags);
create index if not exists qs_copilot_playbook_tsv_idx
  on public.qs_copilot_playbook_chunks using gin (content_tsv);

-- ───────────────────────────────────────────────────────────────────────────
-- 11. qs_copilot_settings — configuração por org (global) / time / usuário
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.qs_copilot_settings (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.qs_default_org_id()
                            references public.qs_copilot_orgs(id) on delete cascade,
  scope                     text not null check (scope in ('global','time','usuario')),
  user_id                   uuid references public.qs_users(id) on delete cascade,
  team                      text,

  enabled                   boolean not null default true,
  auto_summary              boolean not null default true,
  auto_create_task          boolean not null default true,    -- Q-3
  auto_create_note          boolean not null default true,    -- Q-4
  store_audio               boolean not null default false,   -- default: NÃO guardar áudio
  require_consent           boolean not null default true,    -- bloqueia sugestões até consent_status = concedido

  -- motor de detecção
  similarity_threshold      real not null default 0.78 check (similarity_threshold between 0 and 1),
  max_sugestoes             smallint not null default 3 check (max_sugestoes between 1 and 10),
  cooldown_seconds          smallint not null default 20 check (cooldown_seconds >= 0),
  min_palavras_gatilho      smallint not null default 3 check (min_palavras_gatilho >= 1),
  janela_contexto_turnos    smallint not null default 8 check (janela_contexto_turnos between 1 and 50),
  categorias_ativas         text[] not null default
                            '{preco,concorrente,decisor,procrastinacao,timing,parcelamento,confianca,cancelamento_seguro,seguranca_destino,documentacao,cambio,pesquisando,sinal_compra}',
  usar_ia_generativa        boolean not null default true,    -- L2/L3 ligadas (fallback quando não há match)

  -- modelos (nomes como texto: trocar sem migration)
  embedding_model           text not null default 'text-embedding-3-small',
  llm_model_rapido          text not null default 'claude-haiku-4-5-20251001',
  llm_model_resumo          text not null default 'claude-haiku-4-5-20251001',
  stt_model                 text not null default 'nova-3',
  stt_language              text not null default 'multi',

  -- custo (P-6)
  custo_max_call_brl        numeric(8,2) not null default 5.00 check (custo_max_call_brl > 0),
  custo_max_mes_brl         numeric(10,2),

  -- retenção (P-3) — a rotina de expurgo lê daqui
  retencao_audio_dias       smallint not null default 90,
  retencao_transcricao_dias smallint not null default 365,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint qs_copilot_settings_scope_chk check (
        (scope = 'global'  and user_id is null     and team is null)
     or (scope = 'time'    and user_id is null     and team is not null)
     or (scope = 'usuario' and user_id is not null and team is null)
  )
);

create unique index if not exists qs_copilot_settings_global_uq
  on public.qs_copilot_settings (org_id) where scope = 'global';
create unique index if not exists qs_copilot_settings_team_uq
  on public.qs_copilot_settings (org_id, team) where scope = 'time';
create unique index if not exists qs_copilot_settings_user_uq
  on public.qs_copilot_settings (org_id, user_id) where scope = 'usuario';

drop trigger if exists trg_qs_copilot_settings_touch on public.qs_copilot_settings;
create trigger trg_qs_copilot_settings_touch
  before update on public.qs_copilot_settings
  for each row execute function public.qs_copilot_touch_updated_at();

-- linha global da org padrão
insert into public.qs_copilot_settings (org_id, scope)
select public.qs_default_org_id(), 'global'
where not exists (
  select 1 from public.qs_copilot_settings
  where org_id = public.qs_default_org_id() and scope = 'global'
);

-- Config efetiva: usuário > global (o nível "time" entra quando qs_users tiver time)
create or replace function public.qs_copilot_effective_settings(p_user_id uuid, p_org_id uuid default null)
returns public.qs_copilot_settings
language sql
stable
set search_path = public, pg_temp
as $$
  select s.*
  from public.qs_copilot_settings s
  where s.org_id = coalesce(p_org_id, public.qs_default_org_id())
    and ( (s.scope = 'usuario' and s.user_id = p_user_id) or s.scope = 'global' )
  order by case s.scope when 'usuario' then 1 when 'time' then 2 else 3 end
  limit 1
$$;

comment on function public.qs_copilot_effective_settings(uuid, uuid) is
  'Retorna a configuração efetiva do copiloto para um usuário: linha "usuario" se existir, senão a "global" da org.';

-- ───────────────────────────────────────────────────────────────────────────
-- 12. Realtime: o QS/extensão assinam turnos finais e detecções da call
-- ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public'
                     and tablename = 'qs_copilot_detections') then
      alter publication supabase_realtime add table public.qs_copilot_detections;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public'
                     and tablename = 'qs_copilot_calls') then
      alter publication supabase_realtime add table public.qs_copilot_calls;
    end if;
  else
    raise notice 'Publicação supabase_realtime não encontrada — pulei o registro das tabelas.';
  end if;
end $$;

-- detections e calls sofrem UPDATE → payload do Realtime precisa da linha inteira
alter table public.qs_copilot_detections replica identity full;
alter table public.qs_copilot_calls      replica identity full;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (manual, ordem inversa das dependências):
--   drop table if exists public.qs_copilot_feedback, public.qs_copilot_summaries,
--     public.qs_copilot_detections, public.qs_copilot_transcript_turns,
--     public.qs_copilot_objection_responses, public.qs_copilot_playbook_chunks,
--     public.qs_copilot_objections, public.qs_copilot_settings,
--     public.qs_copilot_calls, public.qs_copilot_org_members, public.qs_copilot_orgs cascade;
--   drop function if exists public.qs_copilot_effective_settings(uuid, uuid),
--     public.qs_copilot_summaries_fill(), public.qs_copilot_feedback_apply(),
--     public.qs_copilot_feedback_fill(), public.qs_copilot_detections_fill(),
--     public.qs_copilot_responses_promote(), public.qs_copilot_responses_before_insert(),
--     public.qs_copilot_fill_from_call(), public.qs_copilot_calls_touch(),
--     public.qs_copilot_touch_updated_at(), public.qs_default_org_id();
--   ATENÇÃO: se 005 já foi aplicada, rode o rollback dela ANTES (FK em qs_meetings).
-- ═══════════════════════════════════════════════════════════════════════════
