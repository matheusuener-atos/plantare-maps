/* Mercado Pago e Atos de mentira, e um D1 e um R2 locais, para testar o Worker sem rede.
   O D1 é um SQLite de verdade (node:sqlite) com a mesma migração que vai ao ar (migrations/0001_inicial.sql).
   instalarFalsos() troca o fetch global; devolve o estado para os testes mexerem. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

/* o D1 por cima de um SQLite: prepare/bind/first/all/run e batch (numa transação) */
function d1(db, E) {
  const conv = a => a.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  class Comando {
    constructor(sql, a) { this.sql = sql; this.a = a || []; }
    bind(...a) { return new Comando(this.sql, a); }
    conferir() { if (E.falharSql && E.falharSql.test(this.sql)) throw new Error('D1_ERROR: banco fora do ar'); }
    async first(col) { this.conferir(); const r = db.prepare(this.sql).get(...conv(this.a)); return r === undefined ? null : col ? r[col] : Object.assign({}, r); }
    async all() { this.conferir(); return { results: db.prepare(this.sql).all(...conv(this.a)).map(r => Object.assign({}, r)) }; }
    async run() { this.conferir(); const r = db.prepare(this.sql).run(...conv(this.a)); return { meta: { changes: Number(r.changes) } }; }
    rodarJa() { this.conferir(); return db.prepare(this.sql).run(...conv(this.a)); }
  }
  return {
    prepare: sql => new Comando(sql),
    async batch(lista) { db.exec('BEGIN'); try { const r = lista.map(c => c.rodarJa()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  };
}
/* o R2 em memória */
function r2() {
  const objs = new Map();
  return {
    objs,
    async put(k, corpo) { objs.set(k, new Uint8Array(corpo instanceof ArrayBuffer ? corpo : await new Response(corpo).arrayBuffer())); },
    async get(k) { const b = objs.get(k); return b ? { arrayBuffer: async () => b.slice().buffer } : null; },
    async delete(ks) { for (const k of [].concat(ks)) objs.delete(k); },
    async list({ prefix }) { return { objects: [...objs.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }; }
  };
}

export function instalarFalsos(base) {
  const E = { orders: {}, n: 0, chamadas: [] };
  const resp = (obj, st) => new Response(obj === null ? null : JSON.stringify(obj), { status: st || 200, headers: { 'content-type': 'application/json' } });

  // ---- banco ----
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_inicial.sql', import.meta.url), 'utf8'));
  E.db = db;
  E.sql = (sql, ...a) => db.prepare(sql).all(...a).map(r => Object.assign({}, r));
  E.projetos = r2();
  /* compra como o Worker vê (camadas em lista, user_id = conta) */
  E.compra = id => { const r = db.prepare('select * from compras where id = ?').get(id); return r ? Object.assign({}, r, { user_id: r.conta_id, camadas: JSON.parse(r.camadas) }) : undefined; };
  E.compras = () => E.sql('select * from compras').map(r => Object.assign(r, { user_id: r.conta_id }));
  E.usos = () => E.sql('select * from cupom_usos').map(r => Object.assign(r, { user_id: r.conta_id }));
  E.cupom = c => db.prepare('insert into cupons (codigo, desconto, fixo, gratis, ilimitado, usos_max, validade, so_primeira, area_min, ativo) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.codigo, c.desconto ?? null, c.fixo ?? null, c.gratis ? 1 : 0, c.ilimitado ? 1 : 0, c.usos_max ?? null, c.validade ?? null, c.so_primeira ? 1 : 0, c.area_min ?? null, c.ativo === false ? 0 : 1);
  /* uma conta com uma sessão aberta (como se tivesse entrado pela Atos); devolve {token} para chamar o Worker */
  E.entrar = (id, email) => {
    db.prepare('insert or ignore into contas (id, atos_sub, email, criado_em) values (?, ?, ?, ?)').run(id, 'sub-' + id, email, new Date().toISOString());
    const token = randomBytes(32).toString('hex');
    db.prepare('insert into sessoes (hash, conta_id, criado_em, expira) values (?, ?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), id, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
    return { token };
  };

  // ---- Atos (OpenID Connect): a chave ES256 que assina os id_token, os códigos dados em /entrar ----
  const ATOS = 'https://atos.teste', b64u = b => Buffer.from(b).toString('base64url');
  E.atosCodigos = {}; E.atosConfidencial = null;
  const chaveAtos = crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  async function idToken(corpo, outraChave) {
    const k = outraChave ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) : await chaveAtos;
    const cab = b64u(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' })), cor = b64u(JSON.stringify(corpo));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, new TextEncoder().encode(cab + '.' + cor));
    return cab + '.' + cor + '.' + b64u(new Uint8Array(sig));
  }
  /* o que a Atos faz em /entrar: a pessoa entra e permite; devolve o endereço da volta.
     pessoa: {sub, email, email_verified, name} ou {erro: 'access_denied'}; op.forjar assina com outra chave */
  E.atosAutorizar = (urlIda, pessoa, op) => {
    const u = new URL(urlIda), p = u.searchParams, volta = new URL(p.get('redirect_uri'));
    volta.searchParams.set('state', p.get('state')); volta.searchParams.set('iss', ATOS);
    if (pessoa.erro) { volta.searchParams.set('error', pessoa.erro); return volta.toString(); }
    const code = 'cod-' + Math.random().toString(36).slice(2);
    E.atosCodigos[code] = { pessoa, nonce: p.get('nonce'), desafio: p.get('code_challenge'), volta: p.get('redirect_uri'), cliente: p.get('client_id'), forjar: !!(op && op.forjar) };
    volta.searchParams.set('code', code); return volta.toString();
  };

  globalThis.fetch = async (url, op) => {
    op = op || {}; url = String(url); E.chamadas.push({ url, op });
    const metodo = op.method || 'GET'; let corpo = null; try { corpo = op.body ? JSON.parse(op.body) : null; } catch (e) { corpo = null; }
    // ---- Atos ----
    if (url === ATOS + '/.well-known/openid-configuration') return resp({ issuer: ATOS, authorization_endpoint: ATOS + '/entrar', token_endpoint: ATOS + '/oauth/token', jwks_uri: ATOS + '/oauth/jwks',
      revocation_endpoint: ATOS + '/oauth/revogar', code_challenge_methods_supported: ['S256'], prompt_values_supported: ['none', 'login', 'consent', 'create'], authorization_response_iss_parameter_supported: true });
    if (url === ATOS + '/oauth/jwks') { const j = await crypto.subtle.exportKey('jwk', (await chaveAtos).publicKey); return resp({ keys: [{ kty: 'EC', crv: 'P-256', x: j.x, y: j.y, kid: 'k1', alg: 'ES256', use: 'sig' }] }); }
    if (url === ATOS + '/oauth/token' && metodo === 'POST') {
      const f = new URLSearchParams(op.body), h = op.headers || {}, basic = (h.authorization || '').replace(/^Basic /, '');
      const cliente = basic ? decodeURIComponent(Buffer.from(basic, 'base64').toString().split(':')[0]) : f.get('client_id');
      if (E.atosConfidencial && (!basic || Buffer.from(basic, 'base64').toString() !== cliente + ':' + E.atosConfidencial)) return resp({ error: 'invalid_client' }, 401);
      if (!E.atosConfidencial && basic) return resp({ error: 'invalid_client' }, 401);
      const c = E.atosCodigos[f.get('code')]; delete E.atosCodigos[f.get('code')];
      if (!c || c.cliente !== cliente || c.volta !== f.get('redirect_uri')) return resp({ error: 'invalid_grant' }, 400);
      const desafio = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.get('code_verifier') || ''))));
      if (desafio !== c.desafio) return resp({ error: 'invalid_grant' }, 400);
      const agora = Math.floor(Date.now() / 1000), p = c.pessoa;
      return resp({ token_type: 'Bearer', access_token: 'at-' + p.sub, expires_in: 3600, id_token: await idToken({ iss: ATOS, aud: cliente, sub: p.sub, email: p.email, email_verified: p.email_verified !== false,
        name: p.name || '', nonce: c.nonce, iat: agora, exp: agora + 3600 }, c.forjar) });
    }
    // ---- Mercado Pago ----
    if (url === 'https://api.mercadopago.com/v1/orders' && metodo === 'POST') {
      const id = 'ORD' + String(++E.n).padStart(3, '0') + 'TESTE';
      E.orders[id] = { id, status: 'action_required', status_detail: 'waiting_transfer', external_reference: corpo.external_reference, total_amount: corpo.total_amount, payer: corpo.payer,
        transactions: { payments: [{ amount: corpo.total_amount, payment_method: { id: 'pix', qr_code: '000201PIX' + id, qr_code_base64: 'iVBOR' + id, ticket_url: 'https://mp/t' }, date_of_expiration: new Date(Date.now() + 18e5).toISOString() }] } };
      // criação assíncrona: a order nasce sem QR (processing); o QR aparece na consulta
      if (/-ASYNC-/.test(corpo.external_reference)) return resp({ id, status: 'processing', status_detail: 'in_process', external_reference: corpo.external_reference, total_amount: corpo.total_amount, transactions: { payments: [{ status: 'processing' }] } }, 201);
      return resp(Object.assign({}, E.orders[id], { transactions: { payments: [{ payment_method: { id: 'pix', qr_code: '000201PIX' + id, qr_code_base64: null, ticket_url: 'https://mp/t' }, date_of_expiration: new Date(Date.now() + 18e5).toISOString() }] } }), 201);
    }
    const m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/orders\/([^/]+)(\/cancel)?$/);
    if (m) { const o = E.orders[decodeURIComponent(m[1])]; if (!o) return resp({ message: 'not found' }, 404);
      if (m[2]) { o.status = 'canceled'; return resp(o); } return resp(o); }
    if (base) return base(url, op);
    return resp({}, 404);
  };
  E.pagar = id => { E.orders[id].status = 'processed'; E.orders[id].status_detail = 'accredited'; };
  E.env = { MP_ACCESS_TOKEN: 'token-falso-dos-testes', MP_WEBHOOK_SECRET: 'segredo', ORIGENS: 'https://plantare.matheusuener.com.br,null', EXPIRA: 'PT30M', REBAIXAR_DIAS: '365',
    DB: d1(db, E), PROJETOS: E.projetos,
    ATOS_CLIENT_ID: 'u-plantare-teste', ATOS_VOLTA: 'https://plantaremaps.com.br/,http://localhost:8787/', ATOS_EMISSOR: ATOS };
  return E;
}
