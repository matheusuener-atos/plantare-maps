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
const talhaoEm = x => [{ outer: quad.map(([lo, la]) => [lo - (-55) + x, la]), holes: [] }];   // o mesmo quadrado em outro lugar (outro talhão)
const req = (path, body, o) => { o = o || {};
  const h = { 'content-type': 'application/json' }; if (o.orig !== null) h.origin = o.orig || ORIG; if (o.token) h.authorization = 'Bearer ' + o.token;
  return new Request('https://pix.matheusuener.com.br' + path, { method: o.metodo || (body ? 'POST' : 'GET'), headers: h, body: body ? JSON.stringify(body) : undefined }); };
const chama = async (path, body, o) => { const r = await worker.fetch(req(path, body, o), env); return { st: r.status, j: await r.json().catch(() => null), r }; };
const ANA = F.entrar('u-ana', 'ana@fazenda.com.br'), BETO = F.entrar('u-beto', 'beto@fazenda.com.br');
F.cupom({ codigo: 'CAMPO10', desconto: 0.10, usos_max: 100, so_primeira: false, ativo: true });
F.cupom({ codigo: 'BEMVINDO30', desconto: 0.30, validade: new Date(Date.now() + 30 * 864e5).toISOString(), ativo: true });
F.cupom({ codigo: 'VENCIDO', desconto: 0.30, validade: new Date(Date.now() - 864e5).toISOString(), ativo: true });
F.cupom({ codigo: 'PRIMEIRA', desconto: 0.20, usos_max: null, so_primeira: true, ativo: true });
F.cupom({ codigo: 'UNICO', desconto: 0.15, usos_max: 1, so_primeira: false, ativo: true });
F.cupom({ codigo: 'GRANDE', desconto: 0.05, area_min: 500, ativo: true });
F.cupom({ codigo: 'FIXO2', fixo: 2, ativo: true });
F.cupom({ codigo: 'AMIGO', gratis: true, usos_max: 5, ativo: true });
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
await t('/cobranca sem conta e sem e-mail → 400', async () => { const { st, j } = await chama('/cobranca', { plano: 'x', polys, camadas: ['linhas_ab'] }); assert.equal(st, 400); assert.match(j.motivo, /e-mail/); });
await t('/cobranca com token falso vira compra sem conta (pede e-mail)', async () => { assert.equal((await chama('/cobranca', { plano: 'x', polys, camadas: ['linhas_ab'] }, { token: 'tok-invalido-0123456789abcdef' })).st, 400); });
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
await t('/preco: cupom sem conta também vale', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'campo10' }); assert.equal(j.cupom.valido, true, JSON.stringify(j.cupom)); assert.ok(j.preco.cupom > 0); });
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
  const c = F.compra(j.id); assert.equal(c.user_id, 'u-ana'); assert.equal(c.status, 'pendente'); assert.equal(c.area_hash, await hashTalhao(polys)); });
await t('/cobranca só com arquivos grátis', async () => { assert.equal((await chama('/cobranca', { plano: 'x', polys, camadas: [] }, ANA)).st, 400); });
await t('/cobranca polígono inválido', async () => { assert.equal((await chama('/cobranca', { plano: 'x', polys: [{ outer: [[999, 0], [1, 1]] }], camadas: ['linhas_ab'] }, ANA)).st, 400); });
await t('/status de compra de outra conta → 404', async () => { assert.equal((await chama('/status/' + pedido1, null, BETO)).st, 404); });
await t('/status ainda não pago', async () => { const { j } = await chama('/status/' + pedido1, null, ANA); assert.equal(j.pago, false); });
await t('/pacote antes de pagar → 402', async () => { assert.equal((await chama('/pacote', { pedido: pedido1, entrada: Object.assign({}, plano, { polys }) }, ANA)).st, 402); });
await t('/status pago grava no banco', async () => { F.pagar(pedido1); const { j } = await chama('/status/' + pedido1, null, ANA);
  assert.ok(j.pago); assert.deepEqual(j.camadas, ['linhas_ab', 'bordadura', 'percurso']); assert.equal(F.compra(pedido1).status, 'pago'); });

