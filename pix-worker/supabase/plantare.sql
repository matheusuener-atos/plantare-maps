-- Plantare · banco de compras e cupons (Supabase)
-- Rode uma vez em: Supabase › SQL Editor › New query › cole tudo › Run.
-- Quem escreve aqui é só o Worker (chave secreta). O app lê apenas as próprias compras.

-- ---------- compras: uma linha por Pix gerado ----------
create table if not exists public.compras (
  id            text primary key,                         -- id da order no Mercado Pago
  user_id       uuid not null references auth.users(id) on delete cascade,
  email         text not null,
  plano         text not null,                            -- #id do plano no app
  area_hash     text not null,                            -- impressão digital do talhão cobrado
  ha            numeric(12,2) not null,
  camadas       text[] not null,
  valor         numeric(12,2) not null,
  cupom         text,
  status        text not null default 'pendente'
                check (status in ('pendente','pago','cancelado','expirado')),
  criado_em     timestamptz not null default now(),
  pago_em       timestamptz,
  downloads     integer not null default 0,
  ultimo_download timestamptz
);
create index if not exists compras_user_idx on public.compras (user_id, status);
create index if not exists compras_area_idx on public.compras (user_id, area_hash);

-- ---------- cupons: você cria e edita pela tabela (Table Editor) ----------
create table if not exists public.cupons (
  codigo      text primary key check (codigo = upper(codigo) and codigo ~ '^[A-Z0-9_-]{3,32}$'),
  -- um tipo por cupom: desconto (0.10 = 10%), fixo (a compra sai por R$ X) ou gratis (cortesia, baixa sem Pix)
  desconto    numeric(4,3) check (desconto > 0 and desconto <= 0.9),
  fixo        numeric(10,2) check (fixo > 0),
  gratis      boolean not null default false,
  usos_max    integer check (usos_max is null or usos_max > 0),               -- total de contas; vazio = sem limite
  validade    timestamptz,                                                     -- vazio = não vence
  so_primeira boolean not null default false,                                  -- só para quem nunca comprou
  area_min    numeric(12,2),                                                   -- ha mínimos para valer
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now(),
  constraint cupom_um_tipo check ((desconto is not null)::int + (fixo is not null)::int + gratis::int = 1)
);

-- ---------- uso de cupom: 1 por conta (a chave primária garante) ----------
create table if not exists public.cupom_usos (
  cupom      text not null references public.cupons(codigo) on update cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  compra_id  text not null references public.compras(id) on delete cascade,
  pago       boolean not null default false,
  criado_em  timestamptz not null default now(),
  primary key (cupom, user_id)
);

-- ---------- segurança ----------
alter table public.compras    enable row level security;
alter table public.cupons     enable row level security;
alter table public.cupom_usos enable row level security;

-- o app (usuário logado) só enxerga as próprias compras; ninguém de fora vê cupons nem usos
drop policy if exists "minhas compras" on public.compras;
create policy "minhas compras" on public.compras for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.compras, public.cupons, public.cupom_usos from anon, authenticated;
grant select on public.compras to authenticated;
grant select, insert, update, delete on public.compras, public.cupons, public.cupom_usos to service_role;

-- ---------- cupom: vale para esta conta? ----------
-- devolve {ok, desconto} ou {ok:false, motivo}
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
  return jsonb_build_object('ok', true, 'codigo', c.codigo, 'desconto', c.desconto, 'fixo', c.fixo, 'gratis', c.gratis);
end $$;

-- ---------- cupom: reserva para a compra (troca a reserva pendente anterior) ----------
-- devolve o id da compra pendente que perdeu a reserva (para cancelar o Pix antigo), ou null
create or replace function public.plantare_reservar_cupom(p_codigo text, p_user uuid, p_compra text)
returns text language plpgsql security definer set search_path = public as $$
declare antiga text; pago_ja boolean;
begin
  select compra_id, pago into antiga, pago_ja from public.cupom_usos where cupom = p_codigo and user_id = p_user for update;
  if found then
    if pago_ja then raise exception 'cupom já usado'; end if;
    update public.cupom_usos set compra_id = p_compra, criado_em = now() where cupom = p_codigo and user_id = p_user;
    return case when antiga <> p_compra then antiga end;
  end if;
  insert into public.cupom_usos (cupom, user_id, compra_id) values (p_codigo, p_user, p_compra);
  return null;
end $$;

-- ---------- Pix caiu: marca a compra e o cupom (idempotente) ----------
create or replace function public.plantare_confirmar(p_compra text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.compras set status = 'pago', pago_em = coalesce(pago_em, now()) where id = p_compra;
  update public.cupom_usos set pago = true where compra_id = p_compra;
end $$;

revoke all on function public.plantare_cupom(text, uuid, numeric) from public, anon, authenticated;
revoke all on function public.plantare_reservar_cupom(text, uuid, text) from public, anon, authenticated;
revoke all on function public.plantare_confirmar(text) from public, anon, authenticated;
grant execute on function public.plantare_cupom(text, uuid, numeric) to service_role;
grant execute on function public.plantare_reservar_cupom(text, uuid, text) to service_role;
grant execute on function public.plantare_confirmar(text) to service_role;

-- ---------- exemplos (troque os códigos: o repositório é público) ----------
-- insert into public.cupons (codigo, desconto, usos_max, so_primeira) values ('CAMPO10', 0.10, 100, true);
-- insert into public.cupons (codigo, fixo, usos_max) values ('TESTE2', 2, 20);
-- insert into public.cupons (codigo, gratis, usos_max, validade) values ('AMIGO', true, 10, now() + interval '30 days');
