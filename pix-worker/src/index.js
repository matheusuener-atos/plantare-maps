/* Plantare · microserviço Pix (Cloudflare Worker + Mercado Pago Orders API)

   Rotas
     POST /preco          → orçamento (mesma conta do app; aplica cupom)             {polys, camadas, cupom?}
     POST /cobranca       → cria o Pix e devolve QR / copia-e-cola                    {plano, polys, camadas, email, cupom?}
     POST /cortesia       → cupom de cortesia: confere, manda recibo e cópia por e-mail {plano, polys, camadas, email, cupom}
     GET  /status/:id     → consulta a order no Mercado Pago (pago ou não)
     POST /webhook        → aviso do Mercado Pago (assinatura x-signature conferida)
     GET  /saude          → teste rápido

   Segredos (wrangler secret put …):  MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET
   Segredos opcionais:                 CUPONS (JSON {"CODIGO":0.1, "OUTRO":{"fixo":2}, "AMIGO":{"gratis":true}}) — fica fora do repositório
                                       AVISO_EMAIL (quem recebe a cópia de cada cortesia)
   E-mail (binding EMAIL, Cloudflare Email Service): remetente EMAIL_DE ([vars]); se falhar, o download não trava
   Variáveis (wrangler.toml [vars]):   ORIGENS (lista separada por vírgula),
                                       EXPIRA (ISO 8601, padrão PT30M), PAGADOR_TESTE (só em teste: "APRO")
   Regras de segurança
     · o preço é calculado AQUI, a partir do polígono do talhão (a área que o navegador manda não vale);
     · o token do Mercado Pago só existe como segredo do Worker;
     · só as origens da lista podem chamar (CORS). */
import { calcularPreco, areaPoligonos, PRECO, NOMES_CAMADAS } from './preco.js';

const MP = 'https://api.mercadopago.com';
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {}) });

