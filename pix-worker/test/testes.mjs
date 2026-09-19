import worker, { assinaturaValida } from '../src/index.js';
import { calcularPreco, areaPoligonos } from '../src/preco.js';
import assert from 'node:assert/strict';
let ok=0; const t=async(n,f)=>{ await f(); ok++; console.log('✓',n); };
const env={ MP_ACCESS_TOKEN:'token-falso-dos-testes', MP_WEBHOOK_SECRET:'segredo', ORIGENS:'https://plantare.matheusuener.com.br', CUPONS:'{"CAMPO10":0.10,"FIXO2":{"fixo":2},"AMIGO":{"gratis":true}}', EXPIRA:'PT30M' };
const ORIG='https://plantare.matheusuener.com.br';
// quadrado de ~1 km x ~1 km perto do equador → ~100 ha
const d=1000/111320, quad=[[-55,-12],[-55+d/Math.cos(12*Math.PI/180),-12],[-55+d/Math.cos(12*Math.PI/180),-12+d],[-55,-12+d]];
const polys=[{outer:quad, holes:[]}];
const req=(path,body,metodo,orig)=>new Request('https://pix.matheusuener.com.br'+path,{method:metodo||(body?'POST':'GET'),headers:Object.assign({'content-type':'application/json'},orig===null?{}:{origin:orig||ORIG}),body:body?JSON.stringify(body):undefined});
// Mercado Pago falso
let ultimo=null;
globalThis.fetch=async(url,op)=>{ ultimo={url,op};
  if(String(url).endsWith('/v1/orders') && op.method==='POST'){ const b=JSON.parse(op.body);
    if(b.external_reference.startsWith('plantare-ASYNC-')) return new Response(JSON.stringify({id:'ORDASYNC1', status:'processing', status_detail:'in_process', external_reference:b.external_reference, total_amount:b.total_amount, transactions:{payments:[{status:'processing'}]}}),{status:201});
    return new Response(JSON.stringify({id:'ORD01ABC123', status:'action_required', status_detail:'waiting_transfer', external_reference:b.external_reference, total_amount:b.total_amount,
      transactions:{payments:[{payment_method:{id:'pix', qr_code:'000201PIX', qr_code_base64:'iVBOR', ticket_url:'https://mp/ticket'}, date_of_expiration:'2026-09-18T21:00:00Z'}]}}),{status:201}); }
  if(String(url).includes('/v1/orders/ORD01ABC123')) return new Response(JSON.stringify({id:'ORD01ABC123', status:'processed', status_detail:'accredited', external_reference:'plantare-4K4D1L-ABP-10000', total_amount:'900.00'}),{status:200});
  if(String(url).includes('/v1/orders/ORDASYNC1')) return new Response(JSON.stringify({id:'ORDASYNC1', status:'action_required', status_detail:'waiting_transfer', external_reference:'plantare-ASYNC-A-271', total_amount:'16.38',
    transactions:{payments:[{payment_method:{id:'pix', qr_code:'000201ASYNC', qr_code_base64:'iVBORasync', ticket_url:'https://mp/t2'}, date_of_expiration:'2026-09-19T06:30:00Z'}]}}),{status:200});
  if(String(url).includes('/v1/orders/ORDVENCIDA')) return new Response(JSON.stringify({id:'ORDVENCIDA', status:'expired', status_detail:'expired', external_reference:'plantare-X-A-100', total_amount:'6.00'}),{status:200});
  if(String(url).includes('/v1/orders/ORDOUTRO')) return new Response(JSON.stringify({id:'ORDOUTRO', status:'processed', status_detail:'accredited', external_reference:'outra-loja-1'}),{status:200});
  return new Response('{}',{status:404}); };

