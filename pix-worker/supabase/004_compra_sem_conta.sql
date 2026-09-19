-- Plantare · compra sem conta (visitante)
-- Rode depois do 003, uma vez: Supabase › SQL Editor › New query › cole tudo › Run.
-- Quem não entra na conta também paga e baixa: a compra fica sem user_id e presa a uma chave
-- de acesso que só o navegador de quem pagou guarda (aqui fica só o hash SHA-256 dela).

alter table public.compras alter column user_id drop not null;
alter table public.compras add column if not exists acesso_hash text
  check (acesso_hash is null or acesso_hash ~ '^[0-9a-f]{64}$');

-- toda compra tem dono: uma conta ou uma chave de acesso
alter table public.compras drop constraint if exists compras_tem_dono;
alter table public.compras add constraint compras_tem_dono check (user_id is not null or acesso_hash is not null);

-- a leitura pelo app (RLS "minhas compras") continua só para a própria conta; compras sem conta
-- só são lidas pelo Worker, com a chave de acesso.
