/* Plantare · serviço de conta, pagamento e entrega (Cloudflare Worker + D1 + R2 + Mercado Pago + Conta Atos)

   Rotas                                                        conta?
     GET  /saude          → teste rápido                          não
     POST /preco          → orçamento (+ cupom)                   opcional   {polys, camadas, cupom?, email?}
     GET  /eu             → compras pagas da conta                sim
     POST /cobranca       → cria o Pix, registra a compra         opcional   {plano, polys, camadas, cupom?, email (sem conta)}
     POST /cortesia       → cupom de cortesia: registra, recibo   opcional   {plano, polys, camadas, cupom, email (sem conta)}
     GET  /status/:id     → pago ou não (e registra se pagou)     conta ou chave (x-plantare-acesso)
     POST /pacote         → gera os arquivos pagos                conta ou chave {pedido, entrada, acesso?}
     POST /webhook        → aviso do Mercado Pago (x-signature)   assinatura
     POST /conta/atos/ida   → começa o "Entrar com Atos"          não        {volta, criarConta?}
     POST /conta/atos/volta → confere a volta, abre a sessão      não        {url, guardar}
     POST /conta/sair       → encerra a sessão                    sim
     GET|PUT /conta/perfil  → cadastro (nota fiscal)              sim
     GET  /conta/talhoes    → talhões guardados                   sim
     PUT  /conta/talhoes/:chave  → guarda o resumo de um talhão   sim
     GET|PUT /conta/projetos/:chave → o projeto inteiro (gzip)    sim
     POST /conta/excluir    → apaga a conta                       sim        {confirmar: "EXCLUIR"}
     POST /atos/avisos      → aviso da Atos (acesso tirado)        assinatura Atos-Assinatura

   Segredos (npx wrangler secret put …): MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, ATOS_CLIENT_SECRET
   Segredos opcionais:                  AVISO_EMAIL (recebe a cópia de cada cortesia), ATOS_AVISOS_SEGREDO (avisos da Atos)
   Variáveis ([vars] no wrangler.toml):  ORIGENS, EXPIRA, REBAIXAR_DIAS, EMAIL_DE,
                                         ATOS_CLIENT_ID, ATOS_VOLTA, PAGADOR_TESTE (só em teste: "APRO")
   Dados: D1 (binding DB) e R2 (binding PROJETOS), só pelo src/dados.js
   E-mail (binding EMAIL, Cloudflare Email Service); se falhar, o download não trava

   Regras
     · o preço sai daqui, do polígono do talhão (a área que o navegador manda não vale);
     · os arquivos pagos (KML, KMZ, AB, rota, SHP, GeoJSON, CSV) só existem aqui: o app não tem o gerador;
     · cada compra é de uma conta e de um talhão (impressão digital do polígono); o arquivo sai carimbado;
     · cupom (desconto, preço fixo ou cortesia) vale uma vez por pessoa (conta ou e-mail) e uma vez por talhão,
       com as regras da tabela "cupons"; não precisa de conta;
     · tokens e chaves só como segredo do Worker. */
import { calcularPreco, areaPoligonos, PRECO, NOMES_CAMADAS } from './preco.js';
import { gerarPacote } from './exportar.js';
import { entrarComAtos } from '@atos.dev.br/entrar';
import { dados } from './dados.js';
import { FalhaAtos, novasAtos, integraAtos, criarIntencao, compraAtual, direito, listarAtos, listarCompras, receberEvento, impedirPixDuplicado } from './atos-compras.js';

const MP = 'https://api.mercadopago.com';
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {}) });
class Falha extends Error { constructor(msg, status) { super(msg); this.status = status || 400; } }

