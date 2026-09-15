-- ═══════════════════════════════════════════════════════════════════════════
-- 005_alter_qs_meetings.sql — colunas novas na tabela LEGADA qs_meetings
-- Depende de: 001_schema.sql (FK para qs_copilot_calls)
--
-- Colunas atuais de qs_meetings (verificadas em types.ts → interface Meeting):
--   id, lead_id, owner_id, scheduled_at, status, created_at
-- Adicionamos, todas NULLABLE e sem default que altere linhas existentes:
--   meeting_url       → link do Meet/Zoom (a extensão abre e vincula a call)
--   duration_seconds  → duração real (vem da call do copiloto)
--   outcome           → desfecho comercial da reunião (≠ status, que é logístico)
--   copilot_call_id   → FK para a call do copiloto (Q-1 / Q-6)
--
-- Nada aqui muda o comportamento de fetchQsMeetings/createQsMeeting/
-- updateQsMeeting: `select *` passa a devolver 4 colunas a mais (NULL) e
-- os inserts atuais continuam válidos. Ver patch de types.ts em
-- 005_types_meeting.patch (opcional, para o front tipar as colunas).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

set local search_path = public, extensions;

alter table public.qs_meetings
  add column if not exists meeting_url      text,
  add column if not exists duration_seconds integer,
  add column if not exists outcome          text,
  add column if not exists copilot_call_id  uuid;

-- constraints idempotentes (ADD CONSTRAINT não tem IF NOT EXISTS)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'qs_meetings_duration_chk') then
    alter table public.qs_meetings
      add constraint qs_meetings_duration_chk
      check (duration_seconds is null or duration_seconds >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'qs_meetings_outcome_chk') then
    alter table public.qs_meetings
      add constraint qs_meetings_outcome_chk
      check (outcome is null or outcome in (
        'fechou',            -- venda fechada na call
        'proposta_enviada',  -- saiu com proposta, sem decisão
        'follow_up',         -- precisa de nova conversa
        'sem_interesse',     -- lead desqualificou
        'no_show',           -- lead não apareceu
        'remarcada',
        'outro'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'qs_meetings_copilot_call_fk') then
    alter table public.qs_meetings
      add constraint qs_meetings_copilot_call_fk
      foreign key (copilot_call_id) references public.qs_copilot_calls(id) on delete set null;
  end if;
end $$;

create index if not exists qs_meetings_copilot_call_idx
  on public.qs_meetings (copilot_call_id) where copilot_call_id is not null;

comment on column public.qs_meetings.meeting_url      is 'URL da sala (Meet/Zoom/Teams). A extensão usa para casar a aba com a reunião.';
comment on column public.qs_meetings.duration_seconds is 'Duração real em segundos. Preenchida pelo copiloto ao concluir a call.';
comment on column public.qs_meetings.outcome          is 'Desfecho comercial. Diferente de status (agendada/realizada/no_show/cancelada), que é logístico.';
comment on column public.qs_meetings.copilot_call_id  is 'Call do copiloto vinculada a esta reunião (qs_copilot_calls.id).';

-- ───────────────────────────────────────────────────────────────────────────
-- Sincronização automática: quando a call do copiloto é concluída e tem
-- meeting_id, a reunião recebe copilot_call_id + duração, e se ainda estava
-- "agendada" vira "realizada". Trigger fica na tabela NOVA — não tocamos
-- em triggers do legado.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.qs_copilot_calls_sync_meeting()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev text;                       -- status anterior (NULL em INSERT)
begin
  if tg_op = 'UPDATE' then
    v_prev := old.status;
  end if;

  if new.meeting_id is not null
     and new.status = 'concluida'
     and v_prev is distinct from 'concluida' then
    update public.qs_meetings m
       set copilot_call_id  = new.id,
           duration_seconds = coalesce(m.duration_seconds, new.duration_seconds),
           status           = case when m.status = 'agendada' then 'realizada' else m.status end
     where m.id = new.meeting_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_qs_copilot_calls_sync_meeting on public.qs_copilot_calls;
create trigger trg_qs_copilot_calls_sync_meeting
  after insert or update of status on public.qs_copilot_calls
  for each row execute function public.qs_copilot_calls_sync_meeting();

commit;

-- ROLLBACK:
--   drop trigger if exists trg_qs_copilot_calls_sync_meeting on public.qs_copilot_calls;
--   drop function if exists public.qs_copilot_calls_sync_meeting();
--   alter table public.qs_meetings
--     drop constraint if exists qs_meetings_copilot_call_fk,
--     drop constraint if exists qs_meetings_outcome_chk,
--     drop constraint if exists qs_meetings_duration_chk;
--   alter table public.qs_meetings
--     drop column if exists copilot_call_id, drop column if exists outcome,
--     drop column if exists duration_seconds, drop column if exists meeting_url;
