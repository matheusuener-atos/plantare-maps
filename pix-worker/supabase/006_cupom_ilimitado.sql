-- Plantare · cupom sem limite de uso
-- Rode depois do 005, uma vez: Supabase › SQL Editor › New query › cole tudo › Run.
--
-- Um cupom marcado como "ilimitado" não olha quem já usou, nem quantas vezes, nem em que talhão.
-- Ele só para quando a validade vence ou quando você o desativa (ativo = false) ou apaga da tabela.
--   1SAMUEL712 → cortesia sua, sem validade, para ceder a quem quiser
--   BEMVINDO30 → cortesia de inauguração, 30 dias a partir de agora
--   BEMVINDO90 → cortesia de inauguração, 90 dias a partir de agora

alter table public.cupons add column if not exists ilimitado boolean not null default false;

-- ---------- cupom: vale para esta pessoa e este talhão? ----------
create or replace function public.plantare_cupom_v2(p_codigo text, p_user uuid, p_email text, p_ha numeric, p_area text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.cupons; usados integer; em text := nullif(lower(trim(p_email)), '');
begin
  select * into c from public.cupons where codigo = upper(trim(p_codigo));
  if not found or not c.ativo then return jsonb_build_object('ok', false, 'motivo', 'Cupom não encontrado.'); end if;
  if c.validade is not null and c.validade < now() then return jsonb_build_object('ok', false, 'motivo', 'Este cupom venceu.'); end if;
  if c.area_min is not null and p_ha < c.area_min then
    return jsonb_build_object('ok', false, 'motivo', 'Este cupom vale a partir de ' || c.area_min || ' ha.'); end if;

  -- cupom ilimitado pula tudo o que conta uso: pessoa, talhão e total
  if not c.ilimitado then
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
  end if;

  return jsonb_build_object('ok', true, 'codigo', c.codigo, 'desconto', c.desconto, 'fixo', c.fixo,
    'gratis', c.gratis, 'validade', c.validade, 'ilimitado', c.ilimitado);
end $$;

-- ---------- reserva: cupom ilimitado não reserva nada (pode repetir à vontade) ----------
create or replace function public.plantare_reservar_cupom_v2(p_codigo text, p_user uuid, p_email text, p_compra text)
returns text language plpgsql security definer set search_path = public as $$
declare antiga text; pago_ja boolean; em text := nullif(lower(trim(p_email)), ''); livre boolean;
begin
  select ilimitado into livre from public.cupons where codigo = upper(trim(p_codigo));
  if coalesce(livre, false) then return null; end if;   -- sem reserva: a compra já guarda qual cupom foi usado
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

-- ---------- os três cupons ----------
insert into public.cupons (codigo, gratis, ativo, ilimitado, validade, usos_max, so_primeira)
values ('1SAMUEL712', true, true, true, null, null, false)
on conflict (codigo) do update
  set gratis = true, desconto = null, fixo = null, ativo = true, ilimitado = true,
      validade = null, usos_max = null, so_primeira = false;

insert into public.cupons (codigo, gratis, ativo, ilimitado, validade, usos_max, so_primeira)
values ('BEMVINDO30', true, true, true, now() + interval '30 days', null, false)
on conflict (codigo) do update
  set gratis = true, desconto = null, fixo = null, ativo = true, ilimitado = true,
      validade = now() + interval '30 days', usos_max = null, so_primeira = false;

insert into public.cupons (codigo, gratis, ativo, ilimitado, validade, usos_max, so_primeira)
values ('BEMVINDO90', true, true, true, now() + interval '90 days', null, false)
on conflict (codigo) do update
  set gratis = true, desconto = null, fixo = null, ativo = true, ilimitado = true,
      validade = now() + interval '90 days', usos_max = null, so_primeira = false;

select codigo, gratis, ilimitado, ativo, usos_max,
  to_char(validade at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as vence_em
from public.cupons order by criado_em;
