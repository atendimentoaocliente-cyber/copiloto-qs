-- ═══════════════════════════════════════════════════════════════════════════
-- 004_views_analytics.sql — views de analytics do Copiloto QS
-- Depende de: 001, 003 (funções de identidade), 005 é opcional
--
-- Todas com security_invoker = on (PG15+): a view respeita a RLS de quem
-- consulta. Closer vê só as suas linhas; gestor/admin veem a org inteira.
-- Prefixo: qs_copilot_vw_*
-- ═══════════════════════════════════════════════════════════════════════════

begin;

set local search_path = public, extensions;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Catálogo de calls (substitui o /calls.html do protótipo)
-- ───────────────────────────────────────────────────────────────────────────
create or replace view public.qs_copilot_vw_calls
with (security_invoker = on) as
select
  c.id,
  c.org_id,
  c.closer_id,
  u.name                                                     as closer,
  c.lead_id,
  coalesce(l.full_name, c.lead_nome_snapshot)                as lead,
  l.status                                                   as lead_status,
  c.meeting_id,
  c.status,
  c.platform,
  c.started_at,
  c.ended_at,
  c.duration_seconds,
  c.consent_status,
  (select count(*) from public.qs_copilot_transcript_turns t where t.call_id = c.id and t.is_final)::int as total_turnos,
  (select count(*) from public.qs_copilot_transcript_turns t where t.call_id = c.id and t.is_final and t.speaker = 'lead')::int   as turnos_lead,
  (select count(*) from public.qs_copilot_transcript_turns t where t.call_id = c.id and t.is_final and t.speaker = 'closer')::int as turnos_closer,
  (select count(*) from public.qs_copilot_detections d where d.call_id = c.id)::int as objecoes,
  (select count(*) from public.qs_copilot_detections d where d.call_id = c.id and d.closer_usou)::int as sugestoes_usadas,
  s.temperatura,
  s.proximo_passo,
  s.proximo_passo_prazo,
  c.stt_cost_usd,
  c.llm_cost_usd,
  c.total_cost_brl,
  c.created_at
from public.qs_copilot_calls c
join public.qs_users u on u.id = c.closer_id
left join public.qs_leads l on l.id = c.lead_id
left join public.qs_copilot_summaries s on s.call_id = c.id;

comment on view public.qs_copilot_vw_calls is 'Catálogo de calls com contadores, temperatura e custo. Base da tela Histórico.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Objeções mais frequentes (últimos 90 dias)
-- ───────────────────────────────────────────────────────────────────────────
create or replace view public.qs_copilot_vw_objecoes_frequentes
with (security_invoker = on) as
select
  d.org_id,
  d.categoria,
  d.objection_id,
  coalesce(o.titulo, '(não catalogada · ' || d.categoria || ')') as objecao,
  count(*)::bigint                                   as deteccoes,
  count(distinct d.call_id)::bigint                  as calls,
  count(distinct d.closer_id)::bigint                as closers,
  count(*) filter (where d.fonte = 'gatilho')::bigint as via_gatilho,
  count(*) filter (where d.fonte in ('vetor','hibrido'))::bigint as via_vetor,
  count(*) filter (where d.fonte = 'ia')::bigint     as via_ia,
  round(avg(d.similarity)::numeric, 3)               as similaridade_media,
  count(*) filter (where d.shown_at is not null)::bigint as exibidas,
  count(*) filter (where d.closer_usou)::bigint      as usadas,
  round(100.0 * count(*) filter (where d.closer_usou)
        / nullif(count(*) filter (where d.shown_at is not null), 0), 1) as taxa_uso_pct,
  round(percentile_cont(0.50) within group (order by d.latency_ms)::numeric, 0) as latencia_p50_ms,
  round(percentile_cont(0.95) within group (order by d.latency_ms)::numeric, 0) as latencia_p95_ms,
  max(d.created_at)                                  as ultima_ocorrencia
from public.qs_copilot_detections d
left join public.qs_copilot_objections o on o.id = d.objection_id
where d.created_at >= now() - interval '90 days'
group by d.org_id, d.categoria, d.objection_id, o.titulo
order by count(*) desc;