function cors(req, env) {
  const origem = req.headers.get('origin') || '';
  const ok = (env.ORIGENS || '').split(',').map(s => s.trim()).filter(Boolean);
  const permitida = ok.includes('*') || ok.includes(origem);
  return { permitida, headers: permitida ? {
    'access-control-allow-origin': origem || '*', 'vary': 'origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } : {} };
}

/* polígonos do app: [{outer:[[lon,lat]...], holes:[[...]]}] — confere formato e tamanho */
function validarPolys(polys) {
  if (!Array.isArray(polys) || !polys.length || polys.length > 50) return 'Talhão inválido.';
  let n = 0;
  const anelOk = r => Array.isArray(r) && r.length >= 3 && r.every(q => Array.isArray(q) && q.length >= 2 && isFinite(q[0]) && isFinite(q[1]) && Math.abs(q[0]) <= 180 && Math.abs(q[1]) <= 90 && ++n <= 60000);
  for (const p of polys) { if (!p || !anelOk(p.outer)) return 'Talhão inválido.'; for (const h of p.holes || []) if (!anelOk(h)) return 'Obstáculo inválido.'; }
  return null;
}
function cuponsDe(env) { try { return JSON.parse(env.CUPONS || '{}'); } catch (e) { return {}; } }
function orcar(body, env) {
  const erro = validarPolys(body.polys); if (erro) return { erro };
  const ha = areaPoligonos(body.polys) / 1e4;
  if (ha > PRECO.areaMaxHa) return { erro: 'Área acima do limite para compra online. Fale com a gente.' };
  const cod = String(body.cupom || '').trim().toUpperCase(), cupons = cuponsDe(env);
  const val = cod ? cupons[cod] : undefined;   // 0.10 = 10% de desconto; {"fixo":2} = compra por R$ 2,00; {"gratis":true} = cortesia
  const gratis = !!(val && typeof val === 'object' && val.gratis === true);
  const fixo = !gratis && val && typeof val === 'object' && +val.fixo > 0 ? +val.fixo : 0;
  const desc = !gratis && !fixo && val != null ? +val || 0 : 0;
  const p = calcularPreco(ha, body.camadas, gratis ? { gratis } : fixo ? { fixo } : desc);
  return { preco: p, cupom: cod ? { codigo: cod, valido: gratis || fixo > 0 || desc > 0, desconto: desc, fixo: fixo || null, gratis } : null };
}
/* referência curta que volta no status: plantare-plano-camadas-centésimos de ha (ex.: plantare-1LKP5C-ABP-282).
   A Orders API só aceita letras, números, - e _ (máx. 64). */
const COD = { linhas_ab: 'A', bordadura: 'B', percurso: 'P', manobras: 'M' };
const refDe = (plano, camadas, ha) => ['plantare', String(plano).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'plano', camadas.map(c => COD[c]).join(''), Math.round(ha * 100)].join('-');
function lerRef(ref) {
  const [app, plano, cods, cent] = String(ref || '').split('-');
  if (app !== 'plantare') return null;
  const inv = Object.fromEntries(Object.entries(COD).map(([k, v]) => [v, k]));
  return { plano, camadas: [...(cods || '')].map(c => inv[c]).filter(Boolean), ha: +cent / 100 };
}

async function criarCobranca(body, env) {
  const o = orcar(body, env); if (o.erro) return json({ ok: false, motivo: o.erro }, 400);
  const p = o.preco;
  if (!p.total) return json({ ok: false, motivo: 'Nada a cobrar: escolha ao menos uma camada paga.' }, 400);
  if (p.total < 1) return json({ ok: false, motivo: 'Valor abaixo do mínimo do Pix.' }, 400);
  const email = String(body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, motivo: 'Informe um e-mail válido para o comprovante.' }, 400);
  const valor = p.total.toFixed(2), ref = refDe(body.plano || 'plano', p.camadas, p.ha);
  const pedido = {
    type: 'online', total_amount: valor, external_reference: ref, processing_mode: 'automatic',
    description: 'Plantare Maps · plano ' + (body.plano || '') + ' · ' + p.ha.toFixed(2) + ' ha',
    transactions: { payments: [{ amount: valor, payment_method: { id: 'pix', type: 'bank_transfer' }, expiration_time: env.EXPIRA || 'PT30M' }] },
    // PAGADOR_TESTE="APRO" só com credencial de teste: o Mercado Pago aprova a order de teste sozinho
    payer: env.PAGADOR_TESTE ? { email, first_name: env.PAGADOR_TESTE } : { email }
  };
  const r = await fetch(MP + '/v1/orders', { method: 'POST', headers: {
      'content-type': 'application/json', 'accept': 'application/json',
      'authorization': 'Bearer ' + env.MP_ACCESS_TOKEN, 'x-idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(pedido) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ ok: false, motivo: 'O Mercado Pago recusou a cobrança.', detalhe: d && (d.message || (d.errors && d.errors[0] && [d.errors[0].message].concat(d.errors[0].details || []).join(' · '))) || r.status }, 502);
  return json(Object.assign({ ok: true, id: d.id, status: d.status, valor: p.total, preco: p, cupom: o.cupom }, dadosPix(d)));
}

/* QR / copia e cola da order. A criação pode ser assíncrona (status processing/in_process):
   aí esses campos chegam vazios e aparecem depois, na consulta de /status. */
function dadosPix(d) {
  const pg = (d.transactions && d.transactions.payments && d.transactions.payments[0]) || {}, pm = pg.payment_method || {};
  return { qr_code: pm.qr_code || null, qr_code_base64: pm.qr_code_base64 || null, ticket_url: pm.ticket_url || null, expira: pg.date_of_expiration || null };
}
const ENCERRADOS = ['canceled', 'expired', 'failed', 'refunded', 'charged_back'];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function enviarEmail(env, msg) {
  if (!env.EMAIL || !msg.to) return false;
  try { await env.EMAIL.send(Object.assign({ from: env.EMAIL_DE || 'nao-responda@plantaremaps.com.br' }, msg)); return true; }
  catch (e) { console.log('e-mail não enviado', e && (e.code || e.message)); return false; }
}

/* Cupom de cortesia: o preço zerado é conferido aqui (não confia no navegador). Sem Mercado Pago.
   Manda recibo para quem pediu e cópia para AVISO_EMAIL; falha de e-mail não impede o download. */
async function cortesia(body, env) {
  const o = orcar(body, env); if (o.erro) return json({ ok: false, motivo: o.erro }, 400);
  if (!o.cupom || !o.cupom.gratis) return json({ ok: false, motivo: 'Cupom de cortesia inválido.' }, 400);
  const email = String(body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ ok: false, motivo: 'Informe um e-mail válido para receber o recibo.' }, 400);
  const p = o.preco, plano = String(body.plano || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'plano';
  const camadas = p.camadas.map(c => NOMES_CAMADAS[c]).join(', ') || 'relatório, imagem e projeto';
  const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const linhas = ['Plano #' + plano, p.ha.toFixed(2).replace('.', ',') + ' ha', 'Camadas: ' + camadas, 'Cupom de cortesia: ' + o.cupom.codigo, 'Valor: R$ 0,00', quando];
  const recibo = await enviarEmail(env, { to: email, subject: 'Plantare Maps · seu plano #' + plano,
    text: 'Obrigado por testar o Plantare Maps!\n\n' + linhas.join('\n') + '\n\nConfira divisas, obstáculos e raio de giro no campo antes de aplicar.',
    html: '<p>Obrigado por testar o <b>Plantare Maps</b>!</p><p>' + linhas.map(esc).join('<br>') + '</p><p>Confira divisas, obstáculos e raio de giro no campo antes de aplicar.</p>' });
  await enviarEmail(env, { to: env.AVISO_EMAIL, subject: 'Cortesia usada · ' + o.cupom.codigo + ' · ' + email,
    text: [email].concat(linhas, 'Recibo enviado: ' + (recibo ? 'sim' : 'não')).join('\n') });
  return json({ ok: true, plano, camadas: p.camadas, recibo });
}

async function consultar(id, env) {
  if (!/^[\w-]{6,64}$/.test(id)) return json({ ok: false, motivo: 'Cobrança inválida.' }, 400);
  const r = await fetch(MP + '/v1/orders/' + encodeURIComponent(id), { headers: { authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ ok: false, motivo: 'Cobrança não encontrada.' }, r.status === 404 ? 404 : 502);
  const ref = lerRef(d.external_reference);
  if (!ref) return json({ ok: false, motivo: 'Cobrança não é do Plantare.' }, 404);
  const pago = d.status === 'processed' && (d.status_detail === 'accredited' || !d.status_detail);
  return json(Object.assign({ ok: true, id: d.id, pago, encerrado: !pago && ENCERRADOS.includes(d.status), status: d.status, status_detail: d.status_detail || null,
    plano: ref.plano, camadas: ref.camadas, ha: ref.ha, valor: +d.total_amount || null }, pago ? {} : dadosPix(d)));
}

/* x-signature: "ts=...,v1=..."; manifesto "id:{data.id};request-id:{x-request-id};ts:{ts};" com HMAC-SHA256 do segredo.
   data.id alfanumérico vai em minúsculas (regra do Mercado Pago). */
export async function assinaturaValida(req, url, segredo) {
  const sig = req.headers.get('x-signature') || '', rid = req.headers.get('x-request-id') || '';
  const partes = Object.fromEntries(sig.split(',').map(s => s.trim().split('=').map(x => (x || '').trim())));
  if (!partes.ts || !partes.v1 || !segredo) return false;
  let dataId = url.searchParams.get('data.id') || '';
  if (/^[a-z0-9]+$/i.test(dataId)) dataId = dataId.toLowerCase();
  let manifesto = '';
  if (dataId) manifesto += 'id:' + dataId + ';';
  if (rid) manifesto += 'request-id:' + rid + ';';
  manifesto += 'ts:' + partes.ts + ';';
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(manifesto)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== partes.v1.length) return false;
  let dif = 0; for (let i = 0; i < hex.length; i++) dif |= hex.charCodeAt(i) ^ partes.v1.charCodeAt(i);
  return dif === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), rota = url.pathname.replace(/\/+$/, '') || '/';
    if (rota === '/webhook' && req.method === 'POST') {
      // o Mercado Pago não manda Origin: aqui vale só a assinatura
      if (!(await assinaturaValida(req, url, env.MP_WEBHOOK_SECRET))) return new Response('assinatura inválida', { status: 401 });
      // Sem banco: o app consulta /status. Se um dia precisar guardar, é aqui (KV/D1).
      return new Response('ok', { status: 200 });
    }
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: c.permitida ? 204 : 403, headers: c.headers });
    if (rota === '/saude') return json({ ok: true, servico: 'plantare-pix', tabela: PRECO.camadas, minimoHa: PRECO.minimoHa }, 200, c.headers);
    if (!c.permitida) return json({ ok: false, motivo: 'Origem não autorizada.' }, 403);
    try {
      if (rota === '/preco' && req.method === 'POST') { const o = orcar(await req.json(), env); return json(o.erro ? { ok: false, motivo: o.erro } : Object.assign({ ok: true }, o), o.erro ? 400 : 200, c.headers); }
      if (rota === '/cortesia' && req.method === 'POST') { const r = await cortesia(await req.json(), env); return new Response(r.body, { status: r.status, headers: Object.assign({}, Object.fromEntries(r.headers), c.headers) }); }
      if (rota === '/cobranca' && req.method === 'POST') { const r = await criarCobranca(await req.json(), env); return new Response(r.body, { status: r.status, headers: Object.assign({}, Object.fromEntries(r.headers), c.headers) }); }
      const m = rota.match(/^\/status\/([^/]+)$/);
      if (m && req.method === 'GET') { const r = await consultar(decodeURIComponent(m[1]), env); return new Response(r.body, { status: r.status, headers: Object.assign({}, Object.fromEntries(r.headers), c.headers) }); }
      return json({ ok: false, motivo: 'Rota não encontrada.' }, 404, c.headers);
    } catch (e) {
      return json({ ok: false, motivo: 'Erro no serviço de pagamento.' }, 500, c.headers);
    }
  }
};
export { NOMES_CAMADAS };