await t('tabela: tudo 93,5 ha = R$ 935,00', ()=>{ const p=calcularPreco(93.5,['linhas_ab','bordadura','percurso','manobras']); assert.equal(p.total,935); });
await t('tabela: só linhas AB cai no mínimo R$ 6/ha', ()=>{ const p=calcularPreco(18.7,['linhas_ab']); assert.equal(p.porHa,6); assert.equal(p.total,112.2); assert.ok(p.minimoAplicado); });
await t('tabela: monitor (AB+B+P) 18,7 ha = R$ 168,30', ()=>{ assert.equal(calcularPreco(18.7,['linhas_ab','bordadura','percurso']).total,168.3); });
await t('tabela: desconto por faixa 575 ha tudo = R$ 5.200', ()=>{ assert.equal(calcularPreco(575,['linhas_ab','bordadura','percurso','manobras']).total,5200); });
await t('tabela: 1.200 ha tudo = R$ 9.400', ()=>{ assert.equal(calcularPreco(1200,['linhas_ab','bordadura','percurso','manobras']).total,9400); });
await t('tabela: nada pago = 0', ()=>{ assert.equal(calcularPreco(50,[]).total,0); });
await t('área geodésica do quadrado ≈ 100 ha', ()=>{ const ha=areaPoligonos(polys)/1e4; assert.ok(Math.abs(ha-100)<1, ha); });
await t('/preco com cupom', async()=>{ const r=await worker.fetch(req('/preco',{polys,camadas:['linhas_ab','bordadura','percurso'],cupom:'campo10'}),env); const j=await r.json();
  assert.equal(r.status,200); assert.ok(j.cupom.valido); assert.ok(Math.abs(j.preco.subtotal-900)<10); assert.equal(j.preco.total, Math.round(j.preco.subtotal*0.9*100)/100); });
await t('tabela: cupom de preço fixo nunca passa do preço normal', ()=>{ assert.equal(calcularPreco(100,['linhas_ab'],{fixo:2}).total,2); assert.equal(calcularPreco(0.2,['manobras'],{fixo:2}).total,1.2); });
await t('/preco com cupom de preço fixo', async()=>{ const j=await (await worker.fetch(req('/preco',{polys,camadas:['linhas_ab','bordadura'],cupom:'fixo2'}),env)).json();
  assert.ok(j.cupom.valido); assert.equal(j.cupom.fixo,2); assert.equal(j.preco.total,2); });
await t('/cobranca com cupom de preço fixo cobra R$ 2,00', async()=>{ const r=await worker.fetch(req('/cobranca',{plano:'x',polys,camadas:['linhas_ab'],email:'a@b.com',cupom:'FIXO2'}),env);
  assert.equal(r.status,200); const b=JSON.parse(ultimo.op.body); assert.equal(b.total_amount,'2.00'); assert.equal(b.transactions.payments[0].amount,'2.00'); });
await t('/preco com cupom de cortesia zera o preço', async()=>{ const j=await (await worker.fetch(req('/preco',{polys,camadas:['linhas_ab','manobras'],cupom:'amigo'}),env)).json();
  assert.ok(j.cupom.valido); assert.equal(j.cupom.gratis,true); assert.equal(j.preco.total,0); assert.equal(j.preco.gratis,true); });
await t('/cobranca com cupom de cortesia não chama o Mercado Pago', async()=>{ ultimo=null; const r=await worker.fetch(req('/cobranca',{plano:'x',polys,camadas:['linhas_ab'],email:'a@b.com',cupom:'AMIGO'}),env);
  assert.equal(r.status,400); assert.equal(ultimo,null); });