// ---------- cupom por conta ----------
await t('cupom: 1ª compra com PRIMEIRA vale para o Beto', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO); assert.ok(j.cupom.valido); });
await t('cupom: PRIMEIRA não vale para quem já comprou', async () => { const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'PRIMEIRA' }, ANA); assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /primeira/); });
let pixA, pixB;
await t('cupom: gerar outro Pix com o mesmo cupom cancela o anterior', async () => {
  pixA = (await chama('/cobranca', { plano: 'B1', polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO)).j.id;
  pixB = (await chama('/cobranca', { plano: 'B1', polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO)).j.id;
  assert.notEqual(pixA, pixB); assert.equal(F.orders[pixA].status, 'canceled'); assert.equal(F.compra(pixA).status, 'cancelado');
  assert.equal(F.usos().filter(u => u.user_id === 'u-beto').length, 1); });
await t('cupom: depois de pago, não vale de novo na mesma conta', async () => {
  F.pagar(pixB); await chama('/status/' + pixB, null, BETO);
  const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO); assert.equal(j.cupom.valido, false);
  assert.equal((await chama('/cobranca', { plano: 'B2', polys, camadas: TODAS, cupom: 'PRIMEIRA' }, BETO)).st, 400); });
await t('cupom: usos_max conta contas diferentes', async () => {
  const p = (await chama('/cobranca', { plano: 'U1', polys, camadas: ['linhas_ab'], cupom: 'UNICO' }, ANA)).j.id; F.pagar(p); await chama('/status/' + p, null, ANA);
  const { j } = await chama('/preco', { polys: talhaoEm(-49), camadas: TODAS, cupom: 'UNICO' }, BETO); assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /acabaram/); });

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
await t('/cortesia sem conta pede e-mail', async () => { const { st, j } = await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' }); assert.equal(st, 400); assert.match(j.motivo, /e-mail/); });
await t('/cortesia registra compra de R$ 0 na conta, manda recibo e cópia', async () => { const n = Object.keys(F.orders).length;
  const { st, j } = await chamaE('/cortesia', { plano: '1LKP5C', polys: plano.polys, camadas: ['linhas_ab', 'bordadura'], cupom: 'amigo', email: 'outro@x.com' }, ANA);
  assert.equal(st, 200, JSON.stringify(j)); cort = j.id; assert.match(cort, /^CORT-/); assert.equal(j.recibo, true); assert.equal(Object.keys(F.orders).length, n);
  const c = F.compra(cort); assert.equal(c.status, 'pago'); assert.equal(c.valor, 0); assert.equal(c.user_id, 'u-ana');
  assert.equal(enviados[0].to, 'ana@fazenda.com.br'); assert.equal(enviados[1].to, 'dono@exemplo.com'); assert.match(enviados[1].subject, /AMIGO/); assert.match(enviados[0].text, /#1LKP5C/); });
await t('/cortesia: mesma conta não usa duas vezes', async () => { const { st, j } = await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' }, ANA); assert.equal(st, 400); assert.match(j.motivo, /já usou/); });
await t('/cortesia recusa cupom que não é de cortesia', async () => { for (const cupom of ['FIXO2', 'CAMPO10', 'NADA']) assert.equal((await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom }, BETO)).st, 400, cupom); });
await t('/cortesia: e-mail falhando não impede o download', async () => {
  const CAIO = F.entrar('u-caio', 'caio@x.com');
  const { st, j } = await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' }, CAIO, Object.assign({}, env, { EMAIL: { send: async () => { throw Object.assign(new Error('x'), { code: 'E_SENDER_NOT_VERIFIED' }); } } }));
  assert.equal(st, 200); assert.equal(j.recibo, false); });
await t('/cortesia de origem estranha é barrada', async () => { assert.equal((await chamaE('/cortesia', { plano: 'x', polys, camadas: ['linhas_ab'], cupom: 'AMIGO' }, Object.assign({ orig: 'https://golpe.com' }, ANA))).st, 403); });

// ---------- cupom ilimitado (1SAMUEL712, BEMVINDO30, BEMVINDO90) ----------
F.cupom({ codigo: 'LIVRE', gratis: true, ilimitado: true, ativo: true });
await t('cupom ilimitado: a mesma conta usa quantas vezes quiser', async () => {
  const um = await chamaE('/cortesia', { plano: 'L1', polys: plano.polys, camadas: ['linhas_ab'], cupom: 'LIVRE' }, ANA);
  assert.equal(um.st, 200, JSON.stringify(um.j));
  const dois = await chamaE('/cortesia', { plano: 'L2', polys: plano.polys, camadas: ['linhas_ab'], cupom: 'LIVRE' }, ANA);
  assert.equal(dois.st, 200, JSON.stringify(dois.j));
  assert.notEqual(um.j.id, dois.j.id); });
await t('cupom ilimitado: vale no mesmo talhão e para outra pessoa', async () => {
  const { j } = await chama('/preco', { polys: plano.polys, camadas: TODAS, cupom: 'livre' }, BETO);
  assert.ok(j.cupom.valido, JSON.stringify(j.cupom)); assert.equal(j.cupom.gratis, true); });
await t('cupom ilimitado vencido não vale', async () => {
  F.cupom({ codigo: 'LIVREVENCIDO', gratis: true, ilimitado: true, ativo: true, validade: new Date(Date.now() - 864e5).toISOString() });
  const { j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'LIVREVENCIDO' }, ANA);
  assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /venceu/); });
await t('banco fora do ar: o preço sai e o cupom explica (não quebra tudo)', async () => {
  F.falharSql = /from cupons/;
  const { st, j } = await chama('/preco', { polys, camadas: TODAS, cupom: 'campo10' }, ANA);
  F.falharSql = null;
  assert.equal(st, 200, JSON.stringify(j)); assert.ok(j.preco.total > 0, 'o preço continua saindo');
  assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /conferir o cupom/); });


// ---------- Pix assíncrono, teste, referência ----------
// ---------- compra sem conta (visitante) ----------
let visita;
await t('sem conta: Pix com e-mail do formulário e chave de acesso', async () => {
  const { st, j } = await chama('/cobranca', { plano: 'V1', polys: plano.polys, camadas: ['linhas_ab', 'bordadura'], email: 'Visita@Fazenda.com' });
  assert.equal(st, 200, JSON.stringify(j)); visita = j; assert.match(j.acesso, /^[0-9a-f]{48}$/);
  const c = F.compra(j.id); assert.equal(c.user_id, null); assert.equal(c.email, 'visita@fazenda.com'); assert.match(c.acesso_hash, /^[0-9a-f]{64}$/); assert.notEqual(c.acesso_hash, j.acesso);
  assert.equal(F.orders[j.id].payer.email, 'visita@fazenda.com'); });
await t('sem conta: Pix com cupom de desconto', async () => { const { st, j } = await chama('/cobranca', { plano: 'V2', polys: talhaoEm(-50), camadas: TODAS, email: 'cupom@b.com', cupom: 'CAMPO10' });
  assert.equal(st, 200, JSON.stringify(j)); assert.equal(j.cupom.codigo, 'CAMPO10'); const u = F.usos().find(x => x.compra_id === j.id); assert.equal(u.user_id, null); assert.equal(u.email, 'cupom@b.com'); });
let cortV;
await t('sem conta: cortesia com e-mail, chave de acesso e recibo', async () => { enviados.length = 0;
  const { st, j } = await chamaE('/cortesia', { plano: 'CV1', polys: talhaoEm(-51), camadas: ['linhas_ab'], cupom: 'amigo', email: 'Visita2@Fazenda.com' });
  assert.equal(st, 200, JSON.stringify(j)); cortV = j; assert.match(j.acesso, /^[0-9a-f]{48}$/);
  const c = F.compra(j.id); assert.equal(c.user_id, null); assert.equal(c.email, 'visita2@fazenda.com'); assert.equal(c.status, 'pago'); assert.equal(c.acesso_hash.length, 64);
  assert.equal(enviados[0].to, 'visita2@fazenda.com'); assert.match(enviados[1].subject, /sem conta/); });
await t('sem conta: mesmo e-mail não usa a cortesia de novo', async () => { const { st, j } = await chamaE('/cortesia', { plano: 'CV2', polys: talhaoEm(-52), camadas: ['linhas_ab'], cupom: 'AMIGO', email: 'visita2@fazenda.com' }); assert.equal(st, 400); assert.match(j.motivo, /já usou/); });
await t('sem conta: a conta com o mesmo e-mail também já usou', async () => { const V2 = F.entrar('u-v2', 'visita2@fazenda.com');
  const { j } = await chama('/preco', { polys: talhaoEm(-53), camadas: TODAS, cupom: 'AMIGO' }, V2); assert.equal(j.cupom.valido, false); assert.match(j.cupom.motivo, /já usou/); });
await t('sem conta: outro e-mail no mesmo talhão não usa o cupom de novo', async () => { const { st, j } = await chamaE('/cortesia', { plano: 'CV3', polys: talhaoEm(-51), camadas: ['linhas_ab'], cupom: 'AMIGO', email: 'outra@pessoa.com' }); assert.equal(st, 400); assert.match(j.motivo, /talhão/); });
await t('sem conta: cortesia aparece paga só com a chave', async () => { const st = async k => { const h = { origin: ORIG }; if (k) h['x-plantare-acesso'] = k;
    const r = await worker.fetch(new Request('https://pix.matheusuener.com.br/status/' + cortV.id, { headers: h }), env); return { st: r.status, j: await r.json() }; };
  const ok = await st(cortV.acesso); assert.equal(ok.st, 200, JSON.stringify(ok.j)); assert.equal(ok.j.pago, true); assert.notEqual((await st(null)).st, 200); assert.notEqual((await st('0'.repeat(48))).st, 200); });
const comChave = (k) => ({ orig: ORIG, chave: k });
const statusCom = async (id, k, o) => { const h = { origin: ORIG }; if (k) h['x-plantare-acesso'] = k; if (o && o.token) h.authorization = 'Bearer ' + o.token;
  const r = await worker.fetch(new Request('https://pix.matheusuener.com.br/status/' + id, { headers: h }), env); return { st: r.status, j: await r.json() }; };
await t('sem conta: status só com a chave certa', async () => {
  assert.equal((await statusCom(visita.id, visita.acesso)).st, 200);
  assert.equal((await statusCom(visita.id, null)).st, 401);
  assert.equal((await statusCom(visita.id, 'f'.repeat(48))).st, 404);
  assert.equal((await statusCom(visita.id, null, ANA)).st, 404); });
await t('sem conta: depois de pago, baixa com a chave (e só com ela)', async () => {
  F.pagar(visita.id); assert.equal((await statusCom(visita.id, visita.acesso)).j.pago, true);
  const entrada = Object.assign({}, plano, { formatos: { ab: 1 } });
  const ok = await chama('/pacote', { pedido: visita.id, acesso: visita.acesso, entrada }); assert.equal(ok.st, 200, JSON.stringify(ok.j).slice(0, 200));
  const ab = Buffer.from(ok.j.arquivos.find(a => a.name.endsWith('_ab.kml')).b64, 'base64').toString(); assert.match(ab, /Licenciado a visita@fazenda.com/);
  assert.equal((await chama('/pacote', { pedido: visita.id, entrada })).st, 401);
  assert.equal((await chama('/pacote', { pedido: visita.id, acesso: 'a'.repeat(48), entrada })).st, 404); });
await t('preflight libera o cabeçalho da chave', async () => { const { r } = await chama('/status/x', null, { metodo: 'OPTIONS' }); assert.match(r.headers.get('access-control-allow-headers'), /x-plantare-acesso/); });
await t('referência só com letras, números e -', async () => { const o = F.orders[pedido1]; assert.match(o.external_reference, /^plantare-4K4D1L-ABP-\d+$/); });
await t('/cobranca com PAGADOR_TESTE manda first_name APRO', async () => { const r = await worker.fetch(req('/cobranca', { plano: 'T', polys, camadas: ['linhas_ab'] }, BETO), Object.assign({}, env, { PAGADOR_TESTE: 'APRO' }));
  const j = await r.json(); assert.equal(F.orders[j.id].payer.first_name, 'APRO'); assert.equal(F.orders[pedido1].payer.first_name, undefined); });
await t('criação assíncrona: /cobranca sem QR, /status traz o QR depois', async () => {
  const c = (await chama('/cobranca', { plano: 'ASYNC', polys, camadas: ['linhas_ab'] }, BETO)).j; assert.equal(c.status, 'processing'); assert.equal(c.qr_code, null);
  const s = (await chama('/status/' + c.id, null, BETO)).j; assert.equal(s.pago, false); assert.equal(s.encerrado, false); assert.match(s.qr_code, /^000201PIX/); assert.ok(s.expira); });
await t('/status de order vencida avisa encerrado', async () => { const c = (await chama('/cobranca', { plano: 'V', polys, camadas: ['linhas_ab'] }, BETO)).j; F.orders[c.id].status = 'expired';
  const s = (await chama('/status/' + c.id, null, BETO)).j; assert.equal(s.pago, false); assert.equal(s.encerrado, true); assert.equal(F.compra(c.id).status, 'expirado'); });
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
  assert.equal(F.compra(pedidoArvore).downloads, 1); });
