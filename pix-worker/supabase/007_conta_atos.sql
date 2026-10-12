-- Plantare · login pela Conta Atos
-- Rode depois do 006, uma vez: Supabase › SQL Editor › New query › cole tudo › Run.
--
-- O login passa a ser a Conta Atos (atos.dev.br). O Worker confere a volta da Atos e abre a sessão
-- do Supabase da mesma pessoa, então perfis, talhões, projetos e compras seguem com o RLS de sempre.
-- Esta tabela liga o "sub" da Atos (o identificador que não muda) a um login do Supabase.
-- Na primeira entrada a ligação é pelo e-mail confirmado na Atos: quem já tinha conta pelo Google
-- ou pelo código por e-mail cai na mesma conta, com tudo o que já tinha.

create table if not exists public.contas_atos (
  sub        text primary key,
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  criado_em  timestamptz not null default now()
);
-- sem regras de RLS: só o Worker (chave secreta) lê e grava
alter table public.contas_atos enable row level security;
revoke all on public.contas_atos from anon, authenticated;
grant all on public.contas_atos to service_role;

-- o login do Supabase desta Conta Atos; null quando ainda não existe nenhum com o e-mail (o Worker cria e chama de novo)
create or replace function public.plantare_conta_atos(p_sub text, p_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid; em text := nullif(lower(trim(p_email)), '');
begin
  select user_id into uid from public.contas_atos where sub = p_sub;
  if uid is not null then return uid; end if;
  if em is null then return null; end if;
  select id into uid from auth.users where lower(email) = em order by created_at limit 1;
  if uid is null then return null; end if;
  -- uma conta do Plantare fica com uma Conta Atos só
  if exists (select 1 from public.contas_atos where user_id = uid and sub <> p_sub) then
    raise exception 'conta ligada a outra Conta Atos';
  end if;
  insert into public.contas_atos (sub, user_id) values (p_sub, uid) on conflict do nothing;
  select user_id into uid from public.contas_atos where sub = p_sub;
  return uid;
end $$;
revoke all on function public.plantare_conta_atos(text, text) from public, anon, authenticated;
grant execute on function public.plantare_conta_atos(text, text) to service_role;
