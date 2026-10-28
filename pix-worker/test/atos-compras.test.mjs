import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {after,test} from 'node:test';
import worker, {hashTalhao} from '../src/index.js';
import {hash} from '../src/atos-compras.js';
import {instalarFalsos} from './falsos.mjs';
import {calcularPreco} from '../src/preco.js';
const original=globalThis.fetch; after(()=>{globalThis.fetch=original});
const ORIG='https://plantare.matheusuener.com.br';
const plano={...JSON.parse(readFileSync(new URL('./plano_arvore.json',import.meta.url))),formatos:{csv:true}};
const polys=plano.polys;
const camadas=['linhas_ab','bordadura','percurso','manobras'];
async function abrir(t) {
  const f=instalarFalsos();t.after(()=>f.db.close());
  f.db.exec(readFileSync(new URL('../migrations/0002_atos_compras.sql',import.meta.url),'utf8'));
  Object.assign(f.env,{AMBIENTE:'teste',ATOS_NOVAS_COMPRAS:'1',ATOS_COBRANCA_ORIGEM:'https://atos-teste.exemplo.workers.dev',
    ATOS_COBRANCA_TOKEN:'segredo-s2s-sintetico-com-mais-de-32-caracteres',ATOS_COMPRAS_SEGREDO:'segredo-evento-sintetico-com-mais-de-32-caracteres'});
  f.ana=f.entrar('ana','ana@example.test');f.beto=f.entrar('beto','beto@example.test');
  f.qs=new Map();f.cs=new Map();f.chamadasAtos=[];
  f.env.ATOS_COBRANCA={async fetch(url,op){
    f.chamadasAtos.push({url,op});if(f.fora)throw new Error('rede');
    const u=new URL(url),b=op.body?JSON.parse(op.body):null;
    assert.equal(op.headers.authorization,'Bearer '+f.env.ATOS_COBRANCA_TOKEN);assert.equal(op.redirect,'manual');
    let r;
    if(u.pathname.endsWith('/orcamentos')){
      if(!f.qs.has(b.intent_id))f.qs.set(b.intent_id,{...b,orcamento_id:'orc-'+crypto.randomUUID(),moeda:'BRL',
        centavos:Math.round(calcularPreco(b.area_cent_ha/100,b.camadas).total*100),tarifa_versao:'v1',cupom:null,
        criado_em:new Date().toISOString(),valido_ate:new Date(Date.now()+900000).toISOString()});
      r=f.qs.get(b.intent_id);
    } else if(u.pathname.endsWith('/checkouts')){
      if(!f.cs.has(b.intent_id)){
        const q=f.qs.get(b.intent_id);f.cs.set(b.intent_id,{...q,schema:'plantare-compra/v1',id:'cmp-'+crypto.randomUUID(),produto:'plantare',
          versao:1,estado:'aguardando',pago_em:null,baixar_ate:null,direito_ativo:false});delete f.cs.get(b.intent_id).valido_ate;
      }
      const c=f.cs.get(b.intent_id);
      r={compra:c,checkout_disponivel:true,checkout_url:f.env.ATOS_COBRANCA_ORIGEM+'/plantare/assinar?compra='+c.id};
    } else r=[...f.cs.values()].find(c=>c.id===u.pathname.split('/').at(-1));
    if(f.transformar)r=f.transformar(structuredClone(r));
    if(f.perder){f.perder=false;throw new Error('resposta perdida depois de persistir')}
    return Response.json(r,{status:f.statusAtos || 200});
  }};
  f.req=async(path,body,{token=f.ana.token,headers={}}={})=>{
    const r=await worker.fetch(new Request('https://pix.plantaremaps.com.br'+path,{method:body===undefined?'GET':'POST',
      headers:{origin:ORIG,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env);
    return {status:r.status,data:await r.json()};
  };
  f.nova=(extra={})=>f.req('/atos/intencoes',{intent_id:'int-'+crypto.randomUUID(),plano:'TESTE',polys,camadas,...extra});
  f.pagar=c=>{Object.assign(c,{versao:c.versao+1,estado:'paga',pago_em:new Date().toISOString(),baixar_ate:new Date(Date.now()+365*864e5).toISOString(),direito_ativo:true});return c};
  f.evento=async(c,extra={},op={})=>{
    const e={id:'plantare:'+c.id+':v'+c.versao,tipo:'compra.atualizada',produto:'plantare',criado:new Date().toISOString(),conta:{sub:c.sub,email:'ana@example.test'},dados:c,...extra};
    const corpo=JSON.stringify(e),ts=Math.floor(Date.now()/1000)+(op.atraso||0);
    const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(f.env.ATOS_COMPRAS_SEGREDO),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const sig=[...new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(ts+'.'+corpo)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const req=new Request('https://pix.plantaremaps.com.br/api/atos/eventos',{method:'POST',headers:{'content-type':'application/json','atos-evento':e.id,'atos-assinatura':`t=${ts},v1=${sig}`,...op.headers},body:corpo});
    const r=await worker.fetch(req,f.env);return {status:r.status,data:await r.json()};
  };
  return f;
}
test('intenção congela dono e escopo medido antes do efeito externo; repetição recupera compra',async t=>{
  const f=await abrir(t),body={intent_id:'int-estavel-0001',sub:'sub-beto',centavos:1};
  const a=await f.nova(body),b=await f.nova(body);
  assert.equal(a.status,200,JSON.stringify(a.data));assert.equal(b.data.compra.id,a.data.compra.id);
  assert.equal(a.data.compra.sub,'sub-ana');assert.notEqual(a.data.orcamento.centavos,1);
  assert.equal(f.sql('select * from atos_intencoes').length,1);assert.equal(f.sql('select * from compras').length,0);
  assert.equal((await f.nova({...body,camadas:['linhas_ab']})).status,409);
});
test('resposta perdida e concorrência recuperam mesma intenção sem Mercado Pago legado',async t=>{
  const f=await abrir(t),body={intent_id:'int-timeout-0001'};f.perder=true;
  assert.equal((await f.nova(body)).status,503);
  const rs=await Promise.all([f.nova(body),f.nova(body)]);
  assert.ok(rs.every(r=>r.status===200),JSON.stringify(rs));assert.equal(rs[0].data.compra.id,rs[1].data.compra.id);
  assert.equal(f.chamadas.filter(c=>c.url.includes('mercadopago')).length,0);
});
test('flag só controla novas intenções; rollback não troca provedor nem permite fallback legado',async t=>{
  const f=await abrir(t),b={intent_id:'int-provedor-0001'};const c=await f.nova(b);assert.equal(c.status,200);
  f.env.ATOS_NOVAS_COMPRAS='0';assert.equal((await f.nova(b)).status,200);assert.equal((await f.nova()).status,503);
  assert.equal((await f.req('/cobranca',{plano:'TESTE',polys,camadas})).status,409);
  f.env.ATOS_NOVAS_COMPRAS='1';f.env.AMBIENTE='producao';assert.equal((await f.nova()).status,503);
});
test('novas centrais exigem conta e identidade local; visitante não muda para central por e-mail',async t=>{
  const f=await abrir(t);
  assert.equal((await f.req('/atos/intencoes',{polys,camadas,intent_id:'int-sem-conta'},{token:null})).status,401);
  const c=await f.nova();
  assert.equal((await f.req('/status/'+c.data.compra.id,undefined,{token:f.beto.token})).status,404);
  assert.equal((await f.req('/status/'+c.data.compra.id,undefined,{token:null,headers:{'x-plantare-acesso':'a'.repeat(48)}})).status,401);
});
test('evento assinado projeta e duplicata não reaplica; versão antiga não ressuscita devolução',async t=>{
  const f=await abrir(t),r=await f.nova(),c=f.cs.get(r.data.intent_id);f.pagar(c);
  const paga=structuredClone(c),e={criado:new Date().toISOString()};
  assert.equal((await f.evento(paga,e)).status,200);assert.equal((await f.evento(paga,e)).status,200);
  Object.assign(c,{versao:3,estado:'devolvida',direito_ativo:false});assert.equal((await f.evento(c)).status,200);
  assert.equal((await f.evento(paga,e)).status,200);
  const s=JSON.parse(f.sql('select dados from atos_compras')[0].dados);assert.equal(s.estado,'devolvida');
  assert.equal(f.sql('select * from atos_inbox').length,2);
});
test('mesmo evento/versão com conteúdo divergente falha atomicamente',async t=>{
  const f=await abrir(t),r=await f.nova(),c=f.cs.get(r.data.intent_id);f.pagar(c);
  const e={criado:new Date().toISOString()};assert.equal((await f.evento(c,e)).status,200);
  const outro={...c,criado_em:new Date(Date.now()-1000).toISOString()};
  assert.equal((await f.evento(outro,e)).status,409);assert.equal(f.sql('select * from atos_inbox').length,1);
  assert.equal(JSON.parse(f.sql('select dados from atos_compras')[0].dados).criado_em,c.criado_em);
});
test('assinatura, idade, produto, sub e escopo divergentes não persistem',async t=>{
  const f=await abrir(t),r=await f.nova(),c=f.cs.get(r.data.intent_id);f.pagar(c);
  for(const extra of [{produto:'outro'},{conta:{sub:'sub-beto'}}])assert.equal((await f.evento(c,extra)).status,400);
  assert.equal((await f.evento(c,{}, {atraso:-301})).status,401);
  assert.equal((await f.evento(c,{}, {headers:{'atos-assinatura':'t=1,v1='+'0'.repeat(64)}})).status,401);
  for(const campos of [{area_hash:'b'.repeat(64)},{centavos:1},{camadas:['linhas_ab']},{sub:'sub-beto'}])assert.ok((await f.evento({...c,...campos},{conta:{sub:campos.sub||c.sub}})).status>=400);
  assert.equal(f.sql('select * from atos_inbox').length,0);
});
test('falha no banco reverte inbox e projeção e reentrega recupera',async t=>{
  const f=await abrir(t),r=await f.nova(),c=f.cs.get(r.data.intent_id);f.pagar(c);
  f.falharSql=/insert into atos_compras/;
  assert.equal((await f.evento(c)).status,503);assert.equal(f.sql('select * from atos_inbox').length,0);
  f.falharSql=null;assert.equal((await f.evento(c)).status,200);assert.equal(f.sql('select versao from atos_compras')[0].versao,2);
});
test('conta apagada não revive por evento nem por novo cadastro com mesmo sub/e-mail',async t=>{
  const f=await abrir(t),r=await f.nova(),c=f.cs.get(r.data.intent_id);f.pagar(c);
  assert.equal((await f.req('/conta/excluir',{confirmar:'EXCLUIR'})).status,200);
  assert.equal((await f.evento(c)).status,200);assert.equal(f.sql('select ignorado from atos_inbox')[0].ignorado,1);
  assert.equal(f.sql('select versao from atos_compras')[0].versao,1);
  f.db.prepare('insert into contas(id,atos_sub,email,criado_em) values(?,?,?,?)').run('nova','sub-ana','ana@example.test',new Date().toISOString());
  const n=f.entrar('nova','ana@example.test');
  assert.equal((await f.req('/status/'+c.id,undefined,{token:n.token})).status,404);
});
test('download consulta Atos e respeita dono, geometria, camadas, prazo e revogação',async t=>{
  const f=await abrir(t),r=await f.nova({camadas:['linhas_ab']}),c=f.cs.get(r.data.intent_id);f.pagar(c);
  const body={pedido:c.id,entrada:plano};
  const ok=await f.req('/pacote',body);assert.equal(ok.status,200,JSON.stringify(ok.data));assert.ok(ok.data.arquivos.some(a=>a.name.endsWith('.csv')&&Buffer.from(a.b64,'base64').length>20));
  assert.equal(f.sql('select downloads from atos_compras')[0].downloads,1);
  assert.equal((await f.req('/pacote',body,{token:f.beto.token})).status,404);
  assert.equal((await f.req('/pacote',{...body,entrada:{...plano,camadas:['bordadura']}})).status,403);
  assert.equal((await f.req('/pacote',{...body,entrada:{...plano,polys:[{outer:[[1,1],[2,1],[2,2]],holes:[]}]}})).status,403);
  f.fora=true;assert.equal((await f.req('/pacote',body)).status,503);f.fora=false;
  Object.assign(c,{versao:3,estado:'devolvida',direito_ativo:false});assert.equal((await f.req('/pacote',body)).status,403);
  assert.equal(f.sql('select downloads from atos_compras')[0].downloads,1);
});
test('prazo central absoluto independe do prazo legado e não se renova em consulta',async t=>{
  const f=await abrir(t),r=await f.nova(),c=f.cs.get(r.data.intent_id);f.pagar(c);
  c.pago_em=new Date(Date.now()-366*864e5).toISOString();c.baixar_ate=new Date(Date.now()-864e5).toISOString();f.env.REBAIXAR_DIAS='0';
  assert.equal((await f.req('/pacote',{pedido:c.id,entrada:plano})).status,403);
});
test('devolução recebida durante GET antigo vence e bloqueia entrega',async t=>{
  const f=await abrir(t),r=await f.nova(),c=f.cs.get(r.data.intent_id);f.pagar(c);
  assert.equal((await f.evento(c)).status,200);
  const fetch=f.env.ATOS_COBRANCA.fetch;
  f.env.ATOS_COBRANCA.fetch=async(...args)=>{
    const resposta=await fetch(...args);
    Object.assign(c,{versao:3,estado:'devolvida',direito_ativo:false});assert.equal((await f.evento(c)).status,200);
    return resposta;
  };
  assert.equal((await f.req('/pacote',{pedido:c.id,entrada:plano})).status,403);
});
test('listagem combinada pagina compras centrais e legadas sem truncar nem misturar donos',async t=>{
  const f=await abrir(t);for(let n=0;n<3;n++)assert.equal((await f.nova()).status,200);
  f.db.prepare(`insert into compras(id,conta_id,email,plano,area_hash,ha,camadas,valor,status,criado_em,pago_em)
    values('LEGADO123','ana','ana@example.test','TESTE',?,10,'["linhas_ab"]',60,'pago',?,?)`).run('a'.repeat(64),new Date().toISOString(),new Date().toISOString());
  let cursor=null,ids=[];
  do{const r=await f.req('/eu?limite=2'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(r.status,200);ids.push(...r.data.compras.map(c=>c.id));cursor=r.data.proximo_cursor;
    if(cursor)assert.equal((await f.req('/eu?limite=2&cursor='+encodeURIComponent(cursor),undefined,{token:f.beto.token})).status,400);
  }while(cursor);
  assert.equal(ids.length,4);assert.equal(new Set(ids).size,4);assert.ok(ids.includes('LEGADO123'));
  assert.equal((await f.req('/eu')).data.compras.length,1); // app antigo conserva contrato legado
});
test('snapshot regressivo maior não restaura direito revogado',async t=>{
  const f=await abrir(t),r=await f.nova(),c=f.cs.get(r.data.intent_id);f.pagar(c);await f.evento(c);
  Object.assign(c,{versao:3,direito_ativo:false});await f.evento(c);
  Object.assign(c,{versao:4,direito_ativo:true});assert.equal((await f.evento(c)).status,409);
  assert.equal(f.sql('select versao from atos_compras')[0].versao,3);
});
test('compras legadas da conta e do visitante mantêm IDs, chaves, datas e arquivos com central ligada',async t=>{
  const f=await abrir(t),area=await hashTalhao(polys),chave='ab'.repeat(24),quando=new Date(Date.now()-864e5).toISOString();
  const stmt=f.db.prepare(`insert into compras(id,conta_id,email,acesso_hash,plano,area_hash,ha,camadas,valor,status,criado_em,pago_em)
    values(?,?,?,?,?,?,?,?,?,'pago',?,?)`);
  stmt.run('CORT-CONTA-ANTIGA','ana','ana@example.test',null,'ANTIGO',area,10,JSON.stringify(camadas),0,quando,quando);
  stmt.run('CORT-VISITA-ANTIGA',null,'visita@example.test',await hash(chave),'ANTIGO',area,10,JSON.stringify(camadas),0,quando,quando);
  assert.equal((await f.req('/pacote',{pedido:'CORT-CONTA-ANTIGA',entrada:plano})).status,200);
  assert.equal((await f.req('/pacote',{pedido:'CORT-VISITA-ANTIGA',entrada:plano,acesso:chave},{token:null})).status,200);
  assert.equal((await f.req('/status/CORT-VISITA-ANTIGA',undefined,{token:null,headers:{'x-plantare-acesso':chave}})).status,200);
  assert.equal(f.sql("select pago_em from compras where id='CORT-VISITA-ANTIGA'")[0].pago_em,quando);
  assert.equal(f.sql("select acesso_hash from compras where id='CORT-VISITA-ANTIGA'")[0].acesso_hash,await hash(chave));
});
test('compra paga antes da resposta local é recuperada pelo evento e pelo mesmo checkout',async t=>{
  const f=await abrir(t),original=f.env.ATOS_COBRANCA.fetch;
  f.env.ATOS_COBRANCA.fetch=async(url,op)=>{
    const r=await original(url,op);if(new URL(url).pathname.endsWith('/checkouts')&&!f.perdeuCheckout){f.perdeuCheckout=true;throw new Error('resposta perdida')};return r;
  };
  const b={intent_id:'int-checkout-perdido'};assert.equal((await f.nova(b)).status,503);assert.equal(f.sql('select * from atos_compras').length,0);
  const c=f.cs.get(b.intent_id);f.pagar(c);assert.equal((await f.evento(c)).status,200);
  const r=await f.nova(b);assert.equal(r.status,200);assert.equal(r.data.compra.id,c.id);assert.equal(f.sql('select versao from atos_compras')[0].versao,2);
});
test('redirecionamento externo e orçamento divergente não viram compra ou fallback',async t=>{
  for(const modo of ['redirect','preco','checkout']){
    const f=await abrir(t);
    if(modo==='redirect')f.statusAtos=302;
    else f.transformar=r=>{if(modo==='preco'&&!r.compra)r.area_hash='b'.repeat(64);if(modo==='checkout'&&r.compra)r.checkout_url='https://outro.example/plantare/assinar?compra='+r.compra.id;return r};
    assert.ok((await f.nova()).status>=400,modo);assert.equal(f.compras().length,0);
  }
});
test('cortesia central confirma sem valor e permite somente o escopo concedido',async t=>{
  const f=await abrir(t),original=f.env.ATOS_COBRANCA.fetch;
  f.env.ATOS_COBRANCA.fetch=async(url,op)=>{
    const r=await original(url,op);
    if(new URL(url).pathname.endsWith('/orcamentos')){
      const b=JSON.parse(op.body),q=f.qs.get(b.intent_id);q.centavos=0;q.cupom={codigo:'LIVRE',versao:'v1',tipo:'cortesia',ilimitado:true};return Response.json(q);
    }return r;
  };
  const r=await f.nova({cupom:'LIVRE'});assert.equal(r.status,200,JSON.stringify(r.data));
  const c=f.cs.get(r.data.intent_id);Object.assign(c,{estado:'concedida',versao:2,pago_em:new Date().toISOString(),baixar_ate:new Date(Date.now()+864e5).toISOString(),direito_ativo:true});
  assert.equal((await f.evento(c)).status,200);assert.equal((await f.req('/pacote',{pedido:c.id,entrada:plano})).status,200);
  assert.equal(f.chamadas.filter(x=>x.url.includes('mercadopago')).length,0);
});