// ---------- como o percurso é entregue (etapa 03) ----------
let pedidoTudo;
const rotaDe=j=>Buffer.from(j.arquivos.find(x=>/_rota[.]kml$/.test(x.name)).b64,'base64').toString();
await t('percurso: por padrão sai um caminho só', async () => {
  pedidoTudo=(await chama('/cobranca', { plano: 'SEG1', polys: plano.polys, camadas: TODAS }, ANA)).j.id; F.pagar(pedidoTudo);
  const { st, j } = await chama('/pacote', { pedido: pedidoTudo, entrada: entradaBoa }, ANA);
  assert.equal(st, 200, JSON.stringify(j).slice(0,200));
  const kml=rotaDe(j);
  assert.equal((kml.match(/<Placemark>/g)||[]).length, 1);
  assert.match(kml, /<name>Percurso[<][/]name>/);
  assert.ok(!j.arquivos.some(x=>/_rota_[0-9][0-9][.]kml$/.test(x.name)), 'sem arquivo por pedaço'); });
await t('percurso: em passos numerados, no mesmo arquivo', async () => {
  const { st, j } = await chama('/pacote', { pedido: pedidoTudo, entrada: Object.assign({}, entradaBoa, { saida: { modo: 'passos' } }) }, ANA);
  assert.equal(st, 200); const kml=rotaDe(j);
  assert.ok((kml.match(/<Placemark>/g)||[]).length >= 1);
  assert.match(kml, /Passo 01/);
  assert.ok(!j.arquivos.some(x=>/_rota_[0-9][0-9][.]kml$/.test(x.name)), 'passos ficam num arquivo só'); });
