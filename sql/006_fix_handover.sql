-- ═══════════════════════════════════════════════════════════════════════════
-- 006_fix_handover.sql — corrige o bug F-3 (status "qualificado")
--
-- O BUG (src/lib/qs/queries.ts, handoverLead, linha ~247):
--   .update({ status: "qualificado" as LeadStatus, owner_id: toUserId, ... })
-- "qualificado" NÃO existe em LeadStatus (nao_iniciado | em_prospeccao |
-- ganho | perdido). Como qs_leads.status é TEXT sem CHECK, o banco aceitou.
-- Consequências:
--   · o lead some de fetchLeadsCoverage (filtra in ('nao_iniciado','em_prospeccao'))
--   · STATUS_LABELS[lead.status] vira undefined na UI
--   · taxa de conversão do dashboard fica errada (denominador não fecha)
--   · qualquer métrica do copiloto que cruze lead.status herdaria o erro
--
-- A CORREÇÃO (em 3 partes):
--   1. dados  → leads com "qualificado" voltam para "em_prospeccao"
--               (o handover já está registrado em qs_handovers, e o
--               owner_id já é o closer — o lead continua em andamento)
--   2. schema → CHECK em qs_leads.status para o bug não voltar
--   3. código → 006_fix_handover.patch em queries.ts
--
-- Decisão de produto registrada: NÃO criamos um status "qualificado"
-- legítimo. Se um dia fizer sentido, é preciso alterar LeadStatus,
-- STATUS_LABELS, todos os filtros `in (...)` de queries.ts e este CHECK.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

set local search_path = public, extensions;

-- 1. Log das linhas alteradas (para auditoria e rollback exato)
create table if not exists public.qs_leads_status_fix_log (
  lead_id     uuid not null,
  old_status  text not null,
  new_status  text not null,
  owner_id    uuid,
  fixed_at    timestamptz not null default now(),
  migration   text not null default '006_fix_handover'
);

insert into public.qs_leads_status_fix_log (lead_id, old_status, new_status, owner_id)
select l.id, l.status, 'em_prospeccao', l.owner_id
from public.qs_leads l
where l.status = 'qualificado';

-- 2. Correção dos dados
update public.qs_leads
   set status     = 'em_prospeccao',
       updated_at = now()
 where status = 'qualificado';

-- 3. Relatório do que foi feito + CHECK constraint
do $$
declare
  v_fixed   bigint;
  v_invalid bigint;
  v_lista   text;
begin
  select count(*) into v_fixed
  from public.qs_leads_status_fix_log where migration = '006_fix_handover';
  raise notice '[006] leads corrigidos de "qualificado" → "em_prospeccao": %', v_fixed;

  -- Existe algum OUTRO valor fora do tipo? (não deveria, mas o banco nunca validou)
  select count(*), string_agg(distinct status, ', ')
    into v_invalid, v_lista
  from public.qs_leads
  where status not in ('nao_iniciado','em_prospeccao','ganho','perdido');

  if v_invalid > 0 then
    raise warning '[006] % leads com status fora do tipo (%). CHECK NÃO aplicado — trate manualmente e rode de novo.', v_invalid, v_lista;
  elsif not exists (select 1 from pg_constraint where conname = 'qs_leads_status_chk') then
    alter table public.qs_leads
      add constraint qs_leads_status_chk
      check (status in ('nao_iniciado','em_prospeccao','ganho','perdido'));
    raise notice '[006] CHECK qs_leads_status_chk aplicado. O valor "qualificado" passa a ser rejeitado pelo banco.';
  else
    raise notice '[006] CHECK qs_leads_status_chk já existia.';
  end if;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO:
--   select status, count(*) from public.qs_leads group by 1;        -- sem "qualificado"
--   select * from public.qs_leads_status_fix_log;                    -- quem foi corrigido
--   update public.qs_leads set status = 'qualificado' where false;   -- ok
--   -- deve FALHAR com check violation:
--   -- update public.qs_leads set status = 'qualificado' where id = (select id from qs_leads limit 1);
--
-- ROLLBACK (só dos dados; o CHECK precisa cair antes):
--   alter table public.qs_leads drop constraint if exists qs_leads_status_chk;
--   update public.qs_leads l set status = f.old_status
--     from public.qs_leads_status_fix_log f
--    where f.lead_id = l.id and f.migration = '006_fix_handover';
-- ═══════════════════════════════════════════════════════════════════════════
