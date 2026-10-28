// node tools/exportar-legado.mjs backup-privado.sql manifesto-privado.json [digest-anterior]
import {DatabaseSync} from "node:sqlite";
import {readFileSync,writeFileSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import {exportarLegado,digestLegado} from "./legado.mjs";
const [entrada,saida,anterior]=process.argv.slice(2);
if (!entrada || !saida || realpathSync(entrada)===resolve(saida)) throw new Error("Informe backup e saída privada distintos");
const db=new DatabaseSync(":memory:");
try {
  db.exec(readFileSync(entrada,"utf8"));
  const m=exportarLegado(db,anterior || null);
  writeFileSync(saida,JSON.stringify(m),{encoding:"utf8",mode:0o600,flag:"wx"});
  console.log(JSON.stringify({digest:digestLegado(m),contas:m.contas.length,campanhas:m.campanhas.length,
    compras_pagas:m.contas.reduce((n,c)=>n+c.compras_pagas.length,0)}));
} finally {db.close();}