comment on view public.qs_copilot_vw_objecoes_frequentes is 'Ranking de objeções detectadas nos últimos 90 dias, com origem da detecção e taxa de uso.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Taxa de uso da sugestão por closer (últimos 30 dias)
-- ───────────────────────────────────────────────────────────────────────────
create or replace view public.qs_copilot_vw_taxa_uso_por_closer
with (security_invoker = on) as
select
  d.org_id,
  d.closer_id,
  u.name                                             as closer,
  count(distinct d.call_id)::bigint                  as calls_com_copiloto,
  count(*)::bigint                                   as sugestoes_geradas,
  count(*) filter (where d.shown_at is not null)::bigint as sugestoes_exibidas,
  count(*) filter (where d.closer_usou)::bigint      as usadas,
  count(*) filter (where d.closer_usou = false)::bigint as nao_serviram,
  count(*) filter (where d.closer_usou is null)::bigint as sem_feedback,
  round(100.0 * count(*) filter (where d.closer_usou)
        / nullif(count(*) filter (where d.shown_at is not null), 0), 1) as taxa_uso_pct,
  round(100.0 * count(*) filter (where d.closer_usou is not null)
        / nullif(count(*) filter (where d.shown_at is not null), 0), 1) as taxa_feedback_pct,
  round(count(*)::numeric / nullif(count(distinct d.call_id), 0), 1) as objecoes_por_call,
  round(percentile_cont(0.50) within group (order by d.latency_ms)::numeric, 0) as latencia_p50_ms,
  round(percentile_cont(0.95) within group (order by d.latency_ms)::numeric, 0) as latencia_p95_ms,
  -- motivo mais comum de "não serviu" (alimenta a curadoria)
  (select f.motivo from public.qs_copilot_feedback f
    where f.closer_id = d.closer_id and f.resultado = 'nao_serviu'
      and f.created_at >= now() - interval '30 days'
    group by f.motivo order by count(*) desc limit 1) as motivo_rejeicao_top
from public.qs_copilot_detections d
join public.qs_users u on u.id = d.closer_id
where d.created_at >= now() - interval '30 days'
group by d.org_id, d.closer_id, u.name
order by taxa_uso_pct desc nulls last;

comment on view public.qs_copilot_vw_taxa_uso_por_closer is 'Quanto cada closer usa o que o copiloto sugere. taxa_feedback_pct baixa = closer não está marcando.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Objeções que mais aparecem em leads PERDIDOS (cruza com qs_loss_reasons)
--    Responde: "qual objeção realmente mata a venda?" (Q-5)
-- ───────────────────────────────────────────────────────────────────────────
create or replace view public.qs_copilot_vw_objecoes_leads_perdidos
with (security_invoker = on) as
with calls_desfecho as (
  select
    c.id            as call_id,
    c.org_id,
    c.closer_id,
    l.id            as lead_id,
    l.status        as lead_status,
    l.closed_value,
    l.estimated_value,
    lr.label        as motivo_perda
  from public.qs_copilot_calls c
  join public.qs_leads l on l.id = c.lead_id
  left join public.qs_loss_reasons lr on lr.id = l.loss_reason_id
  where c.status = 'concluida'
    and l.status in ('ganho','perdido')
),
det_unicas as (   -- 1 call conta 1x por objeção
  select distinct d.call_id, d.categoria, d.objection_id
  from public.qs_copilot_detections d
)
select
  cd.org_id,
  du.categoria,
  du.objection_id,
  coalesce(o.titulo, '(não catalogada · ' || du.categoria || ')') as objecao,
  count(*)::bigint                                              as calls_com_objecao,
  count(*) filter (where cd.lead_status = 'perdido')::bigint    as calls_perdidas,
  count(*) filter (where cd.lead_status = 'ganho')::bigint      as calls_ganhas,
  round(100.0 * count(*) filter (where cd.lead_status = 'perdido')
        / nullif(count(*), 0), 1)                               as taxa_perda_pct,
  coalesce(sum(cd.estimated_value) filter (where cd.lead_status = 'perdido'), 0)::numeric as receita_perdida_estimada,
  coalesce(sum(cd.closed_value)    filter (where cd.lead_status = 'ganho'),   0)::numeric as receita_ganha,
  mode() within group (order by cd.motivo_perda)
    filter (where cd.lead_status = 'perdido')                   as motivo_perda_predominante,
  -- distribuição completa dos motivos de perda para essa objeção
  (select jsonb_object_agg(m.motivo, m.qtd)
     from (select coalesce(cd2.motivo_perda, 'sem motivo') as motivo, count(*) as qtd
             from det_unicas du2
             join calls_desfecho cd2 on cd2.call_id = du2.call_id
            where cd2.lead_status = 'perdido'
              and du2.categoria = du.categoria
              and du2.objection_id is not distinct from du.objection_id
            group by 1) m)                                       as motivos_perda
