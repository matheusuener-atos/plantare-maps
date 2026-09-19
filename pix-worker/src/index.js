/* Plantare · serviço de pagamento e entrega (Cloudflare Worker + Mercado Pago + Supabase)

   Rotas                                                        conta?
     GET  /saude          → teste rápido                          não
     POST /preco          → orçamento (+ cupom da conta)          opcional   {polys, camadas, cupom?}
     GET  /eu             → compras pagas da conta                sim
     POST /cobranca       → cria o Pix, registra a compra         sim        {plano, polys, camadas, cupom?}
     POST /cortesia       → cupom de cortesia: registra, recibo   sim        {plano, polys, camadas, cupom}
     GET  /status/:id     → pago ou não (e registra se pagou)     sim
     POST /pacote         → gera os arquivos pagos                sim        {pedido, entrada}
     POST /webhook        → aviso do Mercado Pago (x-signature)   assinatura

   Segredos (npx wrangler secret put …): MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, SUPABASE_SERVICE_KEY
   Segredo opcional:                    AVISO_EMAIL (recebe a cópia de cada cortesia)
   Variáveis ([vars] no wrangler.toml):  ORIGENS, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, EXPIRA, REBAIXAR_DIAS, EMAIL_DE,
                                         PAGADOR_TESTE (só em teste: "APRO")
   E-mail (binding EMAIL, Cloudflare Email Service); se falhar, o download não trava

   Regras
     · o preço sai daqui, do polígono do talhão (a área que o navegador manda não vale);
     · os arquivos pagos (KML, KMZ, AB, rota, SHP, GeoJSON, CSV) só existem aqui: o app não tem o gerador;
     · cada compra é de uma conta e de um talhão (impressão digital do polígono); o arquivo sai carimbado;
     · cupom (desconto, preço fixo ou cortesia) vale uma vez por conta, com as regras da tabela "cupons";
     · tokens e chaves só como segredo do Worker. */
import { calcularPreco, areaPoligonos, PRECO, NOMES_CAMADAS } from './preco.js';
import { gerarPacote } from './exportar.js';

const MP = 'https://api.mercadopago.com';
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {}) });
class Falha extends Error { constructor(msg, status) { super(msg); this.status = status || 400; } }

function cors(req, env) {
  const origem = req.headers.get('origin') || '';
  const ok = (env.ORIGENS || '').split(',').map(s => s.trim()).filter(Boolean);
  const permitida = ok.includes('*') || ok.includes(origem);
  return { permitida, headers: permitida ? {
    'access-control-allow-origin': origem || '*', 'vary': 'origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-plantare-acesso', 'access-control-max-age': '86400' } : {} };
}

/* ---------------- Supabase ---------------- */
function bancoPronto(env) { return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY); }
/* quem está chamando: confere o token de login no próprio Supabase */
async function usuario(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+([\w.-]{20,4096})$/i);
  if (!m || !bancoPronto(env)) return null;
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + m[1] } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id && u.email ? { id: u.id, email: String(u.email).toLowerCase() } : null;
}
async function exigirUsuario(req, env) {
  if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503);
  const u = await usuario(req, env);
  if (!u) throw new Falha('Entre na sua conta para continuar.', 401);
  return u;
}
/* banco pela API REST, com a chave secreta (passa por cima do RLS; nunca sai do Worker) */
async function sb(env, caminho, op) {
  op = op || {};
  const k = env.SUPABASE_SERVICE_KEY;
  const h = { apikey: k, 'content-type': 'application/json', accept: 'application/json' };
  if (/^eyJ/.test(k)) h.authorization = 'Bearer ' + k;      // chave antiga (service_role JWT)
  if (op.prefer) h.prefer = op.prefer;
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + caminho, { method: op.method || 'GET', headers: h, body: op.body !== undefined ? JSON.stringify(op.body) : undefined });
  const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  if (!r.ok) { const e = new Error('banco ' + r.status + ': ' + String((d && d.message) || t).slice(0, 200)); e.banco = d; throw e; }
  return d;
}
const rpc = (env, fn, args) => sb(env, 'rpc/' + fn, { method: 'POST', body: args });
const q = encodeURIComponent;

/* ---------------- talhão ---------------- */
/* polígonos do app: [{outer:[[lon,lat]...], holes:[[...]]}] — confere formato e tamanho */
/* Sem limite de partes (um mapa de dessecação pode ter milhares de manchas). O que protege o servidor
   é o total de pontos: 300 mil é folgado para talhões reais e leva poucos ms para medir. */
