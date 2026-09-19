import worker, { assinaturaValida, hashTalhao } from '../src/index.js';
import { calcularPreco, areaPoligonos } from '../src/preco.js';
import { gerarPacote } from '../src/exportar.js';
import { instalarFalsos } from './falsos.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
let ok = 0; const t = async (n, f) => { await f(); ok++; console.log('✓', n); };
const F = instalarFalsos(), env = F.env;
const ORIG = 'https://plantare.matheusuener.com.br';
// quadrado de ~1 km x ~1 km → ~100 ha
const d = 1000 / 111320, quad = [[-55, -12], [-55 + d / Math.cos(12 * Math.PI / 180), -12], [-55 + d / Math.cos(12 * Math.PI / 180), -12 + d], [-55, -12 + d]];
const polys = [{ outer: quad, holes: [] }];
const req = (path, body, o) => { o = o || {};
  const h = { 'content-type': 'application/json' }; if (o.orig !== null) h.origin = o.orig || ORIG; if (o.token) h.authorization = 'Bearer ' + o.token;
  return new Request('https://pix.matheusuener.com.br' + path, { method: o.metodo || (body ? 'POST' : 'GET'), headers: h, body: body ? JSON.stringify(body) : undefined }); };
const chama = async (path, body, o) => { const r = await worker.fetch(req(path, body, o), env); return { st: r.status, j: await r.json().catch(() => null), r }; };
F.entrar('tok-ana-0123456789abcdef', 'u-ana', 'ana@fazenda.com.br');
F.entrar('tok-beto-0123456789abcdef', 'u-beto', 'beto@fazenda.com.br');
const ANA = { token: 'tok-ana-0123456789abcdef' }, BETO = { token: 'tok-beto-0123456789abcdef' };
F.cupons.push({ codigo: 'CAMPO10', desconto: 0.10, usos_max: 100, so_primeira: false, ativo: true });
F.cupons.push({ codigo: 'BEMVINDO30', desconto: 0.30, validade: new Date(Date.now() + 30 * 864e5).toISOString(), ativo: true });
F.cupons.push({ codigo: 'VENCIDO', desconto: 0.30, validade: new Date(Date.now() - 864e5).toISOString(), ativo: true });
F.cupons.push({ codigo: 'PRIMEIRA', desconto: 0.20, usos_max: null, so_primeira: true, ativo: true });
F.cupons.push({ codigo: 'UNICO', desconto: 0.15, usos_max: 1, so_primeira: false, ativo: true });
F.cupons.push({ codigo: 'GRANDE', desconto: 0.05, area_min: 500, ativo: true });
F.cupons.push({ codigo: 'FIXO2', fixo: 2, ativo: true });
F.cupons.push({ codigo: 'AMIGO', gratis: true, usos_max: 5, ativo: true });
const plano = JSON.parse(fs.readFileSync(new URL('./plano_arvore.json', import.meta.url)));
const TODAS = ['linhas_ab', 'bordadura', 'percurso', 'manobras'];

// ---------- tabela ----------
await t('tabela: tudo 93,5 ha = R$ 935,00', () => { assert.equal(calcularPreco(93.5, TODAS).total, 935); });
await t('tabela: só linhas AB cai no mínimo R$ 6/ha', () => { const p = calcularPreco(18.7, ['linhas_ab']); assert.equal(p.porHa, 6); assert.equal(p.total, 112.2); assert.ok(p.minimoAplicado); });
await t('tabela: monitor (AB+B+P) 18,7 ha = R$ 168,30', () => { assert.equal(calcularPreco(18.7, ['linhas_ab', 'bordadura', 'percurso']).total, 168.3); });
await t('tabela: desconto por faixa 575 ha tudo = R$ 5.200', () => { assert.equal(calcularPreco(575, TODAS).total, 5200); });
await t('tabela: 1.200 ha tudo = R$ 9.400', () => { assert.equal(calcularPreco(1200, TODAS).total, 9400); });
await t('área geodésica do quadrado ≈ 100 ha', () => { const ha = areaPoligonos(polys) / 1e4; assert.ok(Math.abs(ha - 100) < 1, ha); });

