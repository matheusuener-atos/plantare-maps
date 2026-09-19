-- Plantare · cupom sem conta
-- Rode depois do 004, uma vez: Supabase › SQL Editor › New query › cole tudo › Run.
-- Quem não entra na conta também usa cupom (inclusive cortesia). O "uma vez por pessoa" passa a
-- valer pela conta OU pelo e-mail do comprovante, e cada cupom vale uma vez por talhão.

alter table public.cupom_usos add column if not exists email text;
alter table public.cupom_usos alter column user_id drop not null;
alter table public.cupom_usos drop constraint if exists cupom_usos_pkey;
alter table public.cupom_usos add column if not exists id bigint generated always as identity;
alter table public.cupom_usos add primary key (id);
alter table public.cupom_usos drop constraint if exists cupom_usos_tem_dono;
alter table public.cupom_usos add constraint cupom_usos_tem_dono check (user_id is not null or email is not null);
create unique index if not exists cupom_usos_conta on public.cupom_usos (cupom, user_id) where user_id is not null;
create unique index if not exists cupom_usos_email on public.cupom_usos (cupom, email) where user_id is null;
create index if not exists cupom_usos_email_busca on public.cupom_usos (cupom, email);

-- ---------- cupom: vale para esta pessoa e este talhão? ----------
-- p_user e p_email podem vir vazios (só conferindo o código antes de pedir o e-mail)
create or replace function public.plantare_cupom_v2(p_codigo text, p_user uuid, p_email text, p_ha numeric, p_area text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.cupons; usados integer; em text := nullif(lower(trim(p_email)), '');
begin
  select * into c from public.cupons where codigo = upper(trim(p_codigo));
  if not found or not c.ativo then return jsonb_build_object('ok', false, 'motivo', 'Cupom não encontrado.'); end if;
  if c.validade is not null and c.validade < now() then return jsonb_build_object('ok', false, 'motivo', 'Este cupom venceu.'); end if;
  if c.area_min is not null and p_ha < c.area_min then
    return jsonb_build_object('ok', false, 'motivo', 'Este cupom vale a partir de ' || c.area_min || ' ha.'); end if;
  if exists(select 1 from public.cupom_usos u where u.cupom = c.codigo and u.pago
            and ((p_user is not null and u.user_id = p_user) or (em is not null and u.email = em))) then
    return jsonb_build_object('ok', false, 'motivo', 'Você já usou este cupom.'); end if;
  if p_area is not null and exists(select 1 from public.cupom_usos u join public.compras k on k.id = u.compra_id
            where u.cupom = c.codigo and u.pago and k.area_hash = p_area) then
    return jsonb_build_object('ok', false, 'motivo', 'Este cupom já foi usado neste talhão.'); end if;
  if c.so_primeira and exists(select 1 from public.compras k where k.status = 'pago'
            and ((p_user is not null and k.user_id = p_user) or (em is not null and lower(k.email) = em))) then
    return jsonb_build_object('ok', false, 'motivo', 'Este cupom é só para a primeira compra.'); end if;
  if c.usos_max is not null then
    select count(*) into usados from public.cupom_usos u where u.cupom = c.codigo and u.pago
      and not ((p_user is not null and u.user_id is not distinct from p_user) or (em is not null and u.email is not distinct from em));
    if usados >= c.usos_max then return jsonb_build_object('ok', false, 'motivo', 'Os usos deste cupom acabaram.'); end if;
  end if;
  return jsonb_build_object('ok', true, 'codigo', c.codigo, 'desconto', c.desconto, 'fixo', c.fixo, 'gratis', c.gratis, 'validade', c.validade);
end $$;

-- ---------- cupom: reserva para a compra (troca a reserva pendente anterior da mesma pessoa) ----------
create or replace function public.plantare_reservar_cupom_v2(p_codigo text, p_user uuid, p_email text, p_compra text)
returns text language plpgsql security definer set search_path = public as $$
declare antiga text; pago_ja boolean; em text := nullif(lower(trim(p_email)), '');
begin
  if p_user is null and em is null then raise exception 'sem dono'; end if;
  if p_user is not null then
    select compra_id, pago into antiga, pago_ja from public.cupom_usos where cupom = p_codigo and user_id = p_user for update;
  else
    select compra_id, pago into antiga, pago_ja from public.cupom_usos where cupom = p_codigo and user_id is null and email = em for update;
  end if;
  if found then
    if pago_ja then raise exception 'cupom já usado'; end if;
    update public.cupom_usos set compra_id = p_compra, criado_em = now(), email = coalesce(em, email)
      where cupom = p_codigo and ((p_user is not null and user_id = p_user) or (p_user is null and user_id is null and email = em));
    return case when antiga <> p_compra then antiga end;
  end if;
  insert into public.cupom_usos (cupom, user_id, email, compra_id) values (p_codigo, p_user, em, p_compra);
  return null;
end $$;

revoke all on function public.plantare_cupom_v2(text, uuid, text, numeric, text) from public, anon, authenticated;
revoke all on function public.plantare_reservar_cupom_v2(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.plantare_cupom_v2(text, uuid, text, numeric, text) to service_role;
grant execute on function public.plantare_reservar_cupom_v2(text, uuid, text, text) to service_role;