await t('valor {"gratis":"sim"} não vira cortesia', ()=>{ assert.ok(calcularPreco(10,['linhas_ab'],{gratis:'sim'}).total>0); });
const enviados=[]; const envEmail=Object.assign({},env,{AVISO_EMAIL:'dono@exemplo.com', EMAIL:{ send:async m=>{ enviados.push(m); return {messageId:'m'+enviados.length}; } }});
await t('/cortesia confere o cupom, manda recibo e cópia', async()=>{ ultimo=null; const r=await worker.fetch(req('/cortesia',{plano:'1LKP5C',polys,camadas:['linhas_ab'],email:'amigo@x.com',cupom:'amigo'}),envEmail); const j=await r.json();
  assert.equal(r.status,200, JSON.stringify(j)); assert.equal(j.recibo,true); assert.equal(ultimo,null);
  assert.equal(enviados.length,2); assert.equal(enviados[0].to,'amigo@x.com'); assert.equal(enviados[1].to,'dono@exemplo.com'); assert.match(enviados[1].subject,/AMIGO/); assert.match(enviados[0].text,/#1LKP5C/); });
await t('/cortesia recusa cupom que não é de cortesia', async()=>{ for(const cupom of ['FIXO2','CAMPO10','NADA']){ const r=await worker.fetch(req('/cortesia',{plano:'x',polys,camadas:['linhas_ab'],email:'a@b.com',cupom}),envEmail); assert.equal(r.status,400,cupom); } });
await t('/cortesia exige e-mail válido', async()=>{ const r=await worker.fetch(req('/cortesia',{plano:'x',polys,camadas:['linhas_ab'],email:'semarroba',cupom:'AMIGO'}),envEmail); assert.equal(r.status,400); });
await t('/cortesia: e-mail falhando não impede o download', async()=>{ const r=await worker.fetch(req('/cortesia',{plano:'x',polys,camadas:['linhas_ab'],email:'a@b.com',cupom:'AMIGO'}),Object.assign({},env,{EMAIL:{send:async()=>{ throw Object.assign(new Error('x'),{code:'E_SENDER_NOT_VERIFIED'}); }}})); const j=await r.json();
  assert.equal(r.status,200); assert.equal(j.recibo,false); });
await t('/cortesia de origem estranha é barrada', async()=>{ const r=await worker.fetch(req('/cortesia',{plano:'x',polys,camadas:['linhas_ab'],email:'a@b.com',cupom:'AMIGO'},'POST','https://golpe.com'),envEmail); assert.equal(r.status,403); });
await t('cupom inexistente não muda o preço', async()=>{ const j=await (await worker.fetch(req('/preco',{polys,camadas:['linhas_ab'],cupom:'NADA'}),env)).json(); assert.equal(j.cupom.valido,false); assert.ok(j.preco.total>500); });
await t('/preco ignora área mandada pelo navegador', async()=>{ const r=await worker.fetch(req('/preco',{polys,camadas:['linhas_ab'],area_ha:1}),env); const j=await r.json(); assert.ok(j.preco.ha>99); });
await t('origem estranha é barrada', async()=>{ const r=await worker.fetch(req('/preco',{polys,camadas:['linhas_ab']},'POST','https://golpe.com'),env); assert.equal(r.status,403); });
await t('preflight CORS', async()=>{ const r=await worker.fetch(req('/cobranca',null,'OPTIONS'),env); assert.equal(r.status,204); assert.equal(r.headers.get('access-control-allow-origin'),ORIG); });
await t('/cobranca cria order Pix com preço do servidor', async()=>{ const r=await worker.fetch(req('/cobranca',{plano:'4K4D1L',polys,camadas:['linhas_ab','bordadura','percurso'],email:'a@b.com',valor:1}),env); const j=await r.json();
  assert.equal(r.status,200, JSON.stringify(j)); assert.equal(j.qr_code,'000201PIX'); const b=JSON.parse(ultimo.op.body);
  assert.equal(b.transactions.payments[0].payment_method.id,'pix'); assert.equal(b.total_amount, j.valor.toFixed(2)); assert.ok(j.valor>850);
  assert.ok(ultimo.op.headers['x-idempotency-key']); assert.equal(ultimo.op.headers.authorization,'Bearer token-falso-dos-testes'); assert.match(b.external_reference,/^plantare-4K4D1L-ABP-\d+$/); assert.match(b.external_reference,/^[A-Za-z0-9_-]{1,64}$/); });
await t('/cobranca sem PAGADOR_TESTE não manda first_name', async()=>{ assert.equal(JSON.parse(ultimo.op.body).payer.first_name, undefined); });
await t('/cobranca com PAGADOR_TESTE manda first_name APRO', async()=>{ const r=await worker.fetch(req('/cobranca',{plano:'x',polys,camadas:['linhas_ab'],email:'a@b.com'}),Object.assign({},env,{PAGADOR_TESTE:'APRO'}));
  assert.equal(r.status,200); const b=JSON.parse(ultimo.op.body); assert.equal(b.payer.first_name,'APRO'); assert.equal(b.payer.email,'a@b.com'); });
await t('/cobranca sem e-mail', async()=>{ const r=await worker.fetch(req('/cobranca',{plano:'x',polys,camadas:['linhas_ab'],email:''}),env); assert.equal(r.status,400); });
await t('/cobranca só com arquivos grátis', async()=>{ const r=await worker.fetch(req('/cobranca',{plano:'x',polys,camadas:[],email:'a@b.com'}),env); assert.equal(r.status,400); });
await t('/cobranca polígono inválido', async()=>{ const r=await worker.fetch(req('/cobranca',{plano:'x',polys:[{outer:[[999,0],[1,1]]}],camadas:['linhas_ab'],email:'a@b.com'}),env); assert.equal(r.status,400); });
await t('/status pago devolve camadas', async()=>{ const r=await worker.fetch(req('/status/ORD01ABC123'),env); const j=await r.json(); assert.ok(j.pago); assert.deepEqual(j.camadas,['linhas_ab','bordadura','percurso']); assert.equal(j.plano,'4K4D1L'); });
await t('/status pago não repete o QR', async()=>{ const j=await (await worker.fetch(req('/status/ORD01ABC123'),env)).json(); assert.equal(j.qr_code, undefined); assert.equal(j.encerrado, false); });
await t('criação assíncrona: /cobranca sem QR, /status traz o QR depois', async()=>{
  const c=await (await worker.fetch(req('/cobranca',{plano:'ASYNC',polys,camadas:['linhas_ab'],email:'a@b.com'}),env)).json();
  assert.equal(c.ok,true); assert.equal(c.status,'processing'); assert.equal(c.qr_code,null);
  const s=await (await worker.fetch(req('/status/'+c.id),env)).json();
  assert.equal(s.pago,false); assert.equal(s.encerrado,false); assert.equal(s.qr_code,'000201ASYNC'); assert.equal(s.qr_code_base64,'iVBORasync'); assert.equal(s.expira,'2026-09-19T06:30:00Z'); });
await t('/status de order vencida avisa encerrado', async()=>{ const j=await (await worker.fetch(req('/status/ORDVENCIDA'),env)).json(); assert.equal(j.pago,false); assert.equal(j.encerrado,true); });
await t('/status de order de outro sistema', async()=>{ const r=await worker.fetch(req('/status/ORDOUTRO'),env); assert.equal(r.status,404); });
await t('webhook com assinatura certa', async()=>{
  const ts='1742505638683', rid='req-1', id='ORD01ABC123'; const man='id:'+id.toLowerCase()+';request-id:'+rid+';ts:'+ts+';';
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode('segredo'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const v1=[...new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(man)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const r=await worker.fetch(new Request('https://pix.matheusuener.com.br/webhook?data.id='+id+'&type=order',{method:'POST',headers:{'x-signature':'ts='+ts+',v1='+v1,'x-request-id':rid},body:'{}'}),env);
  assert.equal(r.status,200); });
await t('webhook com assinatura errada', async()=>{ const r=await worker.fetch(new Request('https://pix.matheusuener.com.br/webhook?data.id=X',{method:'POST',headers:{'x-signature':'ts=1,v1=abc','x-request-id':'r'},body:'{}'}),env); assert.equal(r.status,401); });
console.log(ok+' testes ok');