await t('percurso: um arquivo por pedaço', async () => {
  const { st, j } = await chama('/pacote', { pedido: pedidoTudo, entrada: Object.assign({}, entradaBoa, { saida: { modo: 'trechos' } }) }, ANA);
  assert.equal(st, 200);
  const soltos=j.arquivos.filter(x=>/_rota_[0-9][0-9][.]kml$/.test(x.name));
  const kml=rotaDe(j), n=(kml.match(/<Placemark>/g)||[]).length;
  assert.equal(soltos.length, n>1?n:0, 'um arquivo por pedaço quando há mais de um'); });
await t('percurso: blocos por área respeitam o limite e não cortam no meio da passada', async () => {
  const { st, j } = await chama('/pacote', { pedido: pedidoTudo, entrada: Object.assign({}, entradaBoa, { saida: { modo: 'blocos', criterio: 'area', valor: 0.5, faixa: 30 } }) }, ANA);
  assert.equal(st, 200); const kml=rotaDe(j);
  const nomes=[...kml.matchAll(/<name>(Bloco [0-9][0-9][^<]*)[<][/]name>/g)].map(m=>m[1]);
  assert.ok(nomes.length >= 2, 'dividiu em blocos: '+nomes.length);
  assert.match(nomes[0], /Bloco 01 · [0-9,]+ ha/);
  assert.equal(j.arquivos.filter(x=>/_rota_[0-9][0-9][.]kml$/.test(x.name)).length, nomes.length); });
await t('percurso: bloco por tanque usa a vazão', async () => {
  const { j } = await chama('/pacote', { pedido: pedidoTudo, entrada: Object.assign({}, entradaBoa, { saida: { modo: 'blocos', criterio: 'tanque', valor: 200, vazao: 100, faixa: 30 } }) }, ANA);
  const kml=rotaDe(j), nomes=[...kml.matchAll(/<name>(Bloco[^<]*)[<][/]name>/g)].map(m=>m[1]);
  assert.ok(nomes.length >= 2); assert.match(nomes[0], / L/); });