// ---------- acesso ----------
await t('origem estranha é barrada', async () => { assert.equal((await chama('/preco', { polys, camadas: ['linhas_ab'] }, { orig: 'https://golpe.com' })).st, 403); });
await t('preflight CORS aceita authorization', async () => { const { r } = await chama('/cobranca', null, { metodo: 'OPTIONS' }); assert.equal(r.status, 204); assert.match(r.headers.get('access-control-allow-headers'), /authorization/); });
await t('/cobranca sem conta → 401', async () => { assert.equal((await chama('/cobranca', { plano: 'x', polys, camadas: ['linhas_ab'] })).st, 401); });
await t('/cobranca com token falso → 401', async () => { assert.equal((await chama('/cobranca', { plano: 'x', polys, camadas: ['linhas_ab'] }, { token: 'tok-invalido-0123456789abcdef' })).st, 401); });
await t('/eu mostra só compras pagas da conta', async () => { const { st, j } = await chama('/eu', null, ANA); assert.equal(st, 200); assert.equal(j.email, 'ana@fazenda.com.br'); assert.deepEqual(j.compras, []); });

// ---------- preço e cupom ----------
await t('talhão com 1.229 partes (dessecação) é aceito', async () => {
  const muitos = []; for (let i = 0; i < 1229; i++) { const x = -55 + (i % 40) * 0.001, y = -12 + Math.floor(i / 40) * 0.001; muitos.push({ outer: [[x, y], [x + 0.0004, y], [x + 0.0004, y + 0.0004], [x, y + 0.0004]], holes: [] }); }
  const { st, j } = await chama('/preco', { polys: muitos, camadas: ['linhas_ab'] }); assert.equal(st, 200, JSON.stringify(j)); assert.ok(j.preco.ha > 1); });
await t('talhão com 200 mil pontos é aceito; acima de 300 mil, recusado com mensagem clara', async () => {
  const anel = n => { const r = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; r.push([-55 + Math.cos(a) * 0.01, -12 + Math.sin(a) * 0.01]); } return r; };
  assert.equal((await chama('/preco', { polys: [{ outer: anel(200000), holes: [] }], camadas: ['linhas_ab'] })).st, 200);
  const { st, j } = await chama('/preco', { polys: [{ outer: anel(300001), holes: [] }], camadas: ['linhas_ab'] }); assert.equal(st, 400); assert.match(j.motivo, /grande demais/); });
await t('talhão com 5 mil partes é aceito', async () => {
  const muitos = []; for (let i = 0; i < 5000; i++) { const x = -55 + (i % 100) * 0.001, y = -12 + Math.floor(i / 100) * 0.001; muitos.push({ outer: [[x, y], [x + 0.0004, y], [x + 0.0004, y + 0.0004], [x, y + 0.0004]], holes: [] }); }
  assert.equal((await chama('/preco', { polys: muitos, camadas: ['linhas_ab'] })).st, 200); });
await t('/preco ignora área mandada pelo navegador', async () => { const { j } = await chama('/preco', { polys, camadas: ['linhas_ab'], area_ha: 1 }); assert.ok(j.preco.ha > 99); });
await t('/preco: cupom sem conta não vale', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'campo10' }); assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /Entre/); assert.equal(j.preco.cupom, 0); });
await t('/preco: cupom com conta vale', async () => { const { j } = await chama('/preco', { polys, camadas: ['linhas_ab', 'bordadura', 'percurso'], cupom: 'campo10' }, ANA);
  assert.ok(j.cupom.valido); assert.equal(j.preco.total, Math.round(j.preco.subtotal * 0.9 * 100) / 100); });
await t('/preco: cupom de área mínima', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'GRANDE' }, ANA); assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /500/); });
await t('/preco: cupom com validade devolve a data', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'bemvindo30' }, ANA);
  assert.ok(j.cupom.valido); assert.equal(j.cupom.desconto, 0.3); assert.ok(Date.parse(j.cupom.validade) > Date.now()); });
