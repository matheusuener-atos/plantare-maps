-- Plantare · cadastro, talhões da conta e projetos salvos (Supabase)
-- Rode DEPOIS do plantare.sql, uma vez: Supabase › SQL Editor › New query › cole tudo › Run.
-- Aqui quem escreve é o próprio app, com o login da pessoa: cada conta só lê e grava o que é dela (RLS).

-- ---------- cadastro: dados mínimos para a nota fiscal (NFS-e) ----------
create table if not exists public.perfis (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  nome          text not null check (char_length(btrim(nome)) between 3 and 120),
  cpf           text not null check (cpf ~ '^[0-9]{11}$'),
  whatsapp      text not null check (whatsapp ~ '^[0-9]{10,11}$'),
  cep           text not null check (cep ~ '^[0-9]{8}$'),
  logradouro    text not null check (char_length(logradouro) <= 160),
  numero        text not null check (char_length(numero) <= 20),
  complemento   text check (complemento is null or char_length(complemento) <= 80),
  bairro        text not null check (char_length(bairro) <= 100),
  cidade        text not null check (char_length(cidade) <= 100),
  uf            text not null check (uf ~ '^[A-Z]{2}$'),
  ibge          text check (ibge is null or ibge ~ '^[0-9]{7}$'),   -- código do município (a NFS-e pede)
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- ---------- talhões da conta: o resumo para a lista e o mapa (o projeto inteiro fica no Storage) ----------
create table if not exists public.talhoes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  chave         text not null check (chave ~ '^[0-9a-f]{12,64}$'),   -- o mesmo arquivo de origem = o mesmo talhão
  codigo        text not null check (char_length(codigo) <= 12),
  nome          text not null check (char_length(nome) <= 120),
  area_hash     text check (area_hash is null or area_hash ~ '^[0-9a-f]{64}$'),  -- liga com compras.area_hash
  ha            numeric(12,2),
  centro        double precision[] check (centro is null or array_length(centro, 1) = 2),
  contorno      jsonb check (contorno is null or pg_column_size(contorno) < 60000),  -- divisa simplificada (lon, lat)
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (user_id, chave)
);
create index if not exists talhoes_user_idx on public.talhoes (user_id, atualizado_em desc);
create index if not exists talhoes_area_idx on public.talhoes (user_id, area_hash);

-- ---------- segurança: cada conta só vê e mexe no que é dela ----------
alter table public.perfis  enable row level security;
alter table public.talhoes enable row level security;

drop policy if exists "meu cadastro: ler"     on public.perfis;
drop policy if exists "meu cadastro: criar"   on public.perfis;
drop policy if exists "meu cadastro: mudar"   on public.perfis;
create policy "meu cadastro: ler"   on public.perfis for select to authenticated using ((select auth.uid()) = user_id);
create policy "meu cadastro: criar" on public.perfis for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "meu cadastro: mudar" on public.perfis for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "meus talhões: ler"    on public.talhoes;
drop policy if exists "meus talhões: criar"  on public.talhoes;
drop policy if exists "meus talhões: mudar"  on public.talhoes;
drop policy if exists "meus talhões: apagar" on public.talhoes;
create policy "meus talhões: ler"    on public.talhoes for select to authenticated using ((select auth.uid()) = user_id);
create policy "meus talhões: criar"  on public.talhoes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "meus talhões: mudar"  on public.talhoes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "meus talhões: apagar" on public.talhoes for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.perfis, public.talhoes from anon;
grant select, insert, update on public.perfis to authenticated;
grant select, insert, update, delete on public.talhoes to authenticated;
grant all on public.perfis, public.talhoes to service_role;

-- ---------- Storage: o projeto de cada talhão, comprimido, na pasta da própria conta ----------
-- caminho: projetos/<id da conta>/<chave do talhão>.json.gz  (bucket privado, até 2 MB por arquivo)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('projetos', 'projetos', false, 2097152, array['application/gzip'])
on conflict (id) do nothing;

drop policy if exists "projetos: dono lê"    on storage.objects;
drop policy if exists "projetos: dono grava" on storage.objects;
drop policy if exists "projetos: dono troca" on storage.objects;
drop policy if exists "projetos: dono apaga" on storage.objects;
create policy "projetos: dono lê"    on storage.objects for select to authenticated
  using (bucket_id = 'projetos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "projetos: dono grava" on storage.objects for insert to authenticated
  with check (bucket_id = 'projetos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "projetos: dono troca" on storage.objects for update to authenticated
  using (bucket_id = 'projetos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'projetos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "projetos: dono apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'projetos' and (storage.foldername(name))[1] = (select auth.uid())::text);
