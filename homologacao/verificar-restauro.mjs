// Compara export privado com linhas do D1 restaurado e duas cópias do objeto R2.
// node homologacao/verificar-restauro.mjs backup.sql linhas.json antes.gz depois.gz relatorio.json
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import assert from "node:assert/strict";
const [backup,linhas,r2Antes,r2Depois,saida]=process.argv.slice(2);
assert.ok(backup&&linhas&&r2Antes&&r2Depois&&saida,"Informe os cinco caminhos privados");
const db=new DatabaseSync(":memory:");db.exec(readFileSync(backup,"utf8"));
const remoto=JSON.parse(readFileSync(linhas,"utf8"));
const tabelas=["contas","compras","cupons","cupom_usos","perfis","sessoes","talhoes"];
const normal=l=>l.map(r=>JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))))).sort();
const resultado=[];
for(let i=0;i<tabelas.length;i++){
  const tabela=tabelas[i],antes=db.prepare("select * from "+tabela).all(),depois=remoto[i].results;
  assert.deepEqual(normal(depois),normal(antes),"Divergência em "+tabela);
  resultado.push({tabela,linhas:antes.length,conteudo_identico:true});
}
db.close();
const antes=readFileSync(r2Antes),depois=readFileSync(r2Depois),hash=b=>createHash("sha256").update(b).digest("hex");
assert.equal(hash(antes),hash(depois),"Objeto R2 divergente");
const relatorio={data:new Date().toISOString(),d1:resultado,r2:{bytes:antes.length,sha256_identico:true}};
writeFileSync(saida,JSON.stringify(relatorio,null,2),{mode:0o600});
console.log(JSON.stringify({tabelas:resultado.length,conteudo_identico:true,r2_bytes:antes.length,r2_sha256_identico:true}));
