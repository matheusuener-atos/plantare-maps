import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {exportarLegado,digestLegado} from "../tools/legado.mjs";
function abrir(t){
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  db.exec(readFileSync(new URL("../migrations/0001_inicial.sql",import.meta.url),"utf8"));
  db.exec(`insert into contas values ('c-ana','sub-ana','ana@example.test',null,'2026-10-28T00:00:00Z');
    insert into contas values ('c-bia','sub-bia','bia@example.test',null,'2026-10-28T00:00:00Z');
    insert into cupons(codigo,desconto,usos_max,so_primeira,area_min) values('ANTIGO',0.1,2,1,1.25);
    insert into compras(id,conta_id,email,plano,area_hash,ha,camadas,valor,cupom,status,criado_em)
    values('PIX-antigo','c-ana','ana@example.test','plano','${"a".repeat(64)}',2,'["linhas_ab"]',12,'ANTIGO','pago','2026-10-28T00:00:00Z');
    insert into cupom_usos values('ANTIGO','c-ana','ana@example.test','PIX-antigo',1,'2026-10-28T00:00:00Z');`);
  return db;
}
test("exportação: identidade por sub, conta sem compra conferida e regras exatas, sem PII",t=>{
  const db=abrir(t),m=exportarLegado(db);
  assert.deepEqual(m.contas,[{sub:"sub-ana",compras_pagas:["PIX-antigo"]},{sub:"sub-bia",compras_pagas:[]}]);
  const c=m.campanhas.find(c=>c.codigo==="ANTIGO");
  assert.equal(c.config.area_min_cent_ha,125);assert.equal(c.config.desconto_bps,1000);
  assert.equal(c.config.so_primeira,true);assert.equal(c.usos.length,1);
  assert.doesNotMatch(JSON.stringify(m),/example.test|acesso_hash|sessao|cpf|plano/);
  assert.equal(digestLegado(exportarLegado(db)),digestLegado(m));
  const r=exportarLegado(db,digestLegado(m));assert.equal(r.anterior,digestLegado(m));
});
test("exportação: visitante, pendência e dono não conferido bloqueiam",t=>{
  for (const sql of ["update compras set status='pendente'", "update compras set conta_id=null,acesso_hash='visitante'",
    "update compras set conta_id='inexistente'", "update compras set email='outra@example.test'",
    "update contas set email='ana@example.test' where id='c-bia'"]) {
    const db=abrir(t);db.exec(sql);assert.throws(()=>exportarLegado(db),/recusada/);
  }
});
test("exportação: usos órfãos, ausentes, pendentes e regras não representáveis bloqueiam",t=>{
  for (const sql of ["delete from cupom_usos", "update cupom_usos set pago=0", "update cupom_usos set cupom='ORFAO'",
    "update compras set area_hash='invalido'", "update cupons set desconto=0.12345 where codigo='ANTIGO'",
    "update cupons set validade='ontem'", "update cupons set ilimitado=1 where codigo='ANTIGO'"]) {
    const db=abrir(t);db.exec(sql);assert.throws(()=>exportarLegado(db),/recusada/);
  }
});
test("exportação: não arredonda benefício ou área silenciosamente; preserva campanha inativa",t=>{
  const db=abrir(t);db.exec("update cupons set ativo=0 where codigo='ANTIGO'");
  assert.equal(exportarLegado(db).campanhas.find(c=>c.codigo==="ANTIGO").config.ativo,false);
  db.exec("update cupons set area_min=1.234 where codigo='ANTIGO'");
  assert.throws(()=>exportarLegado(db),/recusada/);
});