await t('retorno: à parte não entra no percurso', async () => {
  const { j } = await chama('/pacote', { pedido: pedidoTudo, entrada: entradaBoa }, ANA);
  const rota=Buffer.from(j.arquivos.find(x=>/_rota[.]kml$/.test(x.name)).b64,'base64').toString();
  const ret=j.arquivos.find(x=>/_retorno[.]kml$/.test(x.name));
  assert.ok(ret, 'tem arquivo de retorno'); assert.ok(!/Retorno/.test(rota), 'o percurso não leva a volta');
  assert.match(Buffer.from(ret.b64,'base64').toString(), /<name>Retorno</); });
await t('retorno: como mais um passo, entra no fim do percurso', async () => {
  const { j } = await chama('/pacote', { pedido: pedidoTudo, entrada: Object.assign({}, entradaBoa, { saida: { modo: 'passos', retorno: 'passo' } }) }, ANA);
  const rota=Buffer.from(j.arquivos.find(x=>/_rota[.]kml$/.test(x.name)).b64,'base64').toString();
  assert.match(rota, /<name>Retorno/); assert.ok(!j.arquivos.some(x=>/_retorno[.]kml$/.test(x.name)), 'sem arquivo separado'); });
await t('retorno: junto, fica dentro do caminho como antes', async () => {
  const { j } = await chama('/pacote', { pedido: pedidoTudo, entrada: Object.assign({}, entradaBoa, { saida: { modo: 'unico', retorno: 'junto' } }) }, ANA);
  assert.ok(!j.arquivos.some(x=>/_retorno[.]kml$/.test(x.name))); });
await t('/pacote: cortesia também libera os arquivos', async () => { const { st, j } = await chama('/pacote', { pedido: cort, entrada: entradaBoa }, ANA); assert.equal(st, 200); assert.ok(j.arquivos.some(a => a.name.endsWith('_ab.kmz'))); });
await t('/pacote: compra de outra conta → 404', async () => { assert.equal((await chama('/pacote', { pedido: pedidoArvore, entrada: entradaBoa }, BETO)).st, 404); });
await t('/pacote: percurso fora do talhão → 400', async () => {
  const longe = Object.assign({}, entradaBoa, { legs: plano.legs.map(l => Object.assign({}, l, { p: l.p.map(q => [q[0] + 5000, q[1]]) })) });
  const { st, j } = await chama('/pacote', { pedido: pedidoArvore, entrada: longe }, ANA); assert.equal(st, 400); assert.match(j.motivo, /não é deste talhão/); });
await t('/pacote: compra antiga demais', async () => {
  const antes = F.compra(pedidoArvore).pago_em; F.db.prepare('update compras set pago_em = ? where id = ?').run(new Date(Date.now() - 400 * 864e5).toISOString(), pedidoArvore);
  const { st } = await chama('/pacote', { pedido: pedidoArvore, entrada: entradaBoa }, ANA); F.db.prepare('update compras set pago_em = ? where id = ?').run(antes, pedidoArvore); assert.equal(st, 403); });
await t('gerador: pacote completo tem os 40 arquivos do app (com o retorno à parte)', () => {
  const r = gerarPacote(entradaBoa, { camadas: TODAS, texto: '' }); assert.equal(r.arquivos.length, 40); assert.deepEqual(r.negados, []);
  assert.ok(r.arquivos.some(a => /_retorno[.]kml$/.test(a.name)) && r.arquivos.some(a => /_retorno[.]kmz$/.test(a.name))); });
await t('gerador: entrada inválida', () => { assert.throws(() => gerarPacote(Object.assign({}, entradaBoa, { legs: [{ t: 'w', p: [[1, 'a']] }] }), { camadas: TODAS }), /inválido/); });
await t('/eu lista as compras pagas', async () => { const { j } = await chama('/eu', null, ANA); const esperadas = F.compras().filter(c => c.user_id === 'u-ana' && c.status === 'pago').map(c => c.id); assert.ok(esperadas.includes(cort)); assert.deepEqual(j.compras.map(c => c.id).sort(), esperadas.sort()); });

// ---------- a conta: cadastro, talhões, projetos ----------
const conta = (path, metodo, corpo, quem, extra) => { const h = Object.assign({ origin: ORIG }, extra || {}); if (quem) h.authorization = 'Bearer ' + quem.token;
  if (corpo !== undefined && !(corpo instanceof Uint8Array)) h['content-type'] = 'application/json';
  return worker.fetch(new Request('https://pix.matheusuener.com.br' + path, { method: metodo, headers: h, body: corpo === undefined ? undefined : corpo instanceof Uint8Array ? corpo : JSON.stringify(corpo) }), env); };
const PERFIL = { nome: 'Ana Souza', cpf: '529.982.247-25', whatsapp: '(65) 99999-0000', cep: '78000-000', logradouro: 'Estrada da Fazenda', numero: 's/n', bairro: 'Zona rural', cidade: 'Cuiabá', uf: 'mt' };
await t('conta: sem sessão, as rotas da conta respondem 401', async () => {
  for (const [p, m] of [['/conta/perfil', 'GET'], ['/conta/talhoes', 'GET'], ['/conta/projetos/abcdef123456', 'GET'], ['/conta/sair', 'POST']]) assert.equal((await conta(p, m)).status, 401, p); });
