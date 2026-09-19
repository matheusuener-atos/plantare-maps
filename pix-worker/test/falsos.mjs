/* Mercado Pago e Supabase de mentira, para testar o Worker sem rede.
   instalarFalsos() troca o fetch global; devolve o estado para os testes mexerem. */
export function instalarFalsos(base) {
  const E = { orders: {}, n: 0, compras: [], cupons: [], usos: [], tokens: {}, chamadas: [] };
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
    plantare_confirmar({ p_compra }) {
      const c = E.compras.find(x => x.id === p_compra); if (c) { c.status = 'pago'; c.pago_em = c.pago_em || new Date().toISOString(); }
      E.usos.filter(u => u.compra_id === p_compra).forEach(u => u.pago = true); return null;
    }
  };
  globalThis.fetch = async (url, op) => {
    op = op || {}; url = String(url); E.chamadas.push({ url, op });
    const metodo = op.method || 'GET', corpo = op.body ? JSON.parse(op.body) : null;
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
    // ---- Supabase Auth ----
    if (url === SB + '/auth/v1/user') { const t = (op.headers.authorization || '').replace(/^Bearer /, ''); return E.tokens[t] ? resp(E.tokens[t]) : resp({ msg: 'invalid JWT' }, 401); }
    // ---- Supabase REST ----
    m = url.match(/^https:\/\/banco\.teste\/rest\/v1\/([\w]+)(?:\/([\w]+))?(?:\?(.*))?$/);
    if (m) {
      if (op.headers.apikey !== 'sb_secret_falsa') return resp({ message: 'sem permissão' }, 401);
      if (m[1] === 'rpc') { try { return resp(rpc[m[2]](corpo)); } catch (e) { return resp({ message: e.message }, e.st || 400); } }
      const tab = { compras: E.compras, cupons: E.cupons, cupom_usos: E.usos }[m[1]], f = filtros(m[3] || '');
      if (metodo === 'GET') return resp(tab.filter(r => casa(r, f)).sort((a, b) => String(b.pago_em).localeCompare(String(a.pago_em))));
      if (metodo === 'POST') { if (tab.some(r => r.id === corpo.id)) return resp({ message: 'duplicate' }, 409); tab.push(Object.assign({ status: 'pendente', downloads: 0, pago_em: null, criado_em: new Date().toISOString() }, corpo)); return resp(null, 201); }
      if (metodo === 'PATCH') { tab.filter(r => casa(r, f)).forEach(r => Object.assign(r, corpo)); return resp(null, 204); }
    }
    if (base) return base(url, op);
    return resp({}, 404);
  };
  E.pagar = id => { E.orders[id].status = 'processed'; E.orders[id].status_detail = 'accredited'; };
  E.env = { MP_ACCESS_TOKEN: 'token-falso-dos-testes', MP_WEBHOOK_SECRET: 'segredo', ORIGENS: 'https://plantare.matheusuener.com.br,null', EXPIRA: 'PT30M',
    SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_falsa', SUPABASE_SERVICE_KEY: 'sb_secret_falsa', REBAIXAR_DIAS: '365' };
  E.entrar = (token, id, email) => { E.tokens[token] = { id, email }; };
  return E;
}
