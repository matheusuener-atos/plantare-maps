-- Aditiva: não renumera compras, chaves ou datas legadas.
create table atos_intencoes (
  id text primary key,
  conta_id text not null,
  sub text not null,
  provedor text not null default 'atos' check (provedor = 'atos'),
  digest text not null,
  escopo text not null check (json_valid(escopo)),
  plano text not null,
  criado_em text not null,
  orcamento text check (orcamento is null or json_valid(orcamento)),
  apagada integer not null default 0 check (apagada in (0,1))
);
create index atos_intencoes_conta on atos_intencoes(conta_id, id);
create table atos_compras (
  id text primary key,
  intent_id text not null unique references atos_intencoes(id),
  sub text not null,
  versao integer not null check (versao > 0),
  digest text not null,
  dados text not null check (json_valid(dados)),
  downloads integer not null default 0,
  ultimo_download text
);
create table atos_inbox (
  id text primary key,
  compra_id text not null,
  digest text not null,
  recebido_em text not null,
  ignorado integer not null default 0
);
create trigger atos_inbox_conflito before insert on atos_inbox
when exists(select 1 from atos_inbox where id = new.id and digest != new.digest)
begin select raise(abort, 'atos_evento_conflitante'); end;
create trigger atos_compra_conflito before insert on atos_compras
begin
  select case when exists(select 1 from atos_compras where
    (id = new.id and (intent_id != new.intent_id or sub != new.sub or (versao = new.versao and digest != new.digest)))
    or (intent_id = new.intent_id and id != new.id)) then raise(abort, 'atos_compra_conflitante') end;
  select case when exists(select 1 from atos_compras where id = new.id and versao < new.versao and (
    json_extract(dados,'$.criado_em') is not json_extract(new.dados,'$.criado_em')
    or (json_extract(dados,'$.estado') = 'devolvida' and json_extract(new.dados,'$.estado') != 'devolvida')
    or (json_extract(dados,'$.estado') = 'concedida' and json_extract(new.dados,'$.estado') != 'concedida')
    or (json_extract(dados,'$.estado') = 'paga' and json_extract(new.dados,'$.estado') not in ('paga','devolvida'))
    or (json_extract(dados,'$.pago_em') is not null and json_extract(dados,'$.pago_em') is not json_extract(new.dados,'$.pago_em'))
    or (json_extract(dados,'$.baixar_ate') is not null and json_extract(dados,'$.baixar_ate') is not json_extract(new.dados,'$.baixar_ate'))
    or (json_extract(dados,'$.pago_em') is not null and json_extract(dados,'$.direito_ativo') = 0 and json_extract(new.dados,'$.direito_ativo') = 1)
  )) then raise(abort, 'atos_transicao_regressiva') end;
end;
