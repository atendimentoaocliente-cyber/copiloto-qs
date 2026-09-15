-- ═══════════════════════════════════════════════════════════════════════════
-- 003_rls.sql — Row Level Security do Copiloto QS
-- Depende de: 001_schema.sql, 002_pgvector.sql
--
-- ┌─ SITUAÇÃO REAL (verificada em src/contexts/QsAuthContext.tsx) ──────────┐
-- │ O QS NÃO usa Supabase Auth. Login = SELECT em qs_users comparando a     │
-- │ senha em texto plano (ou o backdoor DEFAULT_PASSWORD). Sessão fica no   │
-- │ localStorage. O browser fala com o PostgREST usando a ANON KEY.         │
-- │ Consequência: auth.uid() é NULL. Policy baseada nele nega 100%.         │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- Entregamos DUAS camadas:
--
-- (a) HOJE — qs_current_user_id() resolve a identidade de várias fontes,
--     na ordem de confiança:
--       1. claim `qs_user_id` de um JWT assinado com o JWT secret do
--          projeto. Quem assina é o GATEWAY (Fastify), depois de validar o
--          login. PostgREST aceita qualquer JWT assinado com o secret e
--          expõe os claims em request.jwt.claims. O QS/extensão manda esse
--          token no header Authorization → RLS funciona SEM Supabase Auth.
--       2. auth.uid() → qs_users.auth_user_id (só existe após MIGRACAO-AUTH.md;
--          se a coluna não existir, a função ignora sem erro).
--       3. GUC `app.qs_user_id` via SET LOCAL — para o gateway em conexão
--          direta com o Postgres (pool). Um cliente do PostgREST NÃO
--          consegue setar GUC arbitrário, então isso não abre brecha.
--     O que NÃO funciona nem hoje nem nunca: browser com anon key pura.
--     Isso é intencional — não há como identificar o usuário com segurança.
--
-- (b) DEPOIS DA MIGRAÇÃO PARA SUPABASE AUTH — bloco comentado no fim com a
--     versão estrita da função (só auth.uid()). As POLÍTICAS não mudam:
--     elas dependem da função, não da fonte da identidade.
--
-- Regra de acesso:
--   closer  → só as próprias calls (closer_id = eu)
--   sdr     → resumos das calls de leads que ele passou no handover (leitura)
--   gestor  → tudo da org (leitura e escrita), não apaga
--   admin   → tudo da org, inclusive delete
--   service_role (gateway) → bypassa RLS, como todo service_role
-- ═══════════════════════════════════════════════════════════════════════════

begin;

set local search_path = public, extensions;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Identidade
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.qs_current_user_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v uuid;
  v_claims jsonb;
  v_auth uuid;
begin
  -- 1) claim custom no JWT (emitido pelo gateway)
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v := (v_claims ->> 'qs_user_id')::uuid;
  exception when others then
    v := null;
  end;
  if v is not null then
    return v;
  end if;

  -- 2) Supabase Auth (pós-migração): auth.users.id → qs_users.auth_user_id
  begin
    v_auth := auth.uid();
  exception when others then
    v_auth := null;
  end;
  if v_auth is not null then
    begin
      execute 'select id from public.qs_users where auth_user_id = $1 and is_active limit 1'
        into v using v_auth;
    exception when undefined_column then
      v := null;   -- coluna ainda não existe: migração de Auth não aplicada
    end;
    if v is not null then
      return v;
    end if;
  end if;

  -- 3) GUC setado pelo gateway em conexão direta (SET LOCAL app.qs_user_id = '...')
  begin
    v := nullif(current_setting('app.qs_user_id', true), '')::uuid;
  exception when others then
    v := null;
  end;

  return v;
end $$;

comment on function public.qs_current_user_id() is
  'Identidade do QS para RLS. Ordem: claim JWT qs_user_id > auth.uid()→qs_users.auth_user_id > GUC app.qs_user_id. NULL = anônimo.';

-- Papel do usuário corrente (admin | gestor | sdr | closer), só se ativo
create or replace function public.qs_current_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.role
  from public.qs_users u
  where u.id = public.qs_current_user_id()
    and u.is_active