await t('/preco: cupom vencido explica o motivo', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'VENCIDO' }, ANA); assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /venceu/); });
await t('/preco: cupom inexistente', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'NADA' }, ANA); assert.equal(j.cupom.valido, false); });

// ---------- cobrança ----------
let pedido1;
await t('/cobranca cria Pix com preço do servidor e e-mail da conta', async () => {
  const { st, j } = await chama('/cobranca', { plano: '4K4D1L', polys, camadas: ['linhas_ab', 'bordadura', 'percurso'], email: 'outro@x.com', valor: 1 }, ANA);
  assert.equal(st, 200, JSON.stringify(j)); pedido1 = j.id; const o = F.orders[j.id];
  assert.equal(o.payer.email, 'ana@fazenda.com.br'); assert.equal(o.total_amount, j.valor.toFixed(2)); assert.ok(j.valor > 850);
  const c = F.compras.find(x => x.id === j.id); assert.equal(c.user_id, 'u-ana'); assert.equal(c.status, 'pendente'); assert.equal(c.area_hash, await hashTalhao(polys)); });
await t('/cobranca só com arquivos grátis', async () => { assert.equal((await chama('/cobranca', { plano: 'x', polys, camadas: [] }, ANA)).st, 400); });
await t('/cobranca polígono inválido', async () => { assert.equal((await chama('/cobranca', { plano: 'x', polys: [{ outer: [[999, 0], [1, 1]] }], camadas: ['linhas_ab'] }, ANA)).st, 400); });
await t('/status de compra de outra conta → 404', async () => { assert.equal((await chama('/status/' + pedido1, null, BETO)).st, 404); });
await t('/status ainda não pago', async () => { const { j } = await chama('/status/' + pedido1, null, ANA); assert.equal(j.pago, false); });
await t('/pacote antes de pagar → 402', async () => { assert.equal((await chama('/pacote', { pedido: pedido1, entrada: Object.assign({}, plano, { polys }) }, ANA)).st, 402); });
await t('/status pago grava no banco', async () => { F.pagar(pedido1); const { j } = await chama('/status/' + pedido1, null, ANA);
  assert.ok(j.pago); assert.deepEqual(j.camadas, ['linhas_ab', 'bordadura', 'percurso']); assert.equal(F.compras.find(x => x.id === pedido1).status, 'pago'); });

// ---------- cupom por conta ----------
await t('cupom: 1ª compra com PRIMEIRA vale para o Beto', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO); assert.ok(j.cupom.valido); });
await t('cupom: PRIMEIRA não vale para quem já comprou', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'PRIMEIRA' }, ANA); assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /primeira/); });
let pixA, pixB;
await t('cupom: gerar outro Pix com o mesmo cupom cancela o anterior', async () => {
  pixA = (await chama('/cobranca', { plano: 'B1', polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO)).j.id;
  pixB = (await chama('/cobranca', { plano: 'B1', polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO)).j.id;
  assert.notEqual(pixA, pixB); assert.equal(F.orders[pixA].status, 'canceled'); assert.equal(F.compras.find(x => x.id === pixA).status, 'cancelado');
  assert.equal(F.usos.filter(u => u.user_id === 'u-beto').length, 1); });
await t('cupom: depois de pago, não vale de novo na mesma conta', async () => {
  F.pagar(pixB); await chama('/status/' + pixB, null, BETO);
  const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO); assert.equal(j.cupom.valido, false);
  assert.equal((await chama('/cobranca', { plano: 'B2', polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO)).st, 400); });
await t('cupom: usos_max conta contas diferentes', async () => {
  const p = (await chama('/cobranca', { plano: 'U1', polys, camadas: ['linhas_ab'], cupom: 'UNICO' }, ANA)).j.id; F.pagar(p); await chama('/status/' + p, null, ANA);
  const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'UNICO' }, BETO); assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /acabaram/); });