from det_unicas du
join calls_desfecho cd on cd.call_id = du.call_id
left join public.qs_copilot_objections o on o.id = du.objection_id
group by cd.org_id, du.categoria, du.objection_id, o.titulo
having count(*) >= 3            -- corta ruído: não concluir em cima de 1 call
order by taxa_perda_pct desc nulls last, calls_com_objecao desc;

comment on view public.qs_copilot_vw_objecoes_leads_perdidos is
  'Cruza objeções detectadas com desfecho do lead e motivo de perda (qs_loss_reasons). HAVING >= 3 calls evita falsa conclusão.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Ranking por closer (últimos 90 dias)
-- ───────────────────────────────────────────────────────────────────────────
create or replace view public.qs_copilot_vw_ranking_closers
with (security_invoker = on) as
with calls as (
  select
    c.id, c.org_id, c.closer_id, c.lead_id, c.duration_seconds, c.total_cost_brl,
    l.status as lead_status, l.closed_value
  from public.qs_copilot_calls c
  left join public.qs_leads l on l.id = c.lead_id
  where c.status = 'concluida'
    and c.started_at >= now() - interval '90 days'
),
det as (
  select d.call_id,
         count(*)                                   as objecoes,
         count(*) filter (where d.closer_usou)      as usadas,
         count(*) filter (where d.shown_at is not null) as exibidas
  from public.qs_copilot_detections d
  group by d.call_id
),
summ as (
  select s.call_id, s.temperatura, s.talk_ratio_closer
  from public.qs_copilot_summaries s
)
select
  c.org_id,
  c.closer_id,
  u.name                                              as closer,
  count(*)::bigint                                    as calls,
  round(sum(c.duration_seconds) / 60.0, 0)            as minutos_em_call,
  round(avg(c.duration_seconds) / 60.0, 1)            as duracao_media_min,
  round(avg(coalesce(d.objecoes, 0))::numeric, 1)     as objecoes_por_call,
  round(100.0 * sum(coalesce(d.usadas, 0)) / nullif(sum(coalesce(d.exibidas, 0)), 0), 1) as taxa_uso_pct,
  round(100.0 * count(*) filter (where s.temperatura = 'quente') / nullif(count(*), 0), 1) as pct_calls_quentes,
  round(avg(s.talk_ratio_closer)::numeric, 1)          as talk_ratio_closer_medio,
  count(*) filter (where c.lead_status = 'ganho')::bigint   as leads_ganhos,
  count(*) filter (where c.lead_status = 'perdido')::bigint as leads_perdidos,
  round(100.0 * count(*) filter (where c.lead_status = 'ganho')
        / nullif(count(*) filter (where c.lead_status in ('ganho','perdido')), 0), 1) as taxa_conversao_pct,
  coalesce(sum(c.closed_value) filter (where c.lead_status = 'ganho'), 0)::numeric as receita_ganha,
  round(sum(c.total_cost_brl)::numeric, 2)            as custo_total_brl,
  round(avg(c.total_cost_brl)::numeric, 2)            as custo_medio_call_brl
from calls c
join public.qs_users u on u.id = c.closer_id
left join det d on d.call_id = c.id
left join summ s on s.call_id = c.id
group by c.org_id, c.closer_id, u.name
order by taxa_conversao_pct desc nulls last, calls desc;

comment on view public.qs_copilot_vw_ranking_closers is 'Ranking de closers (90 dias): volume, uso do copiloto, temperatura, conversão e custo.';

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Custo por período (dia e mês) — P-6 / critério 10 (≤ R$ 5 por call)
-- ───────────────────────────────────────────────────────────────────────────
create or replace view public.qs_copilot_vw_custo_por_dia
with (security_invoker = on) as
select
  c.org_id,
  c.closer_id,
  u.name                                              as closer,
  (c.started_at at time zone 'America/Sao_Paulo')::date as dia,
  count(*)::bigint                                    as calls,
  round(sum(c.duration_seconds) / 60.0, 0)            as minutos,
  round(sum(c.stt_cost_usd)::numeric, 4)              as stt_usd,
  round(sum(c.llm_cost_usd)::numeric, 4)              as llm_usd,
  round(sum(c.total_cost_brl)::numeric, 2)            as total_brl,
  round(avg(c.total_cost_brl)::numeric, 2)            as media_por_call_brl,
  round(max(c.total_cost_brl)::numeric, 2)            as max_call_brl,
  count(*) filter (where c.total_cost_brl > 5)::bigint as calls_acima_de_5_brl