const MAX_PONTOS = 300000;
function validarPolys(polys) {
  if (!Array.isArray(polys) || !polys.length) return 'Talhão inválido.';
  let n = 0;
  const pontoOk = p => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  const anelOk = r => Array.isArray(r) && r.length >= 3 && r.every(pontoOk);
  for (const p of polys) {
    if (!p || !anelOk(p.outer)) return 'Talhão inválido.';
    n += p.outer.length;
    for (const h of p.holes || []) { if (!anelOk(h)) return 'Obstáculo inválido.'; n += h.length; }
    if (n > MAX_PONTOS) return 'Talhão grande demais para compra online (mais de 300 mil pontos). Fale com a gente.';
  }
  return null;
}
const sha256 = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
/* impressão digital do talhão: o mesmo polígono dá sempre o mesmo código */
async function hashTalhao(polys) {
  const r7 = v => Math.round(v * 1e7) / 1e7, anel = r => r.map(p => [r7(+p[0]), r7(+p[1])]);
  const canon = JSON.stringify(polys.map(p => [anel(p.outer), (p.holes || []).map(anel)]));
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon)));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- preço e cupom ---------------- */
async function orcar(body, env, user) {
  const erro = validarPolys(body.polys); if (erro) throw new Falha(erro);
  const ha = areaPoligonos(body.polys) / 1e4;
  if (ha > PRECO.areaMaxHa) throw new Falha('Área acima do limite para compra online. Fale com a gente.');
  const cod = String(body.cupom || '').trim().toUpperCase();
  let cupom = null, desc = 0;
  if (cod) {
    if (!user) cupom = { codigo: cod, valido: false, motivo: 'Entre na sua conta para usar cupom.' };
    else {
      const r = await rpc(env, 'plantare_cupom', { p_codigo: cod, p_user: user.id, p_ha: Math.round(ha * 100) / 100 });
      if (r && r.ok) {
        const gratis = r.gratis === true, fixo = !gratis && +r.fixo > 0 ? +r.fixo : 0, d = !gratis && !fixo ? +r.desconto || 0 : 0;
        cupom = { codigo: r.codigo, valido: true, desconto: d, fixo: fixo || null, gratis, validade: r.validade || null };
        desc = gratis ? { gratis } : fixo ? { fixo } : d;
      } else cupom = { codigo: cod, valido: false, motivo: (r && r.motivo) || 'Cupom não encontrado.' };
    }
  }
  return { preco: calcularPreco(ha, body.camadas, desc), cupom };
}
/* referência curta que volta na order: plantare-plano-camadas-centésimos de ha (ex.: plantare-1LKP5C-ABP-282).
   A Orders API só aceita letras, números, - e _ (máx. 64). */
