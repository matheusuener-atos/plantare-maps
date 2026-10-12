-- Plantare · banco no Cloudflare D1 (substitui o Supabase)
-- Aplicar:  npx wrangler d1 migrations apply plantare --remote
-- Quem lê e grava é só o Worker. Datas em texto ISO 8601 (UTC); listas e objetos em JSON.

-- ---------- contas: uma por Conta Atos ----------
create table contas (
  id         text primary key,                 -- id do Plantare (c-…), o que as outras tabelas guardam
  atos_sub   text not null unique,             -- o "sub" da Conta Atos (não muda)
  email      text not null,
  nome       text,
  criado_em  text not null
);

-- ---------- sessões: o token que o app guarda (aqui fica só o SHA-256 dele) ----------
create table sessoes (
  hash       text primary key,
  conta_id   text not null,
  criado_em  text not null,
  expira     text not null
);
create index sessoes_conta on sessoes (conta_id);

-- ---------- compras: uma linha por Pix gerado ou cortesia ----------
create table compras (
  id              text primary key,             -- id da order no Mercado Pago (ou CORT-… na cortesia)
  conta_id        text,                         -- vazio: compra sem conta, presa à chave de acesso
  email           text not null,
  acesso_hash     text,                         -- SHA-256 da chave de acesso de quem comprou sem conta
  plano           text not null,                -- #id do plano no app
  area_hash       text not null,                -- impressão digital do talhão cobrado
  ha              real not null,
  camadas         text not null,                -- JSON: ["linhas_ab", ...]
  valor           real not null,
  cupom           text,
  status          text not null default 'pendente' check (status in ('pendente','pago','cancelado','expirado')),
  criado_em       text not null,
  pago_em         text,
  downloads       integer not null default 0,
  ultimo_download text,
  check (conta_id is not null or acesso_hash is not null)
);
create index compras_conta on compras (conta_id, status);
create index compras_area on compras (area_hash);

-- ---------- cupons: crie e edite com  npx wrangler d1 execute plantare --remote --command "…" ----------
create table cupons (
  codigo      text primary key check (codigo = upper(codigo) and length(codigo) between 3 and 32),
  -- um tipo por cupom: desconto (0.10 = 10%), fixo (a compra sai por R$ X) ou gratis (cortesia, baixa sem Pix)
  desconto    real check (desconto is null or (desconto > 0 and desconto <= 0.9)),
  fixo        real check (fixo is null or fixo > 0),
  gratis      integer not null default 0,
  ilimitado   integer not null default 0,       -- não conta uso nenhum (pessoa, talhão, total)
  usos_max    integer check (usos_max is null or usos_max > 0),
  validade    text,                             -- ISO 8601; vazio = não vence
  so_primeira integer not null default 0,
  area_min    real,
  ativo       integer not null default 1,
  criado_em   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  check ((desconto is not null) + (fixo is not null) + (gratis = 1) = 1)
);

-- ---------- uso de cupom: uma vez por pessoa (a conta, ou o e-mail de quem comprou sem conta) ----------
create table cupom_usos (
  cupom      text not null,
  conta_id   text,
  email      text,
  compra_id  text not null,
  pago       integer not null default 0,
  criado_em  text not null,
  check (conta_id is not null or email is not null)
);
create unique index cupom_usos_conta on cupom_usos (cupom, conta_id) where conta_id is not null;
create unique index cupom_usos_email on cupom_usos (cupom, email) where conta_id is null;
create index cupom_usos_compra on cupom_usos (compra_id);

-- ---------- cadastro: dados mínimos para a nota fiscal ----------
create table perfis (
  conta_id      text primary key,
  nome          text not null,
  cpf           text not null,
  whatsapp      text not null,
  cep           text not null,
  logradouro    text not null,
  numero        text not null,
  complemento   text,
  bairro        text not null,
  cidade        text not null,
  uf            text not null,
  ibge          text,
  criado_em     text not null,
  atualizado_em text not null
);

-- ---------- talhões da conta: o resumo para a lista e o mapa (o projeto inteiro fica no R2) ----------
create table talhoes (
  conta_id      text not null,
  chave         text not null,                  -- o mesmo arquivo de origem = o mesmo talhão
  codigo        text not null,
  nome          text not null,
  area_hash     text,                           -- liga com compras.area_hash
  ha            real,
  centro        text,                           -- JSON [lon, lat]
  contorno      text,                           -- JSON: divisa simplificada
  criado_em     text not null,
  atualizado_em text not null,
  primary key (conta_id, chave)
);
create index talhoes_conta on talhoes (conta_id, atualizado_em);

-- ---------- o cupom de cortesia do dono (sem validade, ilimitado) ----------
insert into cupons (codigo, gratis, ilimitado) values ('1SAMUEL712', 1, 1);
