-- Plantare · a conferência do cupom passa a devolver a validade (o app mostra "válido até …")
-- Rode depois do 002, uma vez: Supabase › SQL Editor › New query › cole tudo › Run.

create or replace function public.plantare_cupom(p_codigo text, p_user uuid, p_ha numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.cupons; usados integer; ja boolean;
begin
  select * into c from public.cupons where codigo = upper(trim(p_codigo));
  if not found or not c.ativo then return jsonb_build_object('ok', false, 'motivo', 'Cupom não encontrado.'); end if;
  if c.validade is not null and c.validade < now() then return jsonb_build_object('ok', false, 'motivo', 'Este cupom venceu.'); end if;
  if c.area_min is not null and p_ha < c.area_min then
    return jsonb_build_object('ok', false, 'motivo', 'Este cupom vale a partir de ' || c.area_min || ' ha.'); end if;
  select exists(select 1 from public.cupom_usos where cupom = c.codigo and user_id = p_user and pago) into ja;
  if ja then return jsonb_build_object('ok', false, 'motivo', 'Você já usou este cupom.'); end if;
  if c.so_primeira and exists(select 1 from public.compras where user_id = p_user and status = 'pago') then
    return jsonb_build_object('ok', false, 'motivo', 'Este cupom é só para a primeira compra.'); end if;
  if c.usos_max is not null then
    select count(*) into usados from public.cupom_usos where cupom = c.codigo and pago and user_id <> p_user;
    if usados >= c.usos_max then return jsonb_build_object('ok', false, 'motivo', 'Os usos deste cupom acabaram.'); end if;
  end if;
  return jsonb_build_object('ok', true, 'codigo', c.codigo, 'desconto', c.desconto, 'fixo', c.fixo, 'gratis', c.gratis, 'validade', c.validade);
end $$;

revoke all on function public.plantare_cupom(text, uuid, numeric) from public, anon, authenticated;
grant execute on function public.plantare_cupom(text, uuid, numeric) to service_role;

-- ---------- cupons ----------
-- cortesia para os amigos testarem (sem validade; uma vez por conta)
insert into public.cupons (codigo, gratis, ativo)
values ('1SAMUEL712', true, true)
on conflict (codigo) do update
  set gratis = true, desconto = null, fixo = null, ativo = true, validade = null;

-- inauguração: 30% de desconto por 30 dias a partir de agora (uma vez por conta)
insert into public.cupons (codigo, desconto, validade, ativo)
values ('BEMVINDO30', 0.30, now() + interval '30 days', true)
on conflict (codigo) do update
  set desconto = 0.30, fixo = null, gratis = false, validade = now() + interval '30 days', ativo = true;

select codigo, gratis, desconto, fixo, ativo, usos_max, to_char(validade at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as validade
from public.cupons order by criado_em;