const COD = { linhas_ab: 'A', bordadura: 'B', percurso: 'P', manobras: 'M' };
const limparPlano = p => String(p || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'plano';
const refDe = (plano, camadas, ha) => ['plantare', limparPlano(plano), camadas.map(c => COD[c]).join(''), Math.round(ha * 100)].join('-');
function lerRef(ref) {
  const [app, plano, cods, cent] = String(ref || '').split('-');
  if (app !== 'plantare') return null;
  const inv = Object.fromEntries(Object.entries(COD).map(([k, v]) => [v, k]));
  return { plano, camadas: [...(cods || '')].map(c => inv[c]).filter(Boolean), ha: +cent / 100 };
}
/* QR / copia e cola da order. A criação pode ser assíncrona (status processing/in_process):
   aí esses campos chegam vazios e aparecem depois, na consulta de /status. */
function dadosPix(d) {
  const pg = (d.transactions && d.transactions.payments && d.transactions.payments[0]) || {}, pm = pg.payment_method || {};
  return { qr_code: pm.qr_code || null, qr_code_base64: pm.qr_code_base64 || null, ticket_url: pm.ticket_url || null, expira: pg.date_of_expiration || null };
}

/* ---------------- Mercado Pago ---------------- */
async function mpOrder(id, env) {
  const r = await fetch(MP + '/v1/orders/' + q(id), { headers: { authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Falha('Cobrança não encontrada no Mercado Pago.', r.status === 404 ? 404 : 502);
  return d;
}
const orderPaga = d => d.status === 'processed' && (d.status_detail === 'accredited' || !d.status_detail);
const orderMorta = d => ['expired', 'canceled', 'cancelled', 'failed', 'refunded', 'charged_back'].includes(d.status);
async function mpCancelar(id, env) {
  try { await fetch(MP + '/v1/orders/' + q(id) + '/cancel', { method: 'POST', headers: { authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, 'x-idempotency-key': 'cancel-' + id } }); } catch (e) { /* segue: a reserva do cupom já mudou */ }
}

async function criarCobranca(body, env, user) {
  const o = await orcar(body, env, user), p = o.preco;
  if (o.cupom && !o.cupom.valido) throw new Falha(o.cupom.motivo || 'Cupom inválido.');
  if (o.cupom && o.cupom.gratis) throw new Falha('Cupom de cortesia: use o botão de cortesia (não precisa de Pix).');
  if (!p.total) throw new Falha('Nada a cobrar: escolha ao menos uma camada paga.');
  if (p.total < 1) throw new Falha('Valor abaixo do mínimo do Pix.');
  if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503);
  // sem conta: o e-mail vem do formulário e a compra fica presa a uma chave que só o navegador de quem pagou guarda
  const email = user ? user.email : String(body.email || '').trim().toLowerCase();
  if (!user && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new Falha('Informe um e-mail válido para o comprovante.');
  const acesso = user ? null : [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
  const plano = limparPlano(body.plano);
  const area = await hashTalhao(body.polys);
  const valor = p.total.toFixed(2);
  const pedido = {
    type: 'online', total_amount: valor, external_reference: refDe(plano, p.camadas, p.ha), processing_mode: 'automatic',
    description: 'Plantare Maps · plano ' + plano + ' · ' + p.ha.toFixed(2) + ' ha',
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
  await sb(env, 'compras', { method: 'POST', prefer: 'return=minimal', body: {
    id: String(d.id), user_id: user ? user.id : null, email, acesso_hash: acesso ? await sha256(acesso) : null,
    plano, area_hash: area, ha: p.ha, camadas: p.camadas, valor: p.total, cupom: o.cupom ? o.cupom.codigo : null } });
  if (o.cupom) {
    try {
      const antiga = await rpc(env, 'plantare_reservar_cupom', { p_codigo: o.cupom.codigo, p_user: user.id, p_compra: String(d.id) });
      if (antiga) { await mpCancelar(antiga, env); await sb(env, 'compras?id=eq.' + q(antiga) + '&status=eq.pendente', { method: 'PATCH', prefer: 'return=minimal', body: { status: 'cancelado' } }); }
    } catch (e) {
      await mpCancelar(d.id, env);
      await sb(env, 'compras?id=eq.' + q(d.id), { method: 'PATCH', prefer: 'return=minimal', body: { status: 'cancelado' } });
      throw new Falha('Você já usou este cupom.');
    }
  }
  return json(Object.assign({ ok: true, id: d.id, status: d.status, valor: p.total, preco: p, cupom: o.cupom }, acesso ? { acesso } : {}, dadosPix(d)));
}

const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function enviarEmail(env, msg) {
  if (!env.EMAIL || !msg.to) return false;
  try { await env.EMAIL.send(Object.assign({ from: env.EMAIL_DE || 'nao-responda@plantaremaps.com.br' }, msg)); return true; }
  catch (e) { console.log('e-mail não enviado', e && (e.code || e.message)); return false; }
}
/* Cupom de cortesia: conferido aqui, sem Mercado Pago. Vira uma compra paga de R$ 0,00 da conta
   (é ela que libera os arquivos em /pacote); recibo para a conta e cópia para AVISO_EMAIL. */
async function cortesia(body, env, user) {
  const o = await orcar(body, env, user), p = o.preco;
  if (!o.cupom || !o.cupom.valido || !o.cupom.gratis) throw new Falha((o.cupom && o.cupom.motivo) || 'Cupom de cortesia inválido.');
  if (!p.camadas.length) throw new Falha('Escolha ao menos uma camada.');
  const plano = limparPlano(body.plano), id = 'CORT-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await sb(env, 'compras', { method: 'POST', prefer: 'return=minimal', body: {
    id, user_id: user.id, email: user.email, plano, area_hash: await hashTalhao(body.polys), ha: p.ha, camadas: p.camadas, valor: 0, cupom: o.cupom.codigo } });
  try { await rpc(env, 'plantare_reservar_cupom', { p_codigo: o.cupom.codigo, p_user: user.id, p_compra: id }); }
  catch (e) { await sb(env, 'compras?id=eq.' + q(id), { method: 'PATCH', prefer: 'return=minimal', body: { status: 'cancelado' } }); throw new Falha('Você já usou este cupom.'); }
  await rpc(env, 'plantare_confirmar', { p_compra: id });
  const camadas = p.camadas.map(c => NOMES_CAMADAS[c]).join(', ');
  const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const linhas = ['Plano #' + plano, p.ha.toFixed(2).replace('.', ',') + ' ha', 'Camadas: ' + camadas, 'Cupom de cortesia: ' + o.cupom.codigo, 'Valor: R$ 0,00', 'Pedido ' + id, quando];
  const recibo = await enviarEmail(env, { to: user.email, subject: 'Plantare Maps · seu plano #' + plano,
    text: 'Obrigado por testar o Plantare Maps!\n\n' + linhas.join('\n') + '\n\nConfira divisas, obstáculos e raio de giro no campo antes de aplicar.',
    html: '<p>Obrigado por testar o <b>Plantare Maps</b>!</p><p>' + linhas.map(escH).join('<br>') + '</p><p>Confira divisas, obstáculos e raio de giro no campo antes de aplicar.</p>' });
  await enviarEmail(env, { to: env.AVISO_EMAIL, subject: 'Cortesia usada · ' + o.cupom.codigo + ' · ' + user.email,
    text: [user.email].concat(linhas, 'Recibo enviado: ' + (recibo ? 'sim' : 'não')).join('\n') });
  return json({ ok: true, id, pago: true, plano, camadas: p.camadas, recibo });
}

/* a compra é de quem está logado nela OU de quem tem a chave de acesso (compra sem conta) */
async function compraDa(env, id, user, acesso) {
  if (!/^[\w-]{6,64}$/.test(String(id || ''))) throw new Falha('Cobrança inválida.');
  if (!user && !acesso) throw new Falha('Entre na sua conta para continuar.', 401);
  const l = await sb(env, 'compras?id=eq.' + q(id) + '&select=*');
  const c = l && l[0];
  const dono = !!(c && user && c.user_id === user.id);
  const chave = !!(c && acesso && c.acesso_hash && /^[0-9a-f]{48}$/.test(String(acesso)) && (await sha256(String(acesso))) === c.acesso_hash);
  if (!dono && !chave) throw new Falha(user ? 'Esta cobrança não é desta conta.' : 'Cobrança não encontrada neste aparelho.', 404);
  return c;
}
/* consulta o Mercado Pago e grava no banco se o Pix caiu */
async function atualizarCompra(env, c) {
  if (c.status === 'pago' || c.status === 'cancelado' || /^CORT-/.test(c.id)) return c;
  const d = await mpOrder(c.id, env);
  if (orderPaga(d)) { await rpc(env, 'plantare_confirmar', { p_compra: c.id }); return Object.assign({}, c, { status: 'pago', pago_em: new Date().toISOString() }); }
  if (orderMorta(d)) {
    const st = d.status === 'expired' ? 'expirado' : 'cancelado';
    if (c.status === 'pendente') await sb(env, 'compras?id=eq.' + q(c.id), { method: 'PATCH', prefer: 'return=minimal', body: { status: st } });
    return Object.assign({}, c, { status: st });
  }
  return Object.assign({}, c, { order: d });
}
async function consultar(id, env, user, acesso) {
  const c = await atualizarCompra(env, await compraDa(env, id, user, acesso)), pago = c.status === 'pago';
  return json(Object.assign({ ok: true, id: c.id, pago, encerrado: ['expirado', 'cancelado'].includes(c.status), status: c.status,
    plano: c.plano, camadas: c.camadas, ha: +c.ha, valor: +c.valor, area: c.area_hash }, !pago && c.order ? dadosPix(c.order) : {}));
}
async function minhasCompras(env, user) {
  const l = await sb(env, 'compras?user_id=eq.' + q(user.id) + '&status=eq.pago&select=id,plano,area_hash,ha,camadas,valor,pago_em,downloads&order=pago_em.desc&limit=200');
  return json({ ok: true, email: user.email, compras: l || [] });
}

/* ---------------- entrega ---------------- */
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
async function entregar(body, env, user) {
  const e = body && body.entrada;
  if (!e || validarPolys(e.polys)) throw new Falha('Plano inválido.');
  const c = await atualizarCompra(env, await compraDa(env, body.pedido, user, body.acesso));
  if (c.status !== 'pago') throw new Falha('Pagamento ainda não confirmado.', 402);
  if (await hashTalhao(e.polys) !== c.area_hash) throw new Falha('Este pagamento é de outro talhão.', 403);
  const dias = +(env.REBAIXAR_DIAS || 365);
  if (dias > 0 && c.pago_em && Date.now() - Date.parse(c.pago_em) > dias * 864e5) throw new Falha('Esta compra tem mais de ' + dias + ' dias. Gere um novo Pix para baixar de novo.', 403);
  const quando = new Date().toISOString().slice(0, 10);
  const texto = 'Licenciado a ' + (user ? user.email : c.email) + ' · pedido ' + c.id + ' · plano #' + c.plano + ' · ' + quando + ' · Plantare Maps';
  let r;
  try { r = gerarPacote(e, { camadas: c.camadas, texto }); } catch (err) { throw new Falha(err.message || 'Plano inválido.'); }
  const enc = new TextEncoder();
  r.arquivos.push({ name: 'LICENCA.txt', data: enc.encode(texto.replace(/ · /g, '\r\n') + '\r\nCamadas: ' + c.camadas.map(k => NOMES_CAMADAS[k] || k).join(', ') + '\r\n') });
  try { await sb(env, 'compras?id=eq.' + q(c.id), { method: 'PATCH', prefer: 'return=minimal', body: { downloads: (c.downloads || 0) + 1, ultimo_download: new Date().toISOString() } }); } catch (err) { /* contador não impede a entrega */ }
  return json({ ok: true, pedido: c.id, camadas: c.camadas, negados: r.negados, costura: r.costura, arquivos: r.arquivos.map(a => ({ name: a.name, b64: b64(a.data) })) });
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
/* aviso do Mercado Pago: grava o pagamento mesmo que o navegador já tenha fechado */
async function avisoRecebido(req, url, env) {
  const id = url.searchParams.get('data.id') || ((await req.json().catch(() => ({}))).data || {}).id;
  if (!id || !bancoPronto(env)) return;
  let d;
  // order que o Mercado Pago não conhece (teste, outro sistema): responde 200, senão ele reenvia sem parar
  try { d = await mpOrder(id, env); } catch (e) { if (e instanceof Falha && e.status === 404) return; throw e; }
  if (lerRef(d.external_reference) && orderPaga(d)) await rpc(env, 'plantare_confirmar', { p_compra: String(d.id) });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), rota = url.pathname.replace(/\/+$/, '') || '/';
    if (rota === '/webhook' && req.method === 'POST') {
      // o Mercado Pago não manda Origin: aqui vale só a assinatura
      if (!(await assinaturaValida(req, url, env.MP_WEBHOOK_SECRET))) return new Response('assinatura inválida', { status: 401 });
      try { await avisoRecebido(req, url, env); } catch (e) { return new Response('tente de novo', { status: 500 }); }
      return new Response('ok', { status: 200 });
    }
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: c.permitida ? 204 : 403, headers: c.headers });
    if (rota === '/saude') return json({ ok: true, servico: 'plantare-pix', banco: bancoPronto(env), tabela: PRECO.camadas, minimoHa: PRECO.minimoHa }, 200, c.headers);
    if (!c.permitida) return json({ ok: false, motivo: 'Origem não autorizada.' }, 403);
    const com = r => new Response(r.body, { status: r.status, headers: Object.assign({}, Object.fromEntries(r.headers), c.headers) });
    try {
      if (rota === '/preco' && req.method === 'POST') {
        const user = await usuario(req, env).catch(() => null);
        return json(Object.assign({ ok: true }, await orcar(await req.json(), env, user)), 200, c.headers);
      }
      if (rota === '/eu' && req.method === 'GET') return com(await minhasCompras(env, await exigirUsuario(req, env)));
      // Pix e download: com conta ou sem (sem conta vale a chave de acesso guardada no navegador)
      if (rota === '/cobranca' && req.method === 'POST') { const u = await usuario(req, env); return com(await criarCobranca(await req.json(), env, u)); }
      if (rota === '/cortesia' && req.method === 'POST') { const u = await exigirUsuario(req, env); return com(await cortesia(await req.json(), env, u)); }
      if (rota === '/pacote' && req.method === 'POST') { if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503); const u = await usuario(req, env); return com(await entregar(await req.json(), env, u)); }
      const m = rota.match(/^\/status\/([^/]+)$/);
      if (m && req.method === 'GET') { if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503); const u = await usuario(req, env); return com(await consultar(decodeURIComponent(m[1]), env, u, req.headers.get('x-plantare-acesso'))); }
      return json({ ok: false, motivo: 'Rota não encontrada.' }, 404, c.headers);
    } catch (e) {
      if (e instanceof Falha) return json({ ok: false, motivo: e.message }, e.status, c.headers);
      return json({ ok: false, motivo: 'Erro no serviço de pagamento.' }, 500, c.headers);
    }
  }
};
export { NOMES_CAMADAS, hashTalhao, lerRef };