// ---------- cupons de preço fixo e cortesia ----------
await t('tabela: cupom de preço fixo nunca passa do preço normal', () => { assert.equal(calcularPreco(100, ['linhas_ab'], { fixo: 2 }).total, 2); assert.equal(calcularPreco(0.2, ['manobras'], { fixo: 2 }).total, 1.2); });
await t('valor {"gratis":"sim"} não vira cortesia', () => { assert.ok(calcularPreco(10, ['linhas_ab'], { gratis: 'sim' }).total > 0); });
await t('/cobranca com cupom de preço fixo cobra R$ 2,00', async () => { const { st, j } = await chama('/cobranca', { plano: 'F1', polys, camadas: ['linhas_ab'], cupom: 'fixo2' }, BETO);
  assert.equal(st, 200, JSON.stringify(j)); assert.equal(F.orders[j.id].total_amount, '2.00'); assert.equal(F.orders[j.id].transactions.payments[0].amount, '2.00'); assert.equal(j.cupom.fixo, 2); });
await t('/cobranca com cupom de cortesia não chama o Mercado Pago', async () => { const n = Object.keys(F.orders).length;
  const { st } = await chama('/cobranca', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' }, BETO); assert.equal(st, 400); assert.equal(Object.keys(F.orders).length, n); });
const enviados = []; const envEmail = Object.assign({}, env, { AVISO_EMAIL: 'dono@exemplo.com', EMAIL: { send: async m => { enviados.push(m); return { messageId: 'm' + enviados.length }; } } });
const chamaE = async (path, body, o, e) => { const r = await worker.fetch(req(path, body, o), e || envEmail); return { st: r.status, j: await r.json().catch(() => null) }; };
let cort;
await t('/cortesia exige conta', async () => { assert.equal((await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' })).st, 401); });
await t('/cortesia registra compra de R$ 0 na conta, manda recibo e cópia', async () => { const n = Object.keys(F.orders).length;
  const { st, j } = await chamaE('/cortesia', { plano: '1LKP5C', polys: plano.polys, camadas: ['linhas_ab', 'bordadura'], cupom: 'amigo', email: 'outro@x.com' }, ANA);
  assert.equal(st, 200, JSON.stringify(j)); cort = j.id; assert.match(cort, /^CORT-/); assert.equal(j.recibo, true); assert.equal(Object.keys(F.orders).length, n);
  const c = F.compras.find(x => x.id === cort); assert.equal(c.status, 'pago'); assert.equal(c.valor, 0); assert.equal(c.user_id, 'u-ana');
  assert.equal(enviados[0].to, 'ana@fazenda.com.br'); assert.equal(enviados[1].to, 'dono@exemplo.com'); assert.match(enviados[1].subject, /AMIGO/); assert.match(enviados[0].text, /#1LKP5C/); });
await t('/cortesia: mesma conta não usa duas vezes', async () => { const { st, j } = await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' }, ANA); assert.equal(st, 400); assert.match(j.motivo, /já usou/); });
await t('/cortesia recusa cupom que não é de cortesia', async () => { for (const cupom of ['FIXO2', 'CAMPO10', 'NADA']) assert.equal((await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom }, BETO)).st, 400, cupom); });
await t('/cortesia: e-mail falhando não impede o download', async () => {
  F.entrar('tok-caio-0123456789abcdef', 'u-caio', 'caio@x.com');
  const { st, j } = await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' }, { token: 'tok-caio-0123456789abcdef' }, Object.assign({}, env, { EMAIL: { send: async () => { throw Object.assign(new Error('x'), { code: 'E_SENDER_NOT_VERIFIED' }); } } }));
  assert.equal(st, 200); assert.equal(j.recibo, false); });
await t('/cortesia de origem estranha é barrada', async () => { assert.equal((await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' }, Object.assign({ orig: 'https://golpe.com' }, ANA))).st, 403); });

// ---------- Pix assíncrono, teste, referência ----------
await t('referência só com letras, números e -', async () => { const o = F.orders[pedido1]; assert.match(o.external_reference, /^plantare-4K4D1L-ABP-\d+$/); });
await t('/cobranca com PAGADOR_TESTE manda first_name APRO', async () => { const r = await worker.fetch(req('/cobranca', { plano: 'T', polys, camadas: ['linhas_ab'] }, BETO), Object.assign({}, env, { PAGADOR_TESTE: 'APRO' }));
  const j = await r.json(); assert.equal(F.orders[j.id].payer.first_name, 'APRO'); assert.equal(F.orders[pedido1].payer.first_name, undefined); });
await t('criação assíncrona: /cobranca sem QR, /status traz o QR depois', async () => {
  const c = (await chama('/cobranca', { plano: 'ASYNC', polys, camadas: ['linhas_ab'] }, BETO)).j; assert.equal(c.status, 'processing'); assert.equal(c.qr_code, null);
  const s = (await chama('/status/' + c.id, null, BETO)).j; assert.equal(s.pago, false); assert.equal(s.encerrado, false); assert.match(s.qr_code, /^000201PIX/); assert.ok(s.expira); });
await t('/status de order vencida avisa encerrado', async () => { const c = (await chama('/cobranca', { plano: 'V', polys, camadas: ['linhas_ab'] }, BETO)).j; F.orders[c.id].status = 'expired';
  const s = (await chama('/status/' + c.id, null, BETO)).j; assert.equal(s.pago, false); assert.equal(s.encerrado, true); assert.equal(F.compras.find(x => x.id === c.id).status, 'expirado'); });
await t('/status pago não repete o QR', async () => { const s = (await chama('/status/' + pedido1, null, ANA)).j; assert.equal(s.qr_code, undefined); assert.equal(s.encerrado, false); });

// ---------- entrega ----------
const entradaBoa = Object.assign({}, plano, { formatos: { kml: 1, kmz: 1, ab: 1, rota: 1, shp: 1, geojson: 1, csv: 1 } });
let pedidoArvore;
await t('/pacote: talhão diferente do pago → 403', async () => {
  const { st, j } = await chama('/pacote', { pedido: pedido1, entrada: entradaBoa }, ANA); assert.equal(st, 403); assert.match(j.motivo, /outro talhão/); });
await t('/pacote: entrega só as camadas pagas, carimbadas', async () => {
  pedidoArvore = (await chama('/cobranca', { plano: 'ARV1', polys: plano.polys, camadas: ['linhas_ab', 'bordadura'] }, ANA)).j.id; F.pagar(pedidoArvore);
  const { st, j } = await chama('/pacote', { pedido: pedidoArvore, entrada: entradaBoa }, ANA);
  assert.equal(st, 200, JSON.stringify(j).slice(0, 300));
  const nomes = j.arquivos.map(a => a.name);
  assert.ok(nomes.some(n => n.endsWith('_ab.kmz')), 'AB'); assert.ok(!nomes.some(n => n.endsWith('_rota.kmz')), 'sem rota');
  assert.ok(!nomes.some(n => /pulverizacao\.kml$/.test(n)), 'sem KML completo'); assert.ok(!nomes.some(n => n.endsWith('.geojson')));
  assert.ok(nomes.some(n => /linhas_ab_utm\.shp$/.test(n)) && nomes.some(n => /bordadura_wgs84\.shp$/.test(n)));
  assert.ok(!nomes.some(n => /manobras|percurso|tudo/.test(n)), 'shp só das camadas pagas');
  assert.ok(nomes.includes('LICENCA.txt')); for (const k of ['geojson', 'kml', 'kmz', 'rota']) assert.ok(j.negados.includes(k), k); assert.ok(j.negados.filter(k => k.startsWith('shp:')).every(k => !/bordadura|linhas_ab/.test(k)));
  const ab = Buffer.from(j.arquivos.find(a => a.name.endsWith('_ab.kml')).b64, 'base64').toString(); assert.match(ab, /Licenciado a ana@fazenda\.com\.br · pedido /);
  assert.equal(F.compras.find(x => x.id === pedidoArvore).downloads, 1); });
await t('/pacote: cortesia também libera os arquivos', async () => { const { st, j } = await chama('/pacote', { pedido: cort, entrada: entradaBoa }, ANA); assert.equal(st, 200); assert.ok(j.arquivos.some(a => a.name.endsWith('_ab.kmz'))); });
await t('/pacote: compra de outra conta → 404', async () => { assert.equal((await chama('/pacote', { pedido: pedidoArvore, entrada: entradaBoa }, BETO)).st, 404); });
await t('/pacote: percurso fora do talhão → 400', async () => {
  const longe = Object.assign({}, entradaBoa, { legs: plano.legs.map(l => Object.assign({}, l, { p: l.p.map(q => [q[0] + 5000, q[1]]) })) });
  const { st, j } = await chama('/pacote', { pedido: pedidoArvore, entrada: longe }, ANA); assert.equal(st, 400); assert.match(j.motivo, /não é deste talhão/); });
await t('/pacote: compra antiga demais', async () => {
  const c = F.compras.find(x => x.id === pedidoArvore), antes = c.pago_em; c.pago_em = new Date(Date.now() - 400 * 864e5).toISOString();
  const { st } = await chama('/pacote', { pedido: pedidoArvore, entrada: entradaBoa }, ANA); c.pago_em = antes; assert.equal(st, 403); });
await t('gerador: pacote completo tem os 38 arquivos do app', () => {
  const r = gerarPacote(entradaBoa, { camadas: TODAS, texto: '' }); assert.equal(r.arquivos.length, 38); assert.deepEqual(r.negados, []); });
await t('gerador: entrada inválida', () => { assert.throws(() => gerarPacote(Object.assign({}, entradaBoa, { legs: [{ t: 'w', p: [[1, 'a']] }] }), { camadas: TODAS }), /inválido/); });
await t('/eu lista as compras pagas', async () => { const { j } = await chama('/eu', null, ANA); const esperadas = F.compras.filter(c => c.user_id === 'u-ana' && c.status === 'pago').map(c => c.id); assert.ok(esperadas.includes(cort)); assert.deepEqual(j.compras.map(c => c.id).sort(), esperadas.sort()); });

// ---------- webhook ----------
const assinar = async (id, rid, ts) => { const man = 'id:' + id.toLowerCase() + ';request-id:' + rid + ';ts:' + ts + ';';
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('segredo'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(man)))].map(b => b.toString(16).padStart(2, '0')).join(''); };
await t('webhook com assinatura certa grava o pagamento', async () => {
  const id = (await chama('/cobranca', { plano: 'W1', polys, camadas: ['linhas_ab'] }, BETO)).j.id; F.pagar(id);
  const v1 = await assinar(id, 'req-1', '1742505638683');
  const r = await worker.fetch(new Request('https://pix.matheusuener.com.br/webhook?data.id=' + id + '&type=order', { method: 'POST', headers: { 'x-signature': 'ts=1742505638683,v1=' + v1, 'x-request-id': 'req-1' }, body: '{}' }), env);
  assert.equal(r.status, 200); assert.equal(F.compras.find(x => x.id === id).status, 'pago'); });
await t('webhook de order desconhecida responde 200 (sem reenvio infinito)', async () => {
  const v1 = await assinar('ORDNAOEXISTE', 'req-2', '1742505638684');
  const r = await worker.fetch(new Request('https://pix.matheusuener.com.br/webhook?data.id=ORDNAOEXISTE&type=order', { method: 'POST', headers: { 'x-signature': 'ts=1742505638684,v1=' + v1, 'x-request-id': 'req-2' }, body: '{}' }), env);
  assert.equal(r.status, 200); });
await t('webhook com assinatura errada', async () => { const r = await worker.fetch(new Request('https://pix.matheusuener.com.br/webhook?data.id=X', { method: 'POST', headers: { 'x-signature': 'ts=1,v1=abc', 'x-request-id': 'r' }, body: '{}' }), env); assert.equal(r.status, 401); });
console.log(ok + ' testes ok');
