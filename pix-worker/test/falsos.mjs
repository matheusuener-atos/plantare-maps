/* Mercado Pago e Supabase de mentira, para testar o Worker sem rede.
   instalarFalsos() troca o fetch global; devolve o estado para os testes mexerem. */
export function instalarFalsos(base) {
  const E = { orders: {}, n: 0, compras: [], cupons: [], usos: [], tokens: {}, chamadas: [], perfis: [], talhoes: [], arquivos: {}, excluidos: [] };
  const SB = 'https://banco.teste';
  const resp = (obj, st) => new Response(obj === null ? null : JSON.stringify(obj), { status: st || 200, headers: { 'content-type': 'application/json' } });
  const filtros = qs => { const f = []; for (const [k, v] of new URLSearchParams(qs)) if (!['select', 'order', 'limit'].includes(k) && v.startsWith('eq.')) f.push([k, v.slice(3)]); return f; };
  const casa = (row, f) => f.every(([k, v]) => String(row[k]) === v);
  const rpc = {
    plantare_cupom({ p_codigo, p_user, p_ha }) {
      const c = E.cupons.find(x => x.codigo === String(p_codigo).trim().toUpperCase());
      if (!c || !c.ativo) return { ok: false, motivo: 'Cupom não encontrado.' };
      if (c.validade && Date.parse(c.validade) < Date.now()) return { ok: false, motivo: 'Este cupom venceu.' };
      if (c.area_min != null && p_ha < c.area_min) return { ok: false, motivo: 'Este cupom vale a partir de ' + c.area_min + ' ha.' };
      if (E.usos.some(u => u.cupom === c.codigo && u.user_id === p_user && u.pago)) return { ok: false, motivo: 'Você já usou este cupom.' };
      if (c.so_primeira && E.compras.some(x => x.user_id === p_user && x.status === 'pago')) return { ok: false, motivo: 'Este cupom é só para a primeira compra.' };
      if (c.usos_max != null && E.usos.filter(u => u.cupom === c.codigo && u.pago && u.user_id !== p_user).length >= c.usos_max) return { ok: false, motivo: 'Os usos deste cupom acabaram.' };
      return { ok: true, codigo: c.codigo, desconto: c.desconto ?? null, fixo: c.fixo ?? null, gratis: !!c.gratis, validade: c.validade ?? null };
    },
    plantare_reservar_cupom({ p_codigo, p_user, p_compra }) {
      const u = E.usos.find(x => x.cupom === p_codigo && x.user_id === p_user);
      if (u) { if (u.pago) throw Object.assign(new Error('cupom já usado'), { st: 400 }); const a = u.compra_id; u.compra_id = p_compra; return a !== p_compra ? a : null; }
      E.usos.push({ cupom: p_codigo, user_id: p_user, compra_id: p_compra, pago: false }); return null;
    },
    // v2 (005_cupom_sem_conta.sql): a pessoa é a conta OU o e-mail; cada cupom vale uma vez por talhão
    plantare_cupom_v2({ p_codigo, p_user, p_email, p_ha, p_area }) {
      const c = E.cupons.find(x => x.codigo === String(p_codigo).trim().toUpperCase()), em = p_email ? String(p_email).trim().toLowerCase() : null;
      const mesma = u => (p_user && u.user_id === p_user) || (em && u.email === em);
      if (!c || !c.ativo) return { ok: false, motivo: 'Cupom não encontrado.' };
      if (c.validade && Date.parse(c.validade) < Date.now()) return { ok: false, motivo: 'Este cupom venceu.' };
      if (c.area_min != null && p_ha < c.area_min) return { ok: false, motivo: 'Este cupom vale a partir de ' + c.area_min + ' ha.' };
      if (!c.ilimitado) {   // cupom ilimitado não conta uso nenhum
        if (E.usos.some(u => u.cupom === c.codigo && u.pago && mesma(u))) return { ok: false, motivo: 'Você já usou este cupom.' };
        if (p_area && E.usos.some(u => u.cupom === c.codigo && u.pago && (E.compras.find(k => k.id === u.compra_id) || {}).area_hash === p_area)) return { ok: false, motivo: 'Este cupom já foi usado neste talhão.' };
        if (c.so_primeira && E.compras.some(x => x.status === 'pago' && ((p_user && x.user_id === p_user) || (em && String(x.email).toLowerCase() === em)))) return { ok: false, motivo: 'Este cupom é só para a primeira compra.' };
        if (c.usos_max != null && E.usos.filter(u => u.cupom === c.codigo && u.pago && !mesma(u)).length >= c.usos_max) return { ok: false, motivo: 'Os usos deste cupom acabaram.' };
      }
      return { ok: true, codigo: c.codigo, desconto: c.desconto ?? null, fixo: c.fixo ?? null, gratis: !!c.gratis, validade: c.validade ?? null, ilimitado: !!c.ilimitado };
    },
    plantare_reservar_cupom_v2({ p_codigo, p_user, p_email, p_compra }) {
      const c0 = E.cupons.find(x => x.codigo === String(p_codigo).trim().toUpperCase());
      if (c0 && c0.ilimitado) return null;   // ilimitado: nada a reservar
      const em = p_email ? String(p_email).trim().toLowerCase() : null;
      if (!p_user && !em) throw Object.assign(new Error('sem dono'), { st: 400 });
      const u = E.usos.find(x => x.cupom === p_codigo && (p_user ? x.user_id === p_user : (!x.user_id && x.email === em)));
      if (u) { if (u.pago) throw Object.assign(new Error('cupom já usado'), { st: 400 }); const a = u.compra_id; u.compra_id = p_compra; u.email = em || u.email; return a !== p_compra ? a : null; }
      E.usos.push({ cupom: p_codigo, user_id: p_user || null, email: em, compra_id: p_compra, pago: false }); return null;
    },
    // 007_conta_atos.sql
    plantare_conta_atos({ p_sub, p_email }) {
      if (E.contasAtos[p_sub]) return E.contasAtos[p_sub];
      const em = p_email ? String(p_email).trim().toLowerCase() : null; if (!em) return null;
      const u = E.usuarios.find(x => x.email === em); if (!u) return null;
      if (Object.entries(E.contasAtos).some(([s, id]) => id === u.id && s !== p_sub)) throw Object.assign(new Error('conta ligada a outra Conta Atos'), { st: 400 });
      E.contasAtos[p_sub] = u.id; return u.id;
    },
    plantare_confirmar({ p_compra }) {
      const c = E.compras.find(x => x.id === p_compra); if (c) { c.status = 'pago'; c.pago_em = c.pago_em || new Date().toISOString(); }
      E.usos.filter(u => u.compra_id === p_compra).forEach(u => u.pago = true); return null;
    }
  };
  // ---- Atos (OpenID Connect): a chave ES256 que assina os id_token, os códigos dados em /entrar ----
  const ATOS = 'https://atos.teste', b64u = b => Buffer.from(b).toString('base64url');
  E.usuarios = []; E.contasAtos = {}; E.links = {}; E.atosCodigos = {}; E.atosConfidencial = null;
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
  /* ---- Supabase Auth (admin): a sessão que o Worker abre depois da Atos ---- */
  const sessaoNova = u => { const tok = 'tok-' + u.id + '-' + Math.random().toString(36).slice(2) + '0123456789'; E.tokens[tok] = { id: u.id, email: u.email };
    return { access_token: tok, refresh_token: 'ref-' + tok, expires_in: 3600, user: u }; };

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
    if (url === SB + '/auth/v1/admin/users' && metodo === 'POST') {
      if (op.headers.apikey !== 'sb_secret_falsa') return resp({ message: 'sem permissão' }, 401);
      if (E.usuarios.some(u => u.email === corpo.email)) return resp({ msg: 'email_exists' }, 422);
      const u = { id: 'u-novo-' + (E.nUsuarios = (E.nUsuarios || 0) + 1), email: corpo.email, app_metadata: corpo.app_metadata }; E.usuarios.push(u); return resp(u); }
    if (url === SB + '/auth/v1/admin/generate_link' && metodo === 'POST') {
      if (op.headers.apikey !== 'sb_secret_falsa') return resp({ message: 'sem permissão' }, 401);
      const u = E.usuarios.find(x => x.email === corpo.email); if (!u || corpo.type !== 'magiclink') return resp({ msg: 'not found' }, 404);
      const h = 'hash-' + Math.random().toString(36).slice(2); E.links[h] = u.id; return resp({ properties: { hashed_token: h } }); }
    if (url === SB + '/auth/v1/verify' && metodo === 'POST') {
      const uid = E.links[corpo.token_hash]; delete E.links[corpo.token_hash];
      const u = uid && E.usuarios.find(x => x.id === uid); if (!u || corpo.type !== 'magiclink') return resp({ msg: 'Token has expired or is invalid' }, 403);
      return resp(sessaoNova(u)); }
    // ---- Mercado Pago ----
    if (url === 'https://api.mercadopago.com/v1/orders' && metodo === 'POST') {
      const id = 'ORD' + String(++E.n).padStart(3, '0') + 'TESTE';
      E.orders[id] = { id, status: 'action_required', status_detail: 'waiting_transfer', external_reference: corpo.external_reference, total_amount: corpo.total_amount, payer: corpo.payer,
        transactions: { payments: [{ amount: corpo.total_amount, payment_method: { id: 'pix', qr_code: '000201PIX' + id, qr_code_base64: 'iVBOR' + id, ticket_url: 'https://mp/t' }, date_of_expiration: new Date(Date.now() + 18e5).toISOString() }] } };
      // criação assíncrona: a order nasce sem QR (processing); o QR aparece na consulta
      if (/-ASYNC-/.test(corpo.external_reference)) return resp({ id, status: 'processing', status_detail: 'in_process', external_reference: corpo.external_reference, total_amount: corpo.total_amount, transactions: { payments: [{ status: 'processing' }] } }, 201);
      return resp(Object.assign({}, E.orders[id], { transactions: { payments: [{ payment_method: { id: 'pix', qr_code: '000201PIX' + id, qr_code_base64: null, ticket_url: 'https://mp/t' }, date_of_expiration: new Date(Date.now() + 18e5).toISOString() }] } }), 201);
    }
    let m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/orders\/([^/]+)(\/cancel)?$/);
    if (m) { const o = E.orders[decodeURIComponent(m[1])]; if (!o) return resp({ message: 'not found' }, 404);
      if (m[2]) { o.status = 'canceled'; return resp(o); } return resp(o); }
    // ---- Supabase Storage e admin (exclusão de conta) ----
    if (url === SB + '/storage/v1/object/list/projetos' && metodo === 'POST') {
      if (op.headers.apikey !== 'sb_secret_falsa') return resp({ message: 'sem permissão' }, 401);
      return resp(Object.keys(E.arquivos).filter(n => n.startsWith(corpo.prefix)).map(n => ({ name: n.slice(corpo.prefix.length) }))); }
    if (url === SB + '/storage/v1/object/projetos' && metodo === 'DELETE') { for (const n of corpo.prefixes) delete E.arquivos[n]; return resp([]); }
    m = url.match(/^https:\/\/banco\.teste\/auth\/v1\/admin\/users\/([^/?]+)$/);
    if (m && metodo === 'DELETE') {
      if (op.headers.apikey !== 'sb_secret_falsa') return resp({ message: 'sem permissão' }, 401);
      const id = decodeURIComponent(m[1]); for (const t of Object.keys(E.tokens)) if (E.tokens[t].id === id) delete E.tokens[t];
      E.usos = E.usos.filter(u => u.user_id !== id); E.excluidos.push(id);
      E.usuarios = E.usuarios.filter(u => u.id !== id); for (const s of Object.keys(E.contasAtos)) if (E.contasAtos[s] === id) delete E.contasAtos[s];   // cascata
      return resp({}); }
    if (m && (metodo === 'GET' || metodo === 'PUT')) {
      if (op.headers.apikey !== 'sb_secret_falsa') return resp({ message: 'sem permissão' }, 401);
      const u = E.usuarios.find(x => x.id === decodeURIComponent(m[1])); if (!u) return resp({ msg: 'User not found' }, 404);
      if (metodo === 'PUT' && corpo.email) { if (E.usuarios.some(x => x !== u && x.email === corpo.email)) return resp({ msg: 'email_exists' }, 422); u.email = corpo.email; }
      return resp(u); }
    // ---- Supabase Auth ----
    if (url === SB + '/auth/v1/user') { const t = (op.headers.authorization || '').replace(/^Bearer /, ''); return E.tokens[t] ? resp(E.tokens[t]) : resp({ msg: 'invalid JWT' }, 401); }
    // ---- Supabase REST ----
    m = url.match(/^https:\/\/banco\.teste\/rest\/v1\/([\w]+)(?:\/([\w]+))?(?:\?(.*))?$/);
    if (m) {
      if (op.headers.apikey !== 'sb_secret_falsa') return resp({ message: 'sem permissão' }, 401);
      if (m[1] === 'rpc') {
        // E.rpcFalha simula o banco fora do ar (ou a função ainda não instalada)
        if (E.rpcFalha === m[2]) return resp({ message: 'Could not find the function public.' + m[2] }, 404);
        try { return resp(rpc[m[2]](corpo)); } catch (e) { return resp({ message: e.message }, e.st || 400); } }
      const tab = { compras: E.compras, cupons: E.cupons, cupom_usos: E.usos, perfis: E.perfis, talhoes: E.talhoes }[m[1]], f = filtros(m[3] || '');
      if (metodo === 'DELETE') { for (let i = tab.length - 1; i >= 0; i--) if (casa(tab[i], f)) tab.splice(i, 1); return resp(null, 204); }
      if (metodo === 'GET') return resp(tab.filter(r => casa(r, f)).sort((a, b) => String(b.pago_em).localeCompare(String(a.pago_em))));
      if (metodo === 'POST') { if (tab.some(r => r.id === corpo.id)) return resp({ message: 'duplicate' }, 409); tab.push(Object.assign({ status: 'pendente', downloads: 0, pago_em: null, criado_em: new Date().toISOString() }, corpo)); return resp(null, 201); }
      if (metodo === 'PATCH') { tab.filter(r => casa(r, f)).forEach(r => Object.assign(r, corpo)); return resp(null, 204); }
    }
    if (base) return base(url, op);
    return resp({}, 404);
  };
  E.pagar = id => { E.orders[id].status = 'processed'; E.orders[id].status_detail = 'accredited'; };
  E.env = { MP_ACCESS_TOKEN: 'token-falso-dos-testes', MP_WEBHOOK_SECRET: 'segredo', ORIGENS: 'https://plantare.matheusuener.com.br,null', EXPIRA: 'PT30M',
    SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_falsa', SUPABASE_SERVICE_KEY: 'sb_secret_falsa', REBAIXAR_DIAS: '365',
    ATOS_CLIENT_ID: 'u-plantare-teste', ATOS_VOLTA: 'https://plantaremaps.com.br/,http://localhost:8787/', ATOS_EMISSOR: ATOS };
  E.entrar = (token, id, email) => { E.tokens[token] = { id, email }; if (!E.usuarios.some(u => u.id === id)) E.usuarios.push({ id, email }); };
  return E;
}
