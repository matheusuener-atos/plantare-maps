/* Compra por intenção. A Atos é a autoridade monetária; a geometria fica no Plantare. */
const CAMADAS = ['linhas_ab', 'bordadura', 'percurso', 'manobras'];
const INT = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const CMP = /^cmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const CAMPOS = ['schema','id','produto','sub','intent_id','orcamento_id','versao','estado','area_hash','area_cent_ha','camadas','moeda','centavos','tarifa_versao','cupom','criado_em','pago_em','baixar_ate','direito_ativo'];
const fixos = ['sub','intent_id','orcamento_id','area_hash','area_cent_ha','camadas','moeda','centavos','tarifa_versao','cupom'];
const iso = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(s) && Number.isFinite(Date.parse(s));
export class FalhaAtos extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const falhar = (s, m) => { throw new FalhaAtos(m, s); };
export const hash = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
export const novasAtos = env => env.AMBIENTE === 'teste' && env.ATOS_NOVAS_COMPRAS === '1';
export const integraAtos = env => !!(env.ATOS_COBRANCA_ORIGEM && env.ATOS_COBRANCA_TOKEN);
const um = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).first();
const rodar = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).run();
async function intencao(env, id, user) {
  if (typeof id !== 'string' || !INT.test(id)) falhar(400, 'Intenção inválida.');
  const i = await um(env, 'select * from atos_intencoes where id = ?', id);
  if (!i || i.apagada || (user && (i.conta_id !== user.id || i.sub !== user.atos_sub))) falhar(404, 'Intenção não encontrada nesta conta.');
  return i;
}
async function pedir(env, caminho, body, chave) {
  const origem = String(env.ATOS_COBRANCA_ORIGEM || '');
  if (env.AMBIENTE === 'teste' && origem === 'https://atos.dev.br') falhar(503,'O teste exige uma origem Atos isolada.');
  if (!/^https:\/\/(?:atos\.dev\.br|atos-teste\.[a-z0-9-]+\.workers\.dev)$/.test(origem)
      && !(env.AMBIENTE === 'teste' && /^https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}$/.test(origem)))
    falhar(503, 'Conexão com a cobrança Atos indisponível.');
  if (typeof env.ATOS_COBRANCA_TOKEN !== 'string' || env.ATOS_COBRANCA_TOKEN.length < 32) falhar(503, 'Conexão com a cobrança Atos indisponível.');
  const headers = { authorization: 'Bearer ' + env.ATOS_COBRANCA_TOKEN, accept: 'application/json' };
  if (body) { headers['content-type'] = 'application/json'; headers['idempotency-key'] = chave; }
  let r, d;
  try {
    const url = origem + '/api/cobranca/v1/plantare' + caminho;
    const op = { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), redirect: 'manual' };
    r = env.ATOS_COBRANCA ? await env.ATOS_COBRANCA.fetch(url, op) : await fetch(url, op);
    const texto = await r.text(); if (texto.length > 32768) throw new Error('resposta grande'); d = JSON.parse(texto);
  } catch { falhar(503, 'A Atos não respondeu. Sua intenção foi preservada; tente novamente sem criar outro pagamento.'); }
  if (!r.ok) falhar([400,404,409,410,422].includes(r.status) ? r.status : 503,
    r.status === 410 ? 'Orçamento vencido. Crie uma nova intenção explicitamente.' : 'Não foi possível confirmar a compra na Atos. A intenção foi preservada.');
  return d;
}
function snapshot(d, i) {
  const q = JSON.parse(i.orcamento || 'null'), escopo = JSON.parse(i.escopo);
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !CAMPOS.includes(k))
      || CAMPOS.some(k => !(k in d)) || d.schema !== 'plantare-compra/v1' || !CMP.test(d.id || '') || d.produto !== 'plantare'
      || d.intent_id !== i.id || d.sub !== i.sub || !q || !/^orc-[a-f0-9-]{36}$/.test(d.orcamento_id)
      || !Number.isSafeInteger(d.versao) || d.versao < 1 || !HASH.test(d.area_hash || '')
      || !Number.isSafeInteger(d.centavos) || d.centavos < 0 || d.centavos > 50000000
      || !Number.isSafeInteger(d.area_cent_ha) || d.area_cent_ha < 1 || d.area_cent_ha > 5000000
      || !Array.isArray(d.camadas) || !d.camadas.length || d.camadas.some(c => !CAMADAS.includes(c))
      || new Set(d.camadas).size !== d.camadas.length || d.moeda !== 'BRL'
      || !['aguardando','paga','concedida','cancelada','expirada','devolvida'].includes(d.estado)
      || !iso(d.criado_em) || (d.pago_em !== null && !iso(d.pago_em)) || (d.baixar_ate !== null && !iso(d.baixar_ate))
      || typeof d.direito_ativo !== 'boolean' || (d.estado === 'concedida' && d.centavos !== 0)
      || (d.estado === 'paga' && d.centavos === 0)
      || (['paga','concedida','devolvida'].includes(d.estado) && !d.pago_em)
      || (!['paga','concedida','devolvida'].includes(d.estado) && (d.pago_em !== null || d.baixar_ate !== null))
      || (d.direito_ativo && (!['paga','concedida'].includes(d.estado) || !d.baixar_ate || Date.parse(d.baixar_ate) <= Date.parse(d.pago_em)))
      || fixos.some(k => JSON.stringify(d[k]) !== JSON.stringify(q[k]))
      || ['area_hash','area_cent_ha','camadas','sub','intent_id'].some(k => JSON.stringify(d[k]) !== JSON.stringify(escopo[k])))
    falhar(409, 'Snapshot da Atos diverge da intenção ou do orçamento registrado.');
  return Object.fromEntries(CAMPOS.map(k => [k, d[k]]));
}
export async function projetar(env, d, evento) {
  const i = await um(env, 'select * from atos_intencoes where id = ?', d?.intent_id || '');
  if (!i) falhar(404, 'Intenção ainda não registrada.');
  const s = snapshot(d, i), texto = JSON.stringify(s), digest = await hash(texto);
  const comandos = [];
  if (evento) comandos.push(env.DB.prepare(`insert into atos_inbox(id,compra_id,digest,recebido_em,ignorado)
    values(?,?,?,?,case when exists(select 1 from atos_intencoes i join contas c on c.id=i.conta_id and c.atos_sub=i.sub
    where i.id=? and i.apagada=0) then 0 else 1 end) on conflict(id) do nothing`)
    .bind(evento.id, s.id, evento.digest, new Date().toISOString(), i.id));
  // A condição também é avaliada no commit, após eventual exclusão concorrente.
  comandos.push(env.DB.prepare(`insert into atos_compras(id,intent_id,sub,versao,digest,dados)
    select ?,?,?,?,?,? from atos_intencoes i join contas c on c.id=i.conta_id and c.atos_sub=i.sub
    where i.id=? and i.apagada=0
    on conflict(id) do update set versao=excluded.versao,digest=excluded.digest,dados=excluded.dados
    where excluded.versao > atos_compras.versao`).bind(s.id, s.intent_id, s.sub, s.versao, digest, texto, i.id));
  try { await env.DB.batch(comandos); }
  catch (e) { if (/atos_(?:evento|compra|transicao)_/.test(String(e.message))) falhar(409, 'Conflito de integridade na compra Atos.'); throw e; }
  return s;
}
export async function criarIntencao(env, user, body, medido) {
  if (!user?.atos_sub) falhar(401, 'Entre com a sua Conta Atos para comprar.');
  const id = body.intent_id;
  if (typeof id !== 'string' || !INT.test(id)) falhar(400, 'Informe uma intenção estável para recuperar a compra.');
  const escopo = { schema: 'plantare-orcamento/v1', intent_id: id, sub: user.atos_sub, ...medido };
  const plano = String(body.plano || '').replace(/[^A-Za-z0-9]/g, '').slice(0,16) || 'plano';
  const digest = await hash(JSON.stringify({ escopo, plano }));
  const existe = await um(env, 'select id from atos_intencoes where id = ?', id);
  if (!existe && !novasAtos(env)) falhar(503, 'Novas compras centrais ainda não estão disponíveis.');
  await rodar(env, `insert into atos_intencoes(id,conta_id,sub,digest,escopo,plano,criado_em)
    select ?,?,?,?,?,?,? where exists(select 1 from contas where id=? and atos_sub=?) on conflict(id) do nothing`,
    id, user.id, user.atos_sub, digest, JSON.stringify(escopo), plano, new Date().toISOString(), user.id, user.atos_sub);
  let i = await intencao(env, id, user);
  if (i.digest !== digest) falhar(409, 'A intenção já foi usada com outro talhão, camada ou cupom.');
  if (!i.orcamento) {
    const q = await pedir(env, '/orcamentos', escopo, 'orcamento:' + id);
    if (q.schema !== 'plantare-orcamento/v1' || ['sub','intent_id','area_hash','area_cent_ha','camadas']
      .some(k => JSON.stringify(q[k]) !== JSON.stringify(escopo[k])) || q.moeda !== 'BRL' || !Number.isSafeInteger(q.centavos)
      || q.centavos < 0 || q.centavos > 50000000 || !iso(q.valido_ate) || !/^orc-[a-f0-9-]{36}$/.test(q.orcamento_id || '')
      || typeof q.tarifa_versao !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(q.tarifa_versao)
      || (escopo.cupom === null ? q.cupom !== null : q.cupom?.codigo !== escopo.cupom)) falhar(409, 'Orçamento da Atos diverge do escopo medido.');
    await rodar(env, 'update atos_intencoes set orcamento=? where id=? and orcamento is null and apagada=0', JSON.stringify(q), id);
    i = await intencao(env, id, user);
  }
  const q = JSON.parse(i.orcamento);
  const r = await pedir(env, '/checkouts', { schema:'plantare-checkout/v1', sub:i.sub, intent_id:id, orcamento_id:q.orcamento_id }, 'checkout:' + id);
  await projetar(env, r.compra);
  let checkout = null;
  if (r.checkout_disponivel && typeof r.checkout_url === 'string') {
    const u = new URL(r.checkout_url), origem = String(env.ATOS_COBRANCA_ORIGEM);
    if (u.origin !== origem || u.pathname !== '/plantare/assinar' || u.searchParams.get('compra') !== r.compra.id
        || u.searchParams.size !== 1 || u.hash) falhar(409, 'Endereço de checkout inválido.');
    checkout = u.href;
  }
  return { ok:true, provedor:'atos', intent_id:id, orcamento:q, compra:r.compra, checkout_url:checkout };
}
export async function compraAtual(env, user, id) {
  if (!user?.atos_sub) falhar(401, 'Entre com a sua Conta Atos.');
  if (!CMP.test(id || '')) falhar(400, 'Compra central inválida.');
  const r = await um(env, `select c.*,i.conta_id,i.apagada,i.plano from atos_compras c join atos_intencoes i on i.id=c.intent_id
    where c.id=? and i.conta_id=? and i.sub=? and i.apagada=0`, id, user.id, user.atos_sub);
  if (!r) falhar(404, 'Compra não encontrada nesta conta.');
  const s = await pedir(env, '/compras/' + encodeURIComponent(id) + '?sub=' + encodeURIComponent(user.atos_sub));
  if (s.id !== id) falhar(409, 'Identificador da compra divergente.');
  await projetar(env, s);
  // Uma devolução/evento mais novo recebido durante GET prevalece.
  const atual = await um(env, `select c.dados,i.apagada from atos_compras c join atos_intencoes i on i.id=c.intent_id
    join contas u on u.id=i.conta_id and u.atos_sub=i.sub where c.id=? and i.conta_id=? and i.apagada=0`, id, user.id);
  if (!atual) falhar(404, 'Conta ou compra indisponível.');
  return { ...JSON.parse(atual.dados), plano:r.plano, downloads:r.downloads, provedor:'atos' };
}
export function direito(s) {
  return ['paga','concedida'].includes(s.estado) && s.direito_ativo === true && iso(s.baixar_ate) && Date.parse(s.baixar_ate) > Date.now();
}
export async function listarAtos(env, user, limite, cursor) {
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(String(limite))) falhar(400, 'Limite inválido.');
  if (cursor && !CMP.test(cursor)) falhar(400, 'Cursor inválido.');
  const linhas = (await env.DB.prepare(`select c.dados,c.downloads,i.plano from atos_compras c join atos_intencoes i on i.id=c.intent_id
    where i.conta_id=? and i.sub=? and i.apagada=0 and c.id>? order by c.id limit ?`).bind(user.id,user.atos_sub,cursor || '',Number(limite)+1).all()).results;
  const pagina = linhas.slice(0,Number(limite));
  return { compras:pagina.map(r => ({ ...JSON.parse(r.dados), plano:r.plano, downloads:r.downloads, provedor:'atos' })),
    proximo_cursor:linhas.length > Number(limite) ? JSON.parse(pagina.at(-1).dados).id : null };
}
export async function listarCompras(env,user,limite='50',cursor=null) {
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limite)) falhar(400,'Limite inválido.');
  const dono = await hash(user.id);
  let chave='';
  if (cursor) {
    try { const c=JSON.parse(atob(cursor)); if (c.dono!==dono || typeof c.chave!=='string' || c.chave.length>160) throw new Error(); chave=c.chave; }
    catch { falhar(400,'Cursor inválido para esta conta.'); }
  }
  const centrais = integraAtos(env) ? `union all select c.id,i.criado_em,'atos' as provedor,c.dados,c.downloads,i.plano
    from atos_compras c join atos_intencoes i on i.id=c.intent_id
    where i.conta_id=? and i.sub=? and i.apagada=0` : '';
  const sql=`select *,criado_em||':'||id as chave from (
    select id,criado_em,'legado' as provedor,json_object('id',id,'plano',plano,'area_hash',area_hash,'ha',ha,
      'camadas',json(camadas),'valor',valor,'cupom',cupom,'status',status,'criado_em',criado_em,'pago_em',pago_em,'downloads',downloads) as dados,downloads,plano
    from compras where conta_id=? and status='pago' ${centrais})
    where criado_em||':'||id>? order by chave limit ?`;
  const linhas=(await env.DB.prepare(sql).bind(user.id,...(integraAtos(env)?[user.id,user.atos_sub]:[]),chave,Number(limite)+1).all()).results;
  const p=linhas.slice(0,Number(limite));
  return {ok:true,email:user.email,compras:p.map(r=>{
    const s=JSON.parse(r.dados);
    return r.provedor==='legado' ? {...s,provedor:'legado'} : {...s,provedor:'atos',plano:r.plano,
      ha:s.area_cent_ha/100,valor:s.centavos/100,status:s.estado,cupom:s.cupom?.codigo || null,downloads:r.downloads};
  }),proximo_cursor:linhas.length>Number(limite)?btoa(JSON.stringify({dono,chave:p.at(-1).chave})):null};
}
async function corpoLimitado(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers.get('content-type') || '')) falhar(415, 'Envie JSON.');
  let total = 0; const partes = [], reader = req.body?.getReader(); if (!reader) falhar(400,'Corpo obrigatório.');
  try { for (;;) { const {value,done} = await reader.read(); if (done) break; total += value.byteLength;
    if (total > 16384) { await reader.cancel(); falhar(413,'Evento grande demais.'); } partes.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset=0; for (const p of partes) { bytes.set(p,offset);offset+=p.length; }
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { falhar(400,'Evento com codificação inválida.'); }
}
export async function receberEvento(req, env) {
  if (!env.DB || typeof env.ATOS_COMPRAS_SEGREDO !== 'string' || env.ATOS_COMPRAS_SEGREDO.length < 32) falhar(503,'Eventos indisponíveis.');
  const corpo = await corpoLimitado(req), sig = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(req.headers.get('atos-assinatura') || '');
  if (!sig || Math.abs(Date.now()/1000-Number(sig[1]))>300) falhar(401,'Assinatura inválida ou vencida.');
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(env.ATOS_COMPRAS_SEGREDO),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const mac = Uint8Array.from(sig[2].match(/../g),x => parseInt(x,16));
  if (!await crypto.subtle.verify('HMAC',key,mac,new TextEncoder().encode(sig[1]+'.'+corpo))) falhar(401,'Assinatura inválida.');
  let e; try { e = JSON.parse(corpo); } catch { falhar(400,'Evento inválido.'); }
  if (e?.tipo !== 'compra.atualizada' || e.produto !== 'plantare' || !iso(e.criado) || e.conta?.sub !== e.dados?.sub
      || e.id !== 'plantare:'+e.dados?.id+':v'+e.dados?.versao || req.headers.get('atos-evento') !== e.id) falhar(400,'Evento de compra inválido.');
  await projetar(env,e.dados,{ id:e.id,digest:await hash(corpo) });
  return {ok:true};
}
export async function impedirPixDuplicado(env,user,area_hash) {
  if (novasAtos(env)) falhar(409,'Use o checkout Atos desta versão para novas compras.');
  if (integraAtos(env) && user && await um(env,`select id from atos_intencoes where conta_id=? and sub=?
    and json_extract(escopo,'$.area_hash')=? and apagada=0 limit 1`,user.id,user.atos_sub,area_hash))
    falhar(409,'Este talhão já tem intenção na Atos. Retome a compra em vez de criar outro Pix.');
}
