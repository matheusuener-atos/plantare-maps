// Entry point exclusivo do ensaio. A aplicação normal não importa este controlador.
import worker from "../pix-worker/src/index.js";
import {hash} from "../pix-worker/src/atos-compras.js";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const resposta=(d,status=200)=>Response.json(d,{status,headers:{"cache-control":"no-store"}});
function igual(a,b){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0}
export default {async fetch(req,env){
  if(new URL(req.url).pathname!=="/__homologacao") return worker.fetch(req,env);
  if(env.AMBIENTE!=="teste"||env.PLANTARE_HOMOLOG_ATIVO!=="1")return resposta({erro:"indisponível"},404);
  const segredo=env.PLANTARE_HOMOLOG_TOKEN;
  if(typeof segredo!=="string"||segredo.length<32||!igual(req.headers.get("authorization")||"","Bearer "+segredo))return resposta({erro:"não autenticado"},401);
  if(req.method!=="POST"||req.headers.has("origin"))return resposta({erro:"somente servidor"},403);
  const corpo=await req.text();if(corpo.length>2048)return resposta({erro:"corpo grande"},413);
  let d;try{d=JSON.parse(corpo)}catch{return resposta({erro:"JSON inválido"},400)}
  if(!d||typeof d!=="object"||Array.isArray(d)||!UUID.test(d.run||""))return resposta({erro:"run inválido"},400);
  const conta="hmg-"+d.run,sub=conta,email="hmg+"+d.run+"@example.test";
  if(d.op==="preparar"){
    const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
    const quando=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("insert into contas(id,atos_sub,email,nome,criado_em) values(?,?,?,?,?) on conflict(atos_sub) do nothing").bind(conta,sub,email,"Pessoa de homologação",quando),
      env.DB.prepare("insert into sessoes(hash,conta_id,criado_em,expira) values(?,?,?,?)").bind(await hash(token),conta,quando,new Date(Date.now()+864e5).toISOString())]);
    return resposta({sub,email,token});
  }
  if(d.op==="estado"){
    const compras=(await env.DB.prepare("select c.id,c.versao,c.dados from atos_compras c join atos_intencoes i on i.id=c.intent_id where i.conta_id=?").bind(conta).all()).results;
    const inbox=(await env.DB.prepare("select x.id,x.ignorado from atos_inbox x join atos_compras c on c.id=x.compra_id join atos_intencoes i on i.id=c.intent_id where i.conta_id=?").bind(conta).all()).results;
    return resposta({compras:compras.map(c=>({id:c.id,versao:c.versao,compra:JSON.parse(c.dados)})),inbox});
  }
  return resposta({erro:"operação desconhecida"},404);
}};