function cors(req, env) {
  const origem = req.headers.get('origin') || '';
  const ok = (env.ORIGENS || '').split(',').map(s => s.trim()).filter(Boolean);
  const permitida = ok.includes('*') || ok.includes(origem);
  return { permitida, headers: permitida ? {
    'access-control-allow-origin': origem || '*', 'vary': 'origin',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-plantare-acesso', 'access-control-max-age': '86400' } : {} };
}

/* ---------------- conta e banco ---------------- */
function bancoPronto(env) { return dados(env).pronto(); }
/* quem está chamando: o token de sessão que o Worker deu no "Entrar com Atos" */
const tokenDe = req => { const m = (req.headers.get('authorization') || '').match(/^Bearer\s+([0-9a-f]{64})$/i); return m ? m[1].toLowerCase() : null; };
async function usuario(req, env) {
  const t = tokenDe(req);
  if (!t || !bancoPronto(env)) return null;
  return dados(env).contaDaSessao(t);
}
async function exigirUsuario(req, env) {
  if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503);
  const u = await usuario(req, env);
  if (!u) throw new Falha('Entre na sua conta para continuar.', 401);
  return u;
}
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
/* e-mail de quem compra: o da conta, ou o do formulário (sem conta) */
const EMAIL_OK = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
const emailDe = (body, user) => user ? String(user.email || '').toLowerCase() : String((body && body.email) || '').trim().toLowerCase();
/* cupom vale sem conta: "uma vez por pessoa" é pela conta ou pelo e-mail, e cada cupom vale uma vez por talhão */
async function orcar(body, env, user) {
  const erro = validarPolys(body.polys); if (erro) throw new Falha(erro);
  const ha = areaPoligonos(body.polys) / 1e4;
  if (ha > PRECO.areaMaxHa) throw new Falha('Área acima do limite para compra online. Fale com a gente.');
  const cod = String(body.cupom || '').trim().toUpperCase();
  let cupom = null, desc = 0;
  if (cod) {
    const email = emailDe(body, user);
    let r = null;
    try {
      if (!bancoPronto(env)) throw new Error('sem banco');
      r = await dados(env).cupomConferir({ codigo: cod, conta: user ? user.id : null, email: EMAIL_OK(email) ? email : null,
        ha: Math.round(ha * 100) / 100, area: await hashTalhao(body.polys) });
    } catch (e) {
      // banco fora do ar ou função ainda não instalada: o preço continua saindo, só o cupom não vale agora
      console.log('cupom: ' + (e && e.message));
      return { preco: calcularPreco(ha, body.camadas, 0), cupom: { codigo: cod, valido: false, motivo: 'Não deu para conferir o cupom agora. Tente de novo em instantes.' } };
    }
    if (r && r.ok) {
      const gratis = r.gratis === true, fixo = !gratis && +r.fixo > 0 ? +r.fixo : 0, d = !gratis && !fixo ? +r.desconto || 0 : 0;
      cupom = { codigo: r.codigo, valido: true, desconto: d, fixo: fixo || null, gratis, validade: r.validade || null, ilimitado: r.ilimitado === true };
      desc = gratis ? { gratis } : fixo ? { fixo } : d;
    } else cupom = { codigo: cod, valido: false, motivo: (r && r.motivo) || 'Cupom não encontrado.' };
  }
  return { preco: calcularPreco(ha, body.camadas, desc), cupom };
}
const novaChave = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
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
  await impedirPixDuplicado(env, user, validarPolys(body.polys) ? '' : await hashTalhao(body.polys));
  if (!user && !EMAIL_OK(emailDe(body, null))) throw new Falha('Informe um e-mail válido para o comprovante.');
  const o = await orcar(body, env, user), p = o.preco;
  if (o.cupom && !o.cupom.valido) throw new Falha(o.cupom.motivo || 'Cupom inválido.');
  if (o.cupom && o.cupom.gratis) throw new Falha('Cupom de cortesia: use o botão de cortesia (não precisa de Pix).');
  if (!p.total) throw new Falha('Nada a cobrar: escolha ao menos uma camada paga.');
  if (p.total < 1) throw new Falha('Valor abaixo do mínimo do Pix.');
  if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503);
  // sem conta: o e-mail vem do formulário e a compra fica presa a uma chave que só o navegador de quem pagou guarda
  const email = user ? user.email : emailDe(body, null);
  if (!user && !EMAIL_OK(email)) throw new Falha('Informe um e-mail válido para o comprovante.');
  const acesso = user ? null : novaChave();
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
  const D = dados(env);
  await D.compraNova({ id: String(d.id), user_id: user ? user.id : null, email, acesso_hash: acesso ? await sha256(acesso) : null,
    plano, area_hash: area, ha: p.ha, camadas: p.camadas, valor: p.total, cupom: o.cupom ? o.cupom.codigo : null });
  if (o.cupom && !o.cupom.ilimitado) {
    try {
      const antiga = await D.cupomReservar({ codigo: o.cupom.codigo, conta: user ? user.id : null, email: emailDe(body, user), compra: String(d.id) });
      if (antiga) { await mpCancelar(antiga, env); await D.compraStatus(antiga, 'cancelado', true); }
    } catch (e) {
      await mpCancelar(d.id, env);
      await D.compraStatus(String(d.id), 'cancelado');
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
/* Cupom de cortesia: conferido aqui, sem Mercado Pago. Vira uma compra paga de R$ 0,00 (é ela que libera
   os arquivos em /pacote), da conta ou, sem conta, presa a uma chave de acesso; recibo e cópia para AVISO_EMAIL. */
async function cortesia(body, env, user) {
  await impedirPixDuplicado(env, user, validarPolys(body.polys) ? '' : await hashTalhao(body.polys));
  if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503);
  const email = emailDe(body, user);
  if (!user && !EMAIL_OK(email)) throw new Falha('Informe um e-mail válido para receber o recibo.');
  const o = await orcar(body, env, user), p = o.preco;
  if (!o.cupom || !o.cupom.valido || !o.cupom.gratis) throw new Falha((o.cupom && o.cupom.motivo) || 'Cupom de cortesia inválido.');
  if (!p.camadas.length) throw new Falha('Escolha ao menos uma camada.');
  const plano = limparPlano(body.plano), id = 'CORT-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const acesso = user ? null : novaChave();
  const D = dados(env);
  await D.compraNova({ id, user_id: user ? user.id : null, email, acesso_hash: acesso ? await sha256(acesso) : null,
    plano, area_hash: await hashTalhao(body.polys), ha: p.ha, camadas: p.camadas, valor: 0, cupom: o.cupom.codigo });
  if (!o.cupom.ilimitado) {
    try { await D.cupomReservar({ codigo: o.cupom.codigo, conta: user ? user.id : null, email, compra: id }); }
    catch (e) { await D.compraStatus(id, 'cancelado'); throw new Falha('Você já usou este cupom.'); }
  }
  await D.compraConfirmar(id);
  const camadas = p.camadas.map(c => NOMES_CAMADAS[c]).join(', ');
  const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const linhas = ['Plano #' + plano, p.ha.toFixed(2).replace('.', ',') + ' ha', 'Camadas: ' + camadas, 'Cupom de cortesia: ' + o.cupom.codigo, 'Valor: R$ 0,00', 'Pedido ' + id, quando];
  const recibo = await enviarEmail(env, { to: email, subject: 'Plantare Maps · seu plano #' + plano,
    text: 'Obrigado por testar o Plantare Maps!\n\n' + linhas.join('\n') + '\n\nConfira divisas, obstáculos e raio de giro no campo antes de aplicar.',
    html: '<p>Obrigado por testar o <b>Plantare Maps</b>!</p><p>' + linhas.map(escH).join('<br>') + '</p><p>Confira divisas, obstáculos e raio de giro no campo antes de aplicar.</p>' });
  await enviarEmail(env, { to: env.AVISO_EMAIL, subject: 'Cortesia usada · ' + o.cupom.codigo + ' · ' + email + (user ? '' : ' (sem conta)'),
    text: [email + (user ? '' : ' (sem conta)')].concat(linhas, 'Recibo enviado: ' + (recibo ? 'sim' : 'não')).join('\n') });
  return json(Object.assign({ ok: true, id, pago: true, plano, camadas: p.camadas, recibo }, acesso ? { acesso } : {}));
}

/* a compra é de quem está logado nela OU de quem tem a chave de acesso (compra sem conta) */
async function compraDa(env, id, user, acesso) {
  if (!/^[\w-]{6,64}$/.test(String(id || ''))) throw new Falha('Cobrança inválida.');
  if (!user && !acesso) throw new Falha('Entre na sua conta para continuar.', 401);
  const c = await dados(env).compra(String(id));
  const dono = !!(c && user && c.user_id === user.id);
  const chave = !!(c && acesso && c.acesso_hash && /^[0-9a-f]{48}$/.test(String(acesso)) && (await sha256(String(acesso))) === c.acesso_hash);
  if (!dono && !chave) throw new Falha(user ? 'Esta cobrança não é desta conta.' : 'Cobrança não encontrada neste aparelho.', 404);
  return c;
}
/* consulta o Mercado Pago e grava no banco se o Pix caiu */
async function atualizarCompra(env, c) {
  if (c.status === 'pago' || c.status === 'cancelado' || /^CORT-/.test(c.id)) return c;
  const d = await mpOrder(c.id, env);
  if (orderPaga(d)) { await dados(env).compraConfirmar(c.id); return Object.assign({}, c, { status: 'pago', pago_em: new Date().toISOString() }); }
  if (orderMorta(d)) {
    const st = d.status === 'expired' ? 'expirado' : 'cancelado';
    if (c.status === 'pendente') await dados(env).compraStatus(c.id, st, true);
    return Object.assign({}, c, { status: st });
  }
  return Object.assign({}, c, { order: d });
}
async function consultar(id, env, user, acesso) {
  if (String(id).startsWith('cmp-')) {
    const c = await compraAtual(env,user,id);
    return json({ok:true,id:c.id,pago:direito(c),encerrado:['devolvida','cancelada','expirada'].includes(c.estado),
      status:c.estado,plano:c.plano,camadas:c.camadas,ha:c.area_cent_ha/100,valor:c.centavos/100,area:c.area_hash,
      baixar_ate:c.baixar_ate,provedor:'atos',versao:c.versao},200,{'cache-control':'no-store'});
  }
  const c = await atualizarCompra(env, await compraDa(env, id, user, acesso)), pago = c.status === 'pago';
  return json(Object.assign({ ok: true, id: c.id, pago, encerrado: ['expirado', 'cancelado'].includes(c.status), status: c.status,
    plano: c.plano, camadas: c.camadas, ha: +c.ha, valor: +c.valor, area: c.area_hash }, !pago && c.order ? dadosPix(c.order) : {}));
}
async function minhasCompras(env, user) {
  const l = (await dados(env).comprasPagas(user.id)).map(c => ({ id: c.id, plano: c.plano, area_hash: c.area_hash, ha: c.ha, camadas: c.camadas, valor: c.valor,
    cupom: c.cupom, status: c.status, criado_em: c.criado_em, pago_em: c.pago_em, downloads: c.downloads }));
  return json({ ok: true, email: user.email, compras: l });
}

/* ---------------- excluir a conta ----------------
   Apaga conta, sessões, cadastro, talhões e projetos. As compras pagas ficam (obrigação fiscal),
   mas desligadas da conta: sem dono e com uma chave de acesso que ninguém tem. A Conta Atos não é tocada. */
async function excluirConta(body, env, user) {
  if (String((body && body.confirmar) || '').trim().toUpperCase() !== 'EXCLUIR') throw new Falha('Digite EXCLUIR para confirmar.');
  await dados(env).contaExcluir(user.id);
  return json({ ok: true });
}

/* ---------------- cadastro, talhões e projetos da conta ---------------- */
const soDig = s => String(s == null ? '' : s).replace(/\D/g, '');
const texto = (v, max) => { const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' '); return s.length <= max ? s : null; };
/* o cadastro para a nota fiscal: as mesmas regras que o app confere antes de mandar */
function perfilValido(b) {
  b = b || {};
  const d = { nome: texto(b.nome, 120), cpf: soDig(b.cpf), whatsapp: soDig(b.whatsapp), cep: soDig(b.cep), logradouro: texto(b.logradouro, 160),
    numero: texto(b.numero, 20), complemento: b.complemento ? texto(b.complemento, 80) : null, bairro: texto(b.bairro, 100), cidade: texto(b.cidade, 100),
    uf: String(b.uf || '').trim().toUpperCase(), ibge: b.ibge ? soDig(b.ibge) : null };
  if (!d.nome || d.nome.length < 3) throw new Falha('Informe o nome completo.');
  if (!/^\d{11}$/.test(d.cpf)) throw new Falha('CPF inválido.');
  if (!/^\d{10,11}$/.test(d.whatsapp)) throw new Falha('WhatsApp inválido.');
  if (!/^\d{8}$/.test(d.cep)) throw new Falha('CEP inválido.');
  if (!d.logradouro || !d.numero || !d.bairro || !d.cidade || (b.complemento && d.complemento === null)) throw new Falha('Confira o endereço.');
  if (!/^[A-Z]{2}$/.test(d.uf)) throw new Falha('UF inválida.');
  if (d.ibge && !/^\d{7}$/.test(d.ibge)) d.ibge = null;
  return d;
}
const CHAVE_TALHAO = /^[0-9a-f]{12,64}$/;
function talhaoValido(chave, b) {
  b = b || {};
  if (!CHAVE_TALHAO.test(chave)) throw new Falha('Talhão inválido.');
  const t = { chave, codigo: texto(b.codigo, 12), nome: texto(b.nome, 120), area_hash: b.area_hash ? String(b.area_hash) : null,
    ha: b.ha == null || b.ha === '' ? null : +b.ha, centro: b.centro || null, contorno: b.contorno || null };
  if (!t.codigo || !t.nome) throw new Falha('Talhão sem nome.');
  if (t.area_hash && !/^[0-9a-f]{64}$/.test(t.area_hash)) throw new Falha('Talhão inválido.');
  if (t.ha !== null && !isFinite(t.ha)) throw new Falha('Talhão inválido.');
  if (t.centro && !(Array.isArray(t.centro) && t.centro.length === 2 && t.centro.every(v => isFinite(v)))) throw new Falha('Talhão inválido.');
  if (t.contorno && JSON.stringify(t.contorno).length > 60000) throw new Falha('Contorno grande demais.');
  return t;
}
const PROJETO_MAX = 2 * 1024 * 1024;
async function rotaDaConta(rota, req, env, user) {
  const D = dados(env);
  if (rota === '/conta/sair' && req.method === 'POST') { await D.sessaoFim(tokenDe(req)); return json({ ok: true }); }
  if (rota === '/conta/perfil' && req.method === 'GET') return json({ ok: true, perfil: await D.perfil(user.id) });
  if (rota === '/conta/perfil' && req.method === 'PUT') { const p = perfilValido(await req.json().catch(() => null)); await D.perfilGravar(user.id, p); return json({ ok: true, perfil: p }); }
  if (rota === '/conta/talhoes' && req.method === 'GET') return json({ ok: true, talhoes: await D.talhoes(user.id) });
  let m = rota.match(/^\/conta\/talhoes\/([^/]+)$/);
  if (m && req.method === 'PUT') { await D.talhaoGravar(user.id, talhaoValido(m[1], await req.json().catch(() => null))); return json({ ok: true }); }
  m = rota.match(/^\/conta\/projetos\/([^/]+)$/);
  if (m) {
    if (!CHAVE_TALHAO.test(m[1])) throw new Falha('Talhão inválido.');
    if (!D.projetosPronto()) throw new Falha('Serviço sem armazenamento de projetos.', 503);
    if (req.method === 'PUT') {
      const corpo = await req.arrayBuffer();
      if (!corpo.byteLength || corpo.byteLength > PROJETO_MAX) throw new Falha('Projeto grande demais para guardar na conta (até 2 MB comprimido).', 413);
      const b = new Uint8Array(corpo, 0, 2); if (b[0] !== 0x1f || b[1] !== 0x8b) throw new Falha('O projeto precisa vir comprimido (gzip).');
      await D.projetoGravar(user.id, m[1], corpo); return json({ ok: true });
    }
    if (req.method === 'GET') {
      const corpo = await D.projetoLer(user.id, m[1]);
      if (!corpo) throw new Falha('O projeto deste talhão não está na sua conta.', 404);
      return new Response(corpo, { headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' } });
    }
  }
  return null;
}

/* ---------------- Conta Atos ----------------
   O login é a Conta Atos (OpenID Connect com PKCE, pelo @atos.dev.br/entrar). Daqui sai a ida (state, nonce e
   code_verifier, que o navegador guarda) e, na volta, a troca do código e a conferência do id_token. Depois
   a conta do Plantare (uma por sub da Atos, criada na primeira entrada) ganha uma sessão: um token aleatório
   de 30 dias, do qual o banco guarda só o SHA-256. */
function atosPronto(env) { return !!(env.ATOS_CLIENT_ID && env.ATOS_VOLTA && bancoPronto(env)); }
/* a volta é a página do app; mais de uma (ex.: teste local) vai separada por vírgula, todas cadastradas na Atos */
function clienteAtos(env, volta) {
  const voltas = String(env.ATOS_VOLTA).split(',').map(s => s.trim()).filter(Boolean);
  return entrarComAtos({ clientId: env.ATOS_CLIENT_ID, voltaPara: voltas.includes(volta) ? volta : voltas[0], emissor: env.ATOS_EMISSOR || undefined, fetch: (u, o) => fetch(u, o) });
}
async function atosIda(body, env) {
  const { url, guardar } = await clienteAtos(env, body && body.volta).comecar({ criarConta: !!(body && body.criarConta) });
  return json({ ok: true, url, guardar });
}
async function atosVolta(body, env) {
  let p;
  try { p = await clienteAtos(env, body && body.guardar && body.guardar.voltaPara).concluir(String((body && body.url) || ''), body && body.guardar); }
  catch (e) {
    if (e && e.name === 'ErroAtos') throw new Falha(e.message, e.codigo === 'access_denied' ? 403 : e.codigo === 'rede' || e.codigo === 'descoberta' ? 502 : 400);
    throw e;
  }
  if (!p.email || !p.emailVerificado) throw new Falha('O e-mail da sua Conta Atos ainda não foi confirmado. Confirme na Atos e entre de novo.', 403);
  const D = dados(env);
  const conta = await D.contaDaAtos({ sub: p.id, email: p.email.toLowerCase(), nome: p.nome });
  const s = await D.sessaoNova(conta.id);
  return json({ ok: true, access_token: s.token, expira: s.expira, email: conta.email, nome: conta.nome || '' });
}

/* ---------------- avisos da Atos ----------------
   A Atos manda um POST para /atos/avisos quando alguém tira a permissão do Plantare em Minha conta
   (acesso.revogado) ou sai da lista de liberados (liberado.removido): as sessões dessa pessoa acabam na hora.
   Assinatura no cabeçalho Atos-Assinatura: "t=<segundos>,v1=<HMAC-SHA256 hex de '<t>.<corpo>'>", com o
   segredo ATOS_AVISOS_SEGREDO; aviso com mais de 5 minutos não vale. Repetir o mesmo aviso não faz mal
   (apagar o que já foi apagado). */
async function avisoAtosValido(corpo, cabecalho, segredo) {
  const p = {};
  for (const parte of String(cabecalho || '').split(',')) { const i = parte.indexOf('='); if (i > 0) p[parte.slice(0, i).trim()] = parte.slice(i + 1).trim(); }
  const t = Number(p.t);
  if (!t || !/^[0-9a-f]{64}$/i.test(p.v1 || '') || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const certo = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(t + '.' + corpo)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const dado = p.v1.toLowerCase(); let dif = 0;
  for (let i = 0; i < certo.length; i++) dif |= certo.charCodeAt(i) ^ dado.charCodeAt(i);
  return dif === 0;
}
async function avisoAtos(req, env) {
  if (!env.ATOS_AVISOS_SEGREDO || !bancoPronto(env)) return new Response('avisos não configurados', { status: 503 });
  const corpo = await req.text();
  if (!(await avisoAtosValido(corpo, req.headers.get('atos-assinatura'), env.ATOS_AVISOS_SEGREDO))) return new Response('assinatura inválida', { status: 401 });
  let a; try { a = JSON.parse(corpo); } catch (e) { return new Response('aviso inválido', { status: 400 }); }
  const D = dados(env), d = (a && a.dados) || {};
  if (a.tipo === 'acesso.revogado' && d.sub) await D.sessoesFimDaAtos({ sub: d.sub });
  if (a.tipo === 'liberado.removido') for (const p of Array.isArray(d.pessoas) ? d.pessoas : []) if (p && (p.sub || p.email)) await D.sessoesFimDaAtos(p);
  return new Response('ok', { status: 200 });
}

/* ---------------- entrega ---------------- */
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
async function entregar(body, env, user) {
  const e = body && body.entrada;
  if (!e || validarPolys(e.polys)) throw new Falha('Plano inválido.');
  let c;
  const central = String(body.pedido || '').startsWith('cmp-');
  if (central) {
    const s = await compraAtual(env,user,body.pedido);
    if (!direito(s)) throw new Falha('Esta compra não tem direito de download ativo.',403);
    if (e.camadas !== undefined && (!Array.isArray(e.camadas) || e.camadas.some(k => !s.camadas.includes(k))))
      throw new Falha('Camadas fora do escopo da compra.',403);
    c = {...s,status:'pago',email:user.email,ha:s.area_cent_ha/100,valor:s.centavos/100};
  } else c = await atualizarCompra(env, await compraDa(env, body.pedido, user, body.acesso));
  if (c.status !== 'pago') throw new Falha('Pagamento ainda não confirmado.', 402);
  if (await hashTalhao(e.polys) !== c.area_hash) throw new Falha('Este pagamento é de outro talhão.', 403);
  const dias = +(env.REBAIXAR_DIAS || 365);
  if (!central && dias > 0 && c.pago_em && Date.now() - Date.parse(c.pago_em) > dias * 864e5) throw new Falha('Esta compra tem mais de ' + dias + ' dias. Gere um novo Pix para baixar de novo.', 403);
  const quando = new Date().toISOString().slice(0, 10);
  const texto = 'Licenciado a ' + (user ? user.email : c.email) + ' · pedido ' + c.id + ' · plano #' + c.plano + ' · ' + quando + ' · Plantare Maps';
  let r;
  try { r = gerarPacote(e, { camadas: c.camadas, texto }); } catch (err) { throw new Falha(err.message || 'Plano inválido.'); }
  const enc = new TextEncoder();
  r.arquivos.push({ name: 'LICENCA.txt', data: enc.encode(texto.replace(/ · /g, '\r\n') + '\r\nCamadas: ' + c.camadas.map(k => NOMES_CAMADAS[k] || k).join(', ') + '\r\n') });
  try {
    if (central) await env.DB.prepare('update atos_compras set downloads=downloads+1,ultimo_download=? where id=?').bind(new Date().toISOString(),c.id).run();
    else await dados(env).compraBaixada(c.id, (c.downloads || 0) + 1);
  } catch (err) { /* contador não impede a entrega */ }
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
  if (lerRef(d.external_reference) && orderPaga(d)) await dados(env).compraConfirmar(String(d.id));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), rota = url.pathname.replace(/\/+$/, '') || '/';
    if (rota === '/api/atos/eventos' && req.method === 'POST') {
      try { return json(await receberEvento(req,env),200,{'cache-control':'no-store'}); }
      catch (e) { return json({ok:false,motivo:e instanceof FalhaAtos ? e.message : 'Evento não persistido; tente novamente.'},e instanceof FalhaAtos ? e.status : 503,{'cache-control':'no-store'}); }
    }
    if (rota === '/webhook' && req.method === 'POST') {
      // o Mercado Pago não manda Origin: aqui vale só a assinatura
      if (!(await assinaturaValida(req, url, env.MP_WEBHOOK_SECRET))) return new Response('assinatura inválida', { status: 401 });
      try { await avisoRecebido(req, url, env); } catch (e) { return new Response('tente de novo', { status: 500 }); }
      return new Response('ok', { status: 200 });
    }
    // a Atos também não manda Origin: vale a assinatura do aviso
    if (rota === '/atos/avisos' && req.method === 'POST') {
      try { return await avisoAtos(req, env); } catch (e) { console.log('aviso da Atos: ' + (e && e.message)); return new Response('tente de novo', { status: 500 }); }
    }
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: c.permitida ? 204 : 403, headers: c.headers });
    if (rota === '/saude') return json({ ok: true, servico: 'plantare-pix', banco: bancoPronto(env), tabela: PRECO.camadas, minimoHa: PRECO.minimoHa, checkout_atos:novasAtos(env) }, 200, c.headers);
    if (!c.permitida) return json({ ok: false, motivo: 'Origem não autorizada.' }, 403);
    const com = r => new Response(r.body, { status: r.status, headers: Object.assign({}, Object.fromEntries(r.headers), c.headers) });
    try {
      if (rota === '/atos/intencoes' && req.method === 'POST') {
        const u = await exigirUsuario(req,env), b = await req.json();
        const erro = validarPolys(b.polys); if (erro) throw new Falha(erro);
        if (!Array.isArray(b.camadas) || !b.camadas.length || b.camadas.some(k => !Object.hasOwn(NOMES_CAMADAS,k)) || new Set(b.camadas).size !== b.camadas.length)
          throw new Falha('Escolha camadas válidas, sem duplicatas.');
        const area_cent_ha = Math.round(areaPoligonos(b.polys)/100);
        if (area_cent_ha < 1 || area_cent_ha > 5000000) throw new Falha('Área fora do limite para compra online.');
        const cupom = b.cupom == null || b.cupom === '' ? null : String(b.cupom).trim().toUpperCase();
        if (cupom && !/^[A-Z0-9_-]{3,32}$/.test(cupom)) throw new Falha('Cupom inválido.');
        return com(json(await criarIntencao(env,u,b,{area_hash:await hashTalhao(b.polys),area_cent_ha,
          camadas:Object.keys(NOMES_CAMADAS).filter(k => b.camadas.includes(k)),cupom}),200,{'cache-control':'no-store'}));
      }
      if (rota === '/atos/compras' && req.method === 'GET') {
        const u=await exigirUsuario(req,env);
        if ([...url.searchParams.keys()].some(k => !['limite','cursor'].includes(k) || url.searchParams.getAll(k).length!==1)) throw new Falha('Parâmetros inválidos.');
        return com(json({ok:true,...await listarAtos(env,u,url.searchParams.get('limite') || '25',url.searchParams.get('cursor'))},200,{'cache-control':'no-store'}));
      }
      if (rota === '/preco' && req.method === 'POST') {
        const user = await usuario(req, env).catch(() => null);
        return json(Object.assign({ ok: true }, await orcar(await req.json(), env, user)), 200, c.headers);
      }
      if (rota === '/eu' && req.method === 'GET') {
        const u=await exigirUsuario(req,env);
        if (url.search) {
          if ([...url.searchParams.keys()].some(k=>!['limite','cursor'].includes(k)||url.searchParams.getAll(k).length!==1)) throw new Falha('Parâmetros inválidos.');
          return com(json(await listarCompras(env,u,url.searchParams.get('limite') || '50',url.searchParams.get('cursor')),200,{'cache-control':'no-store'}));
        }
        return com(await minhasCompras(env,u)); // contrato antigo, para apps já instalados
      }
      if ((rota === '/conta/atos/ida' || rota === '/conta/atos/volta') && req.method === 'POST') {
        if (!atosPronto(env)) throw new Falha('O login pela Conta Atos ainda não está configurado.', 503);
        const body = await req.json().catch(() => ({}));
        return com(rota === '/conta/atos/ida' ? await atosIda(body, env) : await atosVolta(body, env));
      }
      if (rota === '/conta/excluir' && req.method === 'POST') { const u = await exigirUsuario(req, env); return com(await excluirConta(await req.json().catch(() => ({})), env, u)); }
      if (rota.startsWith('/conta/')) { const r = await rotaDaConta(rota, req, env, await exigirUsuario(req, env)); if (r) return com(r); }
      // Pix e download: com conta ou sem (sem conta vale a chave de acesso guardada no navegador)
      if (rota === '/cobranca' && req.method === 'POST') { const u = await usuario(req, env); return com(await criarCobranca(await req.json(), env, u)); }
      if (rota === '/cortesia' && req.method === 'POST') { const u = await usuario(req, env); return com(await cortesia(await req.json(), env, u)); }
      if (rota === '/pacote' && req.method === 'POST') { if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503); const u = await usuario(req, env); return com(await entregar(await req.json(), env, u)); }
      const m = rota.match(/^\/status\/([^/]+)$/);
      if (m && req.method === 'GET') { if (!bancoPronto(env)) throw new Falha('Serviço sem banco configurado.', 503); const u = await usuario(req, env); return com(await consultar(decodeURIComponent(m[1]), env, u, req.headers.get('x-plantare-acesso'))); }
      return json({ ok: false, motivo: 'Rota não encontrada.' }, 404, c.headers);
    } catch (e) {
      if (e instanceof Falha || e instanceof FalhaAtos) return json({ ok: false, motivo: e.message }, e.status, {...c.headers,'cache-control':'no-store'});
      console.log('erro ' + rota + ': ' + (e && (e.stack || e.message)));
      return json({ ok: false, motivo: 'Erro no serviço de pagamento.' }, 500, c.headers);
    }
  }
};
export { NOMES_CAMADAS, hashTalhao, lerRef };
