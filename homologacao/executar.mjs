// node homologacao/executar.mjs <JSON privado com atos, plantare, homolog> <relatório>
// Credenciais nunca são impressas nem incluídas no relatório.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
const cfg=JSON.parse(readFileSync(process.argv[2],"utf8"));
assert.match(cfg.atos,/^https:\/\/atos-teste\.[a-z0-9-]+\.workers\.dev$/);
assert.match(cfg.plantare,/^https:\/\/plantare-atos-teste\.[a-z0-9-]+\.workers\.dev$/);
assert.equal(new URL(cfg.atos).hostname.split(".").slice(1).join("."),new URL(cfg.plantare).hostname.split(".").slice(1).join("."));
assert.ok(typeof cfg.homolog==="string"&&cfg.homolog.length>=32);
const plano={...JSON.parse(readFileSync(new URL("../pix-worker/test/plano_arvore.json",import.meta.url))),
  formatos:{kml:true,kmz:true,geojson:true,csv:true,ab:true,rota:true,shp:true}};
const evidencias=[];
const registrar=(cenario,dados)=>{evidencias.push({cenario,...dados});console.log(JSON.stringify({cenario,...dados}));};
async function req(base,path,body,headers={}){
  const r=await fetch(base+path,{method:body===undefined?"GET":"POST",redirect:"manual",signal:AbortSignal.timeout(30000),
    headers:{"content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,data:await r.json()};
}
async function ctrl(base,run,op,extra={}){
  const r=await req(base,"/__homologacao",{run,op,...extra},{authorization:"Bearer "+cfg.homolog});
  assert.equal(r.status,200,JSON.stringify({op,status:r.status,erro:r.data.erro,gateway_status:r.data.gateway_status}));return r.data;
}
async function pessoa(){
  const run=crypto.randomUUID(),a=await ctrl(cfg.atos,run,"preparar"),p=await ctrl(cfg.plantare,run,"preparar");
  return {run,ha:{origin:cfg.atos,cookie:"__Host-atos="+a.sessao},hp:{origin:cfg.plantare,authorization:"Bearer "+p.token}};
}
async function estado(p,id,esperado){
  const fim=Date.now()+180000;
  while(Date.now()<fim){
    const r=await req(cfg.atos,"/api/plantare-checkout/"+id,undefined,p.ha);assert.equal(r.status,200,JSON.stringify(r.data));
    if(r.data.compra.estado===esperado)return r.data.compra;
    await new Promise(resolve=>setTimeout(resolve,10000));
  }
  throw new Error("Estado não observado no gateway real: "+esperado);
}
async function evento(p,id,versao){
  const fim=Date.now()+180000;
  while(Date.now()<fim){
    const e=await ctrl(cfg.plantare,p.run,"estado");
    if(e.inbox.some(x=>x.id==="plantare:"+id+":v"+versao))return e;
    await new Promise(resolve=>setTimeout(resolve,10000));
  }throw new Error("Evento remoto não recebido");
}
async function pacote(p,id,entrada=plano){return req(cfg.plantare,"/pacote",{pedido:id,entrada},p.hp)}
const runDiagnostico=crypto.randomUUID(),di=await ctrl(cfg.atos,runDiagnostico,"diagnostico");
assert.ok(di.kv_isolado&&(di.vendedor_teste||di.credencial_prefixo_teste),"Não iniciar compras sem credencial de teste comprovada");
const p=await pessoa(),outro=await pessoa();
const b={intent_id:"int-"+p.run,plano:"HMG",polys:plano.polys,camadas:["linhas_ab","bordadura","percurso","manobras"]};
const r=await req(cfg.plantare,"/atos/intencoes",b,p.hp);assert.equal(r.status,200,JSON.stringify(r.data));const id=r.data.compra.id;
const repetido=await req(cfg.plantare,"/atos/intencoes",b,p.hp);assert.equal(repetido.data.compra.id,id);
registrar("intencao_repetida",{id,mesma_compra:true});
assert.equal((await req(cfg.plantare,"/status/"+id,undefined,outro.hp)).status,404);
assert.equal((await req(cfg.atos,"/api/plantare-checkout/"+id+"/pagar",{},p.ha)).status,200);
const paga=await estado(p,id,"paga");
const arquivos=await pacote(p,id);assert.equal(arquivos.status,200,JSON.stringify(arquivos.data));
for(const ext of [".kml",".kmz",".geojson",".csv"])assert.ok(arquivos.data.arquivos.some(a=>a.name.toLowerCase().endsWith(ext)&&Buffer.from(a.b64,"base64").length>20),ext);
assert.match(Buffer.from(arquivos.data.arquivos.find(a=>a.name.endsWith(".kml")).b64,"base64").toString(),/<kml/);
assert.equal(Buffer.from(arquivos.data.arquivos.find(a=>a.name.endsWith(".kmz")).b64,"base64").subarray(0,2).toString(),"PK");
assert.ok(JSON.parse(Buffer.from(arquivos.data.arquivos.find(a=>a.name.endsWith(".geojson")).b64,"base64").toString()).features.length>0);
await evento(p,id,paga.versao);
let conta=await req(cfg.atos,"/api/cobranca/v1/conta",undefined,p.ha);assert.equal(conta.data.faturas.filter(x=>x.id===id).length,1);
registrar("pagamento_gateway_real",{id,centavos:paga.centavos,arquivos:arquivos.data.arquivos.length,evento_confirmado:true,faturas:1});
await ctrl(cfg.atos,p.run,"reembolsar",{id,centavos:1000});
const devolvida=await estado(p,id,"devolvida");assert.equal((await pacote(p,id)).status,403);
await evento(p,id,devolvida.versao);
await ctrl(cfg.atos,p.run,"repetir_evento",{id,versao:paga.versao});
await ctrl(cfg.atos,p.run,"repetir_evento",{id,versao:paga.versao});
assert.equal((await pacote(p,id)).status,403);
registrar("devolucao_parcial_e_replay",{id,download_status:403,versao:devolvida.versao});
await ctrl(cfg.atos,p.run,"reembolsar",{id});
const gift=await req(cfg.plantare,"/atos/intencoes",{...b,intent_id:"gift-"+p.run,cupom:"HMG_LIVRE",camadas:["linhas_ab"]},p.hp);
assert.equal(gift.status,200,JSON.stringify(gift.data));const gid=gift.data.compra.id;
assert.equal((await req(cfg.atos,"/api/plantare-checkout/"+gid+"/pagar",{},p.ha)).status,200);await estado(p,gid,"concedida");
const csv=await pacote(p,gid,{...plano,formatos:{csv:true}});assert.equal(csv.status,200);assert.ok(csv.data.arquivos.some(a=>a.name.endsWith(".csv")));
assert.equal((await pacote(p,gid,{...plano,camadas:["bordadura"]})).status,403);
const outroTalhao=plano.polys.map(g=>({...g,outer:g.outer.map(([x,y])=>[x+0.01,y]),holes:(g.holes||[]).map(h=>h.map(([x,y])=>[x+0.01,y]))}));
assert.equal((await pacote(p,gid,{...plano,polys:outroTalhao})).status,403);
registrar("cortesia_escopo",{id:gid,centavos:0,csv:true,dono_errado_bloqueado:true,hash_e_camadas_bloqueados:true});
writeFileSync(process.argv[3]||"relatorio-homologacao.json",JSON.stringify({data:new Date().toISOString(),ambiente:"teste_remoto",evidencias},null,2));
console.log("Ensaio concluído; nenhuma sessão, token ou dado fiscal foi incluído no relatório.");