await t('conta: cadastro vazio, gravado e lido de volta (normalizado)', async () => {
  assert.equal((await (await conta('/conta/perfil', 'GET', undefined, ANA)).json()).perfil, null);
  const r = await conta('/conta/perfil', 'PUT', PERFIL, ANA); assert.equal(r.status, 200, await r.clone().text());
  const p = (await (await conta('/conta/perfil', 'GET', undefined, ANA)).json()).perfil;
  assert.equal(p.cpf, '52998224725'); assert.equal(p.whatsapp, '65999990000'); assert.equal(p.uf, 'MT'); assert.equal(p.nome, 'Ana Souza');
  assert.equal((await (await conta('/conta/perfil', 'GET', undefined, BETO)).json()).perfil, null, 'cada conta só vê o seu'); });
await t('conta: cadastro com CPF ou UF errados é recusado', async () => {
  assert.equal((await conta('/conta/perfil', 'PUT', Object.assign({}, PERFIL, { cpf: '123' }), ANA)).status, 400);
  assert.equal((await conta('/conta/perfil', 'PUT', Object.assign({}, PERFIL, { uf: 'Mato Grosso' }), ANA)).status, 400); });
const CHAVE = 'a1b2c3d4e5f6a1b2c3d4e5f6';
await t('conta: talhão guardado aparece na lista, e só na conta dele', async () => {
  const r = await conta('/conta/talhoes/' + CHAVE, 'PUT', { codigo: 'A1B2C3', nome: 'Talhão da Sede', area_hash: 'f'.repeat(64), ha: 12.5, centro: [-55.1, -12.2], contorno: [[[-55, -12], [-55.1, -12], [-55.1, -12.1]]] }, ANA);
  assert.equal(r.status, 200, await r.clone().text());
  await conta('/conta/talhoes/' + CHAVE, 'PUT', { codigo: 'A1B2C3', nome: 'Talhão da Sede (2)', ha: 12.5 }, ANA);   // guardar de novo troca, não duplica
  const l = (await (await conta('/conta/talhoes', 'GET', undefined, ANA)).json()).talhoes;
  assert.equal(l.length, 1); assert.equal(l[0].nome, 'Talhão da Sede (2)'); assert.equal(l[0].chave, CHAVE);
  assert.deepEqual((await (await conta('/conta/talhoes', 'GET', undefined, BETO)).json()).talhoes, []);
  assert.equal((await conta('/conta/talhoes/NAO-E-HEX', 'PUT', { codigo: 'X', nome: 'x' }, ANA)).status, 400); });
await t('conta: projeto vai e volta comprimido; outra conta não lê', async () => {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const gz = new Uint8Array(gzipSync(JSON.stringify({ versao: 3, arquivo: 'sede.kml' })));
  assert.equal((await conta('/conta/projetos/' + CHAVE, 'PUT', gz, ANA, { 'content-type': 'application/gzip' })).status, 200);
  const r = await conta('/conta/projetos/' + CHAVE, 'GET', undefined, ANA); assert.equal(r.status, 200);
  assert.equal(JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer()))).arquivo, 'sede.kml');
  assert.equal((await conta('/conta/projetos/' + CHAVE, 'GET', undefined, BETO)).status, 404);
  assert.equal((await conta('/conta/projetos/' + CHAVE, 'PUT', new TextEncoder().encode('{"cru":1}'), ANA, { 'content-type': 'application/gzip' })).status, 400, 'sem gzip');
  assert.equal((await conta('/conta/projetos/' + CHAVE, 'PUT', new Uint8Array(2 * 1024 * 1024 + 1).fill(0x1f), ANA, { 'content-type': 'application/gzip' })).status, 413); });
await t('conta: sair encerra a sessão; sessão vencida não vale', async () => {
  const S = F.entrar('u-sai', 'sai@x.com');
  assert.equal((await chama('/eu', null, S)).st, 200);
  assert.equal((await conta('/conta/sair', 'POST', undefined, S)).status, 200);
  assert.equal((await chama('/eu', null, S)).st, 401);
  const V = F.entrar('u-velho', 'velho@x.com'); F.db.prepare('update sessoes set expira = ? where conta_id = ?').run(new Date(Date.now() - 1000).toISOString(), 'u-velho');
  assert.equal((await chama('/eu', null, V)).st, 401); });

// ---------- excluir a conta ----------
let DANI;
await t('excluir conta: pede a palavra EXCLUIR', async () => {
  DANI = F.entrar('u-dani', 'dani@x.com');
  assert.equal((await chama('/conta/excluir', {}, DANI)).st, 400);
  assert.equal((await chama('/conta/excluir', { confirmar: 'EXCLUIR' })).st, 401); });
