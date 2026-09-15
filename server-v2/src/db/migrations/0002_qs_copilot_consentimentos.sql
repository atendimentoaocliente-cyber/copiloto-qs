-- ═══════════════════════════════════════════════════════════════════════════
-- ADENDO À FRENTE A — 0002_qs_copilot_consentimentos.sql
--
-- Prova do consentimento LGPD por call (critério de pronto #6). Registra
-- ACEITE e RECUSA: o QS precisa auditar que o lead foi perguntado, mesmo
-- quando disse não. A extensão só chama depois do closer confirmar; a recusa
-- entra pelo mesmo endpoint (`aceito: false`).
--
-- O id devolvido é o `consentimentoId` que a extensão manda em `sessao.iniciar`;
-- o gateway recusa abrir sessão sem um consentimento aceito, do mesmo closer
-- e do mesmo lead.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.qs_copilot_consentimentos (
  id               uuid primary key default gen_random_uuid(),
  closer_id        uuid not null references public.qs_users(id) on delete restrict,
  lead_id          uuid references public.qs_leads(id) on delete set null,
  meeting_id       uuid references public.qs_meetings(id) on delete set null,
  aceito           boolean not null,
  confirmado_em    timestamptz not null,       -- quando o closer confirmou que leu o texto
  texto_versao     text not null,              -- versão do texto lido em voz alta
  motivo_recusa    text,
  ip               inet,
  user_agent       text,
  versao_extensao  text,
  created_at       timestamptz not null default now()
);

create index if not exists qs_copilot_consentimentos_closer_idx
  on public.qs_copilot_consentimentos (closer_id, created_at desc);
create index if not exists qs_copilot_consentimentos_lead_idx
  on public.qs_copilot_consentimentos (lead_id, created_at desc) where lead_id is not null;

alter table public.qs_copilot_consentimentos enable row level security;
-- Escrita exclusiva do gateway (service_role). Leitura no QS por policy da Frente A.
grant all on public.qs_copilot_consentimentos to service_role;
grant select on public.qs_copilot_consentimentos to authenticated;
drop policy if exists qs_copilot_consentimentos_sel on public.qs_copilot_consentimentos;
create policy qs_copilot_consentimentos_sel on public.qs_copilot_consentimentos
  for select to authenticated
  using ( closer_id = public.qs_current_user_id() or public.qs_is_admin() );

comment on table public.qs_copilot_consentimentos is
  'Prova de consentimento LGPD por call (aceite ou recusa). Escrito só pelo gateway do copiloto.';