from public.qs_copilot_calls c
join public.qs_users u on u.id = c.closer_id
where c.started_at is not null
group by c.org_id, c.closer_id, u.name, (c.started_at at time zone 'America/Sao_Paulo')::date
order by dia desc, closer;

create or replace view public.qs_copilot_vw_custo_por_mes
with (security_invoker = on) as
select
  c.org_id,
  c.closer_id,
  u.name                                              as closer,
  to_char(c.started_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as mes,
  count(*)::bigint                                    as calls,
  round(sum(c.duration_seconds) / 60.0, 0)            as minutos,
  round(sum(c.stt_cost_usd)::numeric, 4)              as stt_usd,
  round(sum(c.llm_cost_usd)::numeric, 4)              as llm_usd,
  round(sum(c.total_cost_brl)::numeric, 2)            as total_brl,
  round(avg(c.total_cost_brl)::numeric, 2)            as media_por_call_brl,
  round(sum(c.total_cost_brl)::numeric / nullif(sum(c.duration_seconds) / 60.0, 0), 4) as brl_por_minuto
from public.qs_copilot_calls c
join public.qs_users u on u.id = c.closer_id
where c.started_at is not null
group by c.org_id, c.closer_id, u.name, to_char(c.started_at at time zone 'America/Sao_Paulo', 'YYYY-MM')
order by mes desc, total_brl desc;

comment on view public.qs_copilot_vw_custo_por_mes is 'Custo mensal por closer. Compare com o orçamento (~R$ 740/closer/mês) e o teto por call (R$ 5).';

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Timeline de uma call (detalhe com transcrição + detecções intercaladas)
-- ───────────────────────────────────────────────────────────────────────────
create or replace view public.qs_copilot_vw_call_timeline
with (security_invoker = on) as
select
  t.call_id, t.org_id, t.closer_id,
  'turno'::text        as tipo,
  t.offset_ms,
  t.speaker,
  t.content            as texto,
  null::text           as categoria,
  null::text           as fonte,
  null::real           as similarity,
  null::boolean        as closer_usou,
  t.id::text           as ref_id
from public.qs_copilot_transcript_turns t
where t.is_final
union all
select
  d.call_id, d.org_id, d.closer_id,
  'deteccao'::text,
  d.detected_at_ms,
  'copiloto'::text,
  d.sugestao_exibida,
  d.categoria,
  d.fonte,
  d.similarity,
  d.closer_usou,
  d.id::text
from public.qs_copilot_detections d
order by call_id, offset_ms, tipo;

comment on view public.qs_copilot_vw_call_timeline is 'Transcrição e detecções intercaladas por offset_ms. Base da tela Detalhe da call.';

-- ───────────────────────────────────────────────────────────────────────────
-- Grants
-- ───────────────────────────────────────────────────────────────────────────
grant select on
  public.qs_copilot_vw_calls,
  public.qs_copilot_vw_objecoes_frequentes,
  public.qs_copilot_vw_taxa_uso_por_closer,
  public.qs_copilot_vw_objecoes_leads_perdidos,
  public.qs_copilot_vw_ranking_closers,
  public.qs_copilot_vw_custo_por_dia,
  public.qs_copilot_vw_custo_por_mes,
  public.qs_copilot_vw_call_timeline
  to authenticated, service_role;

commit;

-- ROLLBACK:
--   drop view if exists public.qs_copilot_vw_call_timeline, public.qs_copilot_vw_custo_por_mes,
--     public.qs_copilot_vw_custo_por_dia, public.qs_copilot_vw_ranking_closers,
--     public.qs_copilot_vw_objecoes_leads_perdidos, public.qs_copilot_vw_taxa_uso_por_closer,
--     public.qs_copilot_vw_objecoes_frequentes, public.qs_copilot_vw_calls;