await t('excluir conta: apaga conta, sessões, cadastro, talhões e projetos; guarda a compra sem dono', async () => {
  const { gzipSync } = await import('node:zlib'), gz = new Uint8Array(gzipSync('{}'));
  await conta('/conta/perfil', 'PUT', Object.assign({}, PERFIL, { nome: 'Dani Lima' }), DANI);
  await conta('/conta/talhoes/' + CHAVE, 'PUT', { codigo: 'D1', nome: 'Da Dani' }, DANI);
  await conta('/conta/projetos/' + CHAVE, 'PUT', gz, DANI, { 'content-type': 'application/gzip' });
  const id = (await chama('/cobranca', { plano: 'D1', polys, camadas: ['linhas_ab'] }, DANI)).j.id; F.pagar(id); await chama('/status/' + id, null, DANI);
  const { st, j } = await chama('/conta/excluir', { confirmar: 'excluir' }, DANI); assert.equal(st, 200, JSON.stringify(j));
  assert.equal((await chama('/eu', null, DANI)).st, 401);
  for (const tab of ['contas where id', 'sessoes where conta_id', 'perfis where conta_id', 'talhoes where conta_id']) assert.equal(F.sql('select 1 from ' + tab + ' = ?', 'u-dani').length, 0, tab);
  assert.equal(F.projetos.objs.has('projetos/u-dani/' + CHAVE + '.json.gz'), false);
  const c = F.compra(id); assert.equal(c.user_id, null); assert.match(c.acesso_hash, /^[0-9a-f]{64}$/); assert.equal(c.status, 'pago');
  // a outra conta não é tocada
  assert.equal(F.sql('select 1 from perfis where conta_id = ?', 'u-ana').length, 1); assert.equal(F.sql('select 1 from talhoes where conta_id = ?', 'u-ana').length, 1);
  assert.equal(F.projetos.objs.has('projetos/u-ana/' + CHAVE + '.json.gz'), true);
  assert.equal((await chama('/eu', null, ANA)).st, 200); });

// ---------- Entrar com Atos ----------
const VOLTA = 'https://plantaremaps.com.br/';
/* ida no Worker → a Atos (falsa) autoriza → volta no Worker; o.guardar mexe no que o navegador guardou */
const entrarAtos = async (pessoa, o) => { o = o || {};
  const ida = await chama('/conta/atos/ida', { volta: o.volta || VOLTA, criarConta: o.criarConta });
  assert.equal(ida.st, 200, JSON.stringify(ida.j));
  const url = F.atosAutorizar(ida.j.url, pessoa, o), guardar = o.guardar ? o.guardar(ida.j.guardar) : ida.j.guardar;
  return { ida, url, guardar, volta: await chama('/conta/atos/volta', { url, guardar }) }; };
const contaDoSub = sub => F.sql('select * from contas where atos_sub = ?', sub)[0];
await t('Atos: sem ATOS_CLIENT_ID as rotas respondem 503', async () => {
  const semAtos = Object.assign({}, env, { ATOS_CLIENT_ID: '' });
  for (const r of ['/conta/atos/ida', '/conta/atos/volta']) assert.equal((await worker.fetch(req(r, {}), semAtos)).status, 503, r); });
await t('Atos: origem estranha é barrada', async () => { assert.equal((await chama('/conta/atos/ida', { volta: VOLTA }, { orig: 'https://golpe.com' })).st, 403); });
await t('Atos: a ida leva PKCE S256, state, nonce e a volta cadastrada', async () => {
  const { j } = await chama('/conta/atos/ida', { volta: VOLTA }); const p = new URL(j.url).searchParams;
  assert.ok(j.url.startsWith('https://atos.teste/entrar?')); assert.equal(p.get('client_id'), 'u-plantare-teste'); assert.equal(p.get('redirect_uri'), VOLTA);
  assert.equal(p.get('code_challenge_method'), 'S256'); assert.match(p.get('code_challenge'), /^[\w-]{43}$/); assert.equal(p.get('scope'), 'openid email profile');
  assert.equal(p.get('state'), j.guardar.state); assert.equal(p.get('nonce'), j.guardar.nonce); assert.equal(p.get('prompt'), null);
  assert.equal(new URL((await chama('/conta/atos/ida', { volta: 'http://localhost:8787/' })).j.url).searchParams.get('redirect_uri'), 'http://localhost:8787/');
  assert.equal(new URL((await chama('/conta/atos/ida', { volta: 'https://golpe.com/' })).j.url).searchParams.get('redirect_uri'), VOLTA);   // volta fora da lista: a padrão
  assert.equal(new URL((await chama('/conta/atos/ida', { volta: VOLTA, criarConta: true })).j.url).searchParams.get('prompt'), 'create'); });
let caio;
await t('Atos: a primeira entrada cria a conta e abre uma sessão de 30 dias', async () => {
  const { volta } = await entrarAtos({ sub: 'atos-caio', email: 'Caio@Sitio.com', name: 'Caio' });
  assert.equal(volta.st, 200, JSON.stringify(volta.j)); assert.equal(volta.j.email, 'caio@sitio.com'); assert.equal(volta.j.nome, 'Caio');
  assert.match(volta.j.access_token, /^[0-9a-f]{64}$/); assert.ok(Math.abs(Date.parse(volta.j.expira) - Date.now() - 30 * 864e5) < 60e3);
  caio = contaDoSub('atos-caio'); assert.ok(caio && /^c-/.test(caio.id));
  assert.equal(F.sql('select 1 from sessoes where hash = ?', volta.j.access_token).length, 0, 'o banco guarda só o hash');
  assert.deepEqual((await chama('/eu', null, { token: volta.j.access_token })).j.compras, []); });
await t('Atos: a entrada seguinte vai pelo sub, e o e-mail trocado na Atos acompanha', async () => {
  const { volta } = await entrarAtos({ sub: 'atos-caio', email: 'caio.novo@sitio.com', name: 'Caio' });
  assert.equal(volta.st, 200); assert.equal(contaDoSub('atos-caio').id, caio.id); assert.equal(contaDoSub('atos-caio').email, 'caio.novo@sitio.com');
  assert.equal((await chama('/eu', null, { token: volta.j.access_token })).j.email, 'caio.novo@sitio.com'); });