$$;

create or replace function public.qs_is_manager()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.qs_current_role() in ('admin','gestor'), false)
$$;

create or replace function public.qs_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.qs_current_role() = 'admin', false)
$$;

-- Org corrente: claim JWT `org_id` > GUC app.org_id > membership > org padrão
create or replace function public.qs_current_org_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v uuid;
  v_user uuid;
begin
  begin
    v := (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id')::uuid;
  exception when others then v := null;
  end;
  if v is not null then return v; end if;

  begin
    v := nullif(current_setting('app.org_id', true), '')::uuid;
  exception when others then v := null;
  end;
  if v is not null then return v; end if;

  v_user := public.qs_current_user_id();
  if v_user is not null then
    select m.org_id into v
    from public.qs_copilot_org_members m
    where m.user_id = v_user
    order by m.created_at
    limit 1;
  end if;

  return coalesce(v, public.qs_default_org_id());
end $$;

-- Predicado reutilizado nas policies: "esta linha é minha ou eu sou gestor/admin"
create or replace function public.qs_copilot_can_access(p_org_id uuid, p_closer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_org_id = public.qs_current_org_id()
     and ( p_closer_id = public.qs_current_user_id() or public.qs_is_manager() )
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Ativar RLS em todas as tabelas do módulo
-- ───────────────────────────────────────────────────────────────────────────
alter table public.qs_copilot_orgs                enable row level security;
alter table public.qs_copilot_org_members         enable row level security;
alter table public.qs_copilot_calls               enable row level security;
alter table public.qs_copilot_transcript_turns    enable row level security;
alter table public.qs_copilot_detections          enable row level security;
alter table public.qs_copilot_feedback            enable row level security;
alter table public.qs_copilot_summaries           enable row level security;
alter table public.qs_copilot_objections          enable row level security;
alter table public.qs_copilot_objection_responses enable row level security;
alter table public.qs_copilot_playbook_chunks     enable row level security;
alter table public.qs_copilot_settings            enable row level security;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Dados de call: calls, turnos, detecções, feedback, resumos
--    closer_id está denormalizado em todas → comparação direta, sem subquery
--    por linha. `(select f())` força o planner a avaliar a função 1x (InitPlan).
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'qs_copilot_calls','qs_copilot_transcript_turns','qs_copilot_detections',
    'qs_copilot_feedback','qs_copilot_summaries'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format('drop policy if exists %I on public.%I', t || '_ins', t);
    execute format('drop policy if exists %I on public.%I', t || '_upd', t);
    execute format('drop policy if exists %I on public.%I', t || '_del', t);

    execute format($f$
      create policy %I on public.%I for select to authenticated
      using ( org_id = (select public.qs_current_org_id())
              and ( closer_id = (select public.qs_current_user_id())
                    or (select public.qs_is_manager()) ) )
    $f$, t || '_sel', t);

    execute format($f$
      create policy %I on public.%I for insert to authenticated
      with check ( org_id = (select public.qs_current_org_id())
                   and ( closer_id = (select public.qs_current_user_id())
                         or (select public.qs_is_manager()) ) )
    $f$, t || '_ins', t);

    execute format($f$
      create policy %I on public.%I for update to authenticated
      using      ( org_id = (select public.qs_current_org_id())
                   and ( closer_id = (select public.qs_current_user_id())
                         or (select public.qs_is_manager()) ) )
      with check ( org_id = (select public.qs_current_org_id())
                   and ( closer_id = (select public.qs_current_user_id())
                         or (select public.qs_is_manager()) ) )
    $f$, t || '_upd', t);

    execute format($f$
      create policy %I on public.%I for delete to authenticated
      using ( org_id = (select public.qs_current_org_id()) and (select public.qs_is_admin()) )
    $f$, t || '_del', t);
  end loop;
end $$;

-- SDR lê o resumo das calls dos leads que ELE passou (fecha o loop SDR → closer)
drop policy if exists qs_copilot_summaries_sdr_sel on public.qs_copilot_summaries;
create policy qs_copilot_summaries_sdr_sel on public.qs_copilot_summaries
  for select to authenticated
  using (
    org_id = (select public.qs_current_org_id())
    and lead_id is not null
    and exists (
      select 1 from public.qs_handovers h
      where h.lead_id = qs_copilot_summaries.lead_id
        and h.from_user_id = (select public.qs_current_user_id())
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Playbook: objeções, respostas, chunks
--    Leitura: qualquer usuário identificado da org. Escrita: gestor/admin.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'qs_copilot_objections','qs_copilot_objection_responses','qs_copilot_playbook_chunks'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format('drop policy if exists %I on public.%I', t || '_wr',  t);

    execute format($f$
      create policy %I on public.%I for select to authenticated
      using ( org_id = (select public.qs_current_org_id())
              and (select public.qs_current_user_id()) is not null )
    $f$, t || '_sel', t);

    execute format($f$
      create policy %I on public.%I for all to authenticated
      using      ( org_id = (select public.qs_current_org_id()) and (select public.qs_is_manager()) )
      with check ( org_id = (select public.qs_current_org_id()) and (select public.qs_is_manager()) )
    $f$, t || '_wr', t);
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Settings: usuário lê a global e a própria; edita só a própria; gestor tudo
-- ───────────────────────────────────────────────────────────────────────────
drop policy if exists qs_copilot_settings_sel on public.qs_copilot_settings;
create policy qs_copilot_settings_sel on public.qs_copilot_settings
  for select to authenticated
  using ( org_id = (select public.qs_current_org_id())
          and ( scope = 'global'
                or user_id = (select public.qs_current_user_id())
                or (select public.qs_is_manager()) ) );

drop policy if exists qs_copilot_settings_own on public.qs_copilot_settings;
create policy qs_copilot_settings_own on public.qs_copilot_settings
  for all to authenticated
  using      ( org_id = (select public.qs_current_org_id())
               and scope = 'usuario' and user_id = (select public.qs_current_user_id()) )
  with check ( org_id = (select public.qs_current_org_id())
               and scope = 'usuario' and user_id = (select public.qs_current_user_id()) );

drop policy if exists qs_copilot_settings_manager on public.qs_copilot_settings;
create policy qs_copilot_settings_manager on public.qs_copilot_settings
  for all to authenticated
  using      ( org_id = (select public.qs_current_org_id()) and (select public.qs_is_manager()) )
  with check ( org_id = (select public.qs_current_org_id()) and (select public.qs_is_manager()) );

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Orgs e membros
-- ───────────────────────────────────────────────────────────────────────────
drop policy if exists qs_copilot_orgs_sel on public.qs_copilot_orgs;
create policy qs_copilot_orgs_sel on public.qs_copilot_orgs
  for select to authenticated
  using ( id = (select public.qs_current_org_id()) );

drop policy if exists qs_copilot_orgs_admin on public.qs_copilot_orgs;
create policy qs_copilot_orgs_admin on public.qs_copilot_orgs
  for update to authenticated
  using ( id = (select public.qs_current_org_id()) and (select public.qs_is_admin()) )
  with check ( id = (select public.qs_current_org_id()) and (select public.qs_is_admin()) );

drop policy if exists qs_copilot_org_members_sel on public.qs_copilot_org_members;
create policy qs_copilot_org_members_sel on public.qs_copilot_org_members
  for select to authenticated
  using ( org_id = (select public.qs_current_org_id()) );

drop policy if exists qs_copilot_org_members_admin on public.qs_copilot_org_members;
create policy qs_copilot_org_members_admin on public.qs_copilot_org_members
  for all to authenticated
  using      ( org_id = (select public.qs_current_org_id()) and (select public.qs_is_admin()) )
  with check ( org_id = (select public.qs_current_org_id()) and (select public.qs_is_admin()) );

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Grants (Supabase costuma ter default privileges, mas explícito é melhor)
-- ───────────────────────────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on
  public.qs_copilot_orgs, public.qs_copilot_org_members, public.qs_copilot_calls,
  public.qs_copilot_transcript_turns, public.qs_copilot_detections, public.qs_copilot_feedback,
  public.qs_copilot_summaries, public.qs_copilot_objections, public.qs_copilot_objection_responses,
  public.qs_copilot_playbook_chunks, public.qs_copilot_settings
  to authenticated, service_role;

grant select on public.qs_copilot_vw_embeddings_pendentes to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- anon NÃO recebe nada nas tabelas do copiloto: a anon key pura não identifica ninguém.
revoke all on
  public.qs_copilot_orgs, public.qs_copilot_org_members, public.qs_copilot_calls,
  public.qs_copilot_transcript_turns, public.qs_copilot_detections, public.qs_copilot_feedback,
  public.qs_copilot_summaries, public.qs_copilot_objections, public.qs_copilot_objection_responses,
  public.qs_copilot_playbook_chunks, public.qs_copilot_settings
  from anon;

grant execute on function
  public.qs_current_user_id(), public.qs_current_role(), public.qs_is_manager(),
  public.qs_is_admin(), public.qs_current_org_id(), public.qs_copilot_can_access(uuid, uuid),
  public.qs_copilot_effective_settings(uuid, uuid),
  public.match_objecao(vector, double precision, integer, uuid, text[], text),
  public.match_objecao_hibrido(vector, text, double precision, integer, uuid, integer),
  public.match_playbook(vector, double precision, integer, uuid, text, text, text[])
  to authenticated, service_role;

-- Funções SECURITY DEFINER não devem ser executáveis por PUBLIC/anon
revoke execute on function
  public.qs_current_user_id(), public.qs_current_role(), public.qs_is_manager(),
  public.qs_is_admin(), public.qs_current_org_id(), public.qs_copilot_can_access(uuid, uuid)
  from public, anon;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- (b) VERSÃO DEFINITIVA — aplicar DEPOIS de MIGRACAO-AUTH.md
--
-- Quando todos os usuários tiverem qs_users.auth_user_id preenchido e o
-- login for supabase.auth.signInWithPassword, troque a função pela versão
-- estrita abaixo. Ela ignora o claim custom e o GUC: só auth.uid() vale.
-- As policies continuam idênticas (dependem da função, não da fonte).
--
-- O gateway, que hoje assina JWT com claim qs_user_id, passa a:
--   · receber o access_token do Supabase Auth do QS/extensão (pairing),
--   · validar com o JWKS do projeto,
--   · e usar service_role apenas para escrita de transcrição/detecção.
--
-- create or replace function public.qs_current_user_id()
-- returns uuid
-- language sql
-- stable
-- security definer
-- set search_path = public, pg_temp
-- as $$
--   select u.id
--   from public.qs_users u
--   where u.auth_user_id = auth.uid()
--     and u.is_active
--   limit 1
-- $$;
--
-- -- Opcional (recomendado): índice para o lookup
-- create unique index if not exists qs_users_auth_user_id_uq
--   on public.qs_users (auth_user_id) where auth_user_id is not null;
--
-- -- Teste rápido após trocar (como usuário autenticado no SQL editor
-- -- ou via PostgREST com o access_token):
-- --   select public.qs_current_user_id(), public.qs_current_role();
-- --   select count(*) from public.qs_copilot_calls;   -- closer: só as dele
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- COMO O GATEWAY EMITE O JWT HOJE (camada a, fonte 1) — referência Node:
--
--   import jwt from "jsonwebtoken";
--   const token = jwt.sign(
--     { role: "authenticated", qs_user_id: user.id, org_id: orgId, sub: user.id },
--     process.env.SUPABASE_JWT_SECRET,               // Settings → API → JWT Secret
--     { expiresIn: "12h", issuer: "qs-copilot-gateway" }
--   );
--   // QS: createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } })
--
-- Com esse header, request.jwt.claims ->> 'qs_user_id' resolve e as
-- policies acima funcionam HOJE, sem Supabase Auth.
-- ═══════════════════════════════════════════════════════════════════════════
