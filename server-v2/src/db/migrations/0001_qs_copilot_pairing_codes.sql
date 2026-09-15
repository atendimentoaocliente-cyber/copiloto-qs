-- ═══════════════════════════════════════════════════════════════════════════
-- ADENDO À FRENTE A — 0001_qs_copilot_pairing_codes.sql
--
-- Por quê: o gateway roda com min_machines_running = 2. Um código de pairing
-- guardado em memória numa máquina não é visto pela outra. A tabela é a
-- memória compartilhada mínima (evita Redis só para isso).
--
-- Fluxo: o closer gera o código no QS → o gateway grava aqui → a extensão
-- troca o código por um JWT → o gateway consome (delete atômico). Uso único.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.qs_copilot_pairing_codes (
  codigo      text primary key check (codigo ~ '^[0-9]{6}$'),
  closer_id   uuid not null references public.qs_users(id) on delete cascade,
  expira_em   timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists qs_copilot_pairing_codes_expira_idx
  on public.qs_copilot_pairing_codes (expira_em);

alter table public.qs_copilot_pairing_codes enable row level security;
-- Só o gateway (service_role) toca nesta tabela. Nenhuma policy para authenticated/anon.
grant all on public.qs_copilot_pairing_codes to service_role;

comment on table public.qs_copilot_pairing_codes is
  'Códigos de 6 dígitos, uso único, TTL 5 min. Escritos e consumidos exclusivamente pelo gateway do copiloto.';

-- Categoria para sinal de compra (o motor detecta, mas o seed original não tem).
insert into public.qs_copilot_categories (id, label, descricao, cor, sort_order) values
  ('sinal_compra', 'Sinal de compra', 'Lead pergunta como fechar, prazo, disponibilidade', '#16A34A', 5)
on conflict (id) do nothing;