await t('Atos: outra Conta Atos com o mesmo e-mail é outra conta', async () => {
  const { volta } = await entrarAtos({ sub: 'atos-outro', email: 'caio.novo@sitio.com' });
  assert.equal(volta.st, 200); assert.notEqual(contaDoSub('atos-outro').id, caio.id); });
await t('Atos: state trocado é recusado e nada é criado', async () => {
  const { volta } = await entrarAtos({ sub: 'atos-dora', email: 'dora@sitio.com' }, { guardar: g => Object.assign({}, g, { state: 'outro-state-qualquer-1234' }) });
  assert.equal(volta.st, 400); assert.match(volta.j.motivo, /state/); assert.equal(contaDoSub('atos-dora'), undefined); });
await t('Atos: o mesmo código não vale duas vezes', async () => {
  const r = await entrarAtos({ sub: 'atos-caio', email: 'caio.novo@sitio.com' }); assert.equal(r.volta.st, 200);
  const de_novo = await chama('/conta/atos/volta', { url: r.url, guardar: r.guardar }); assert.equal(de_novo.st, 400); assert.match(de_novo.j.motivo, /venceu|usado/); });
await t('Atos: id_token assinado por outra chave é recusado', async () => {
  const { volta } = await entrarAtos({ sub: 'atos-eva', email: 'eva@sitio.com' }, { forjar: true });
  assert.equal(volta.st, 400); assert.match(volta.j.motivo, /assinatura/); assert.equal(contaDoSub('atos-eva'), undefined); });
await t('Atos: e-mail não confirmado na Atos → 403', async () => {
  const { volta } = await entrarAtos({ sub: 'atos-fabio', email: 'fabio@sitio.com', email_verified: false });
  assert.equal(volta.st, 403); assert.match(volta.j.motivo, /confirmado/); assert.equal(contaDoSub('atos-fabio'), undefined); });
await t('Atos: conta sem acesso ao aplicativo volta com a mensagem da Atos', async () => {
  const { volta } = await entrarAtos({ erro: 'access_denied' }); assert.equal(volta.st, 403); assert.match(volta.j.motivo, /não tem acesso/); });
await t('Atos: acesso confidencial manda o segredo (client_secret_basic)', async () => {
  F.atosConfidencial = 's3gredo-do-teste'; process.env.ATOS_CLIENT_SECRET = 's3gredo-do-teste';
  try { assert.equal((await entrarAtos({ sub: 'atos-caio', email: 'caio.novo@sitio.com' })).volta.st, 200);
    process.env.ATOS_CLIENT_SECRET = 'outro'; assert.equal((await entrarAtos({ sub: 'atos-caio', email: 'caio.novo@sitio.com' })).volta.st, 400); }
  finally { F.atosConfidencial = null; delete process.env.ATOS_CLIENT_SECRET; } });
await t('Atos: excluir a conta e entrar de novo abre uma conta nova, vazia', async () => {
  const tok = (await entrarAtos({ sub: 'atos-caio', email: 'caio.novo@sitio.com' })).volta.j.access_token;
  assert.equal((await chama('/conta/excluir', { confirmar: 'EXCLUIR' }, { token: tok })).st, 200); assert.equal(contaDoSub('atos-caio'), undefined);
  const { volta } = await entrarAtos({ sub: 'atos-caio', email: 'caio.novo@sitio.com' }); assert.equal(volta.st, 200); assert.notEqual(contaDoSub('atos-caio').id, caio.id); });
// ---------- webhook ----------
const assinar = async (id, rid, ts) => { const man = 'id:' + id.toLowerCase() + ';request-id:' + rid + ';ts:' + ts + ';';
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('segredo'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(man)))].map(b => b.toString(16).padStart(2, '0')).join(''); };
await t('webhook com assinatura certa grava o pagamento', async () => {
  const id = (await chama('/cobranca', { plano: 'W1', polys, camadas: ['linhas_ab'] }, BETO)).j.id; F.pagar(id);
  const v1 = await assinar(id, 'req-1', '1742505638683');
  const r = await worker.fetch(new Request('https://pix.matheusuener.com.br/webhook?data.id=' + id + '&type=order', { method: 'POST', headers: { 'x-signature': 'ts=1742505638683,v1=' + v1, 'x-request-id': 'req-1' }, body: '{}' }), env);
  assert.equal(r.status, 200); assert.equal(F.compra(id).status, 'pago'); });
await t('webhook de order desconhecida responde 200 (sem reenvio infinito)', async () => {
  const v1 = await assinar('ORDNAOEXISTE', 'req-2', '1742505638684');
  const r = await worker.fetch(new Request('https://pix.matheusuener.com.br/webhook?data.id=ORDNAOEXISTE&type=order', { method: 'POST', headers: { 'x-signature': 'ts=1742505638684,v1=' + v1, 'x-request-id': 'req-2' }, body: '{}' }), env);
  assert.equal(r.status, 200); });
await t('webhook com assinatura errada', async () => { const r = await worker.fetch(new Request('https://pix.matheusuener.com.br/webhook?data.id=X', { method: 'POST', headers: { 'x-signature': 'ts=1,v1=abc', 'x-request-id': 'r' }, body: '{}' }), env); assert.equal(r.status, 401); });
console.log(ok + ' testes ok');
