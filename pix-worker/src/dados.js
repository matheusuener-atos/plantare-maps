/* Plantare · dados (Cloudflare D1 + R2)
   O único lugar do Worker que conhece o armazenamento: trocar de serviço é reescrever este arquivo,
   mantendo as mesmas funções. Tabelas em migrations/0001_inicial.sql (D1, binding DB); os projetos
   dos talhões, comprimidos, no R2 (binding PROJETOS), em projetos/<conta>/<chave>.json.gz.

   Regras que moravam em funções SQL do Supabase e agora estão aqui:
     · cupom: uma vez por pessoa (conta ou e-mail) e uma vez por talhão; usos_max conta pessoas diferentes;
       so_primeira olha compras pagas; ilimitado pula tudo isso;
     · reserva do cupom: troca a reserva pendente (devolve a compra antiga, para cancelar o Pix) e recusa se já pago;
     · Pix caiu: marca a compra e o uso do cupom como pagos (idempotente). */

const agora = () => new Date().toISOString();
const sha256 = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
const aleatorio = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const SESSAO_DIAS = 30;

/* linha do D1 → objeto do Worker (JSON e 0/1 viram listas e booleanos) */
function compraDe(r) {
  if (!r) return null;
  let camadas = []; try { camadas = JSON.parse(r.camadas || '[]'); } catch (e) { camadas = []; }
  return Object.assign({}, r, { user_id: r.conta_id, camadas });
}
function talhaoDe(r) {
  const js = v => { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  return { chave: r.chave, codigo: r.codigo, nome: r.nome, area_hash: r.area_hash, ha: r.ha, centro: js(r.centro), contorno: js(r.contorno), atualizado_em: r.atualizado_em };
}

export function dados(env) {
  const db = env.DB, r2 = env.PROJETOS;
  const um = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const todos = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
  const rodar = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const chaveProjeto = (conta, chave) => 'projetos/' + conta + '/' + chave + '.json.gz';

  return {
    pronto: () => !!db,

    /* ---------- contas e sessões ---------- */
    /* a conta desta Conta Atos (cria na primeira entrada; e-mail e nome acompanham a Atos) */
    async contaDaAtos({ sub, email, nome }) {
      const c = await um('select id, email, nome from contas where atos_sub = ?', sub);
      if (c) {
        if (c.email !== email || (nome && c.nome !== nome)) await rodar('update contas set email = ?, nome = ? where id = ?', email, nome || c.nome, c.id);
        return { id: c.id, email, nome: nome || c.nome || '' };
      }
      const id = 'c-' + crypto.randomUUID();
      await rodar('insert into contas (id, atos_sub, email, nome, criado_em) values (?, ?, ?, ?, ?) on conflict (atos_sub) do nothing', id, sub, email, nome || null, agora());
      const n = await um('select id, email, nome from contas where atos_sub = ?', sub);   // outra entrada pode ter criado junto
      return { id: n.id, email: n.email, nome: n.nome || '' };
    },
    async sessaoNova(contaId) {
      const token = aleatorio(32), expira = new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString();
      await rodar('insert into sessoes (hash, conta_id, criado_em, expira) values (?, ?, ?, ?)', await sha256(token), contaId, agora(), expira);
      return { token, expira };
    },
    /* quem é o dono deste token; null se não existe ou venceu */
    async contaDaSessao(token) {
      const r = await um('select c.id, c.email, c.nome, s.expira from sessoes s join contas c on c.id = s.conta_id where s.hash = ?', await sha256(token));
      if (!r || Date.parse(r.expira) < Date.now()) return null;
      return { id: r.id, email: String(r.email).toLowerCase(), nome: r.nome || '' };
    },
    async sessaoFim(token) { await rodar('delete from sessoes where hash = ?', await sha256(token)); },

    /* ---------- compras ---------- */
    async compraNova(c) {
      await rodar('insert into compras (id, conta_id, email, acesso_hash, plano, area_hash, ha, camadas, valor, cupom, status, criado_em) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        c.id, c.user_id || null, c.email, c.acesso_hash || null, c.plano, c.area_hash, c.ha, JSON.stringify(c.camadas || []), c.valor, c.cupom || null, 'pendente', agora());
    },
    compra: async id => compraDe(await um('select * from compras where id = ?', id)),
    /* muda o status; soPendente: só se ainda estiver pendente (o Pix antigo não derruba uma compra paga) */
    async compraStatus(id, status, soPendente) {
      await rodar('update compras set status = ? where id = ?' + (soPendente ? " and status = 'pendente'" : ''), status, id);
    },
    async compraConfirmar(id) {
      await db.batch([
        db.prepare("update compras set status = 'pago', pago_em = coalesce(pago_em, ?) where id = ?").bind(agora(), id),
        db.prepare('update cupom_usos set pago = 1 where compra_id = ?').bind(id)]);
    },
    async compraBaixada(id, downloads) { await rodar('update compras set downloads = ?, ultimo_download = ? where id = ?', downloads, agora(), id); },
    async comprasPagas(contaId) {
      return (await todos("select * from compras where conta_id = ? and status = 'pago' order by pago_em desc limit 300", contaId)).map(compraDe);
    },

    /* ---------- cupons ---------- */
    async cupomConferir({ codigo, conta, email, ha, area }) {
      const c = await um('select * from cupons where codigo = ?', String(codigo || '').trim().toUpperCase());
      if (!c || !c.ativo) return { ok: false, motivo: 'Cupom não encontrado.' };
      if (c.validade && Date.parse(c.validade) < Date.now()) return { ok: false, motivo: 'Este cupom venceu.' };
      if (c.area_min != null && ha < c.area_min) return { ok: false, motivo: 'Este cupom vale a partir de ' + c.area_min + ' ha.' };
      if (!c.ilimitado) {
        const em = email ? String(email).trim().toLowerCase() : null, quem = conta || null;
        const mesma = '((? is not null and u.conta_id = ?) or (? is not null and u.email = ?))';
        if (await um('select 1 from cupom_usos u where u.cupom = ? and u.pago = 1 and ' + mesma, c.codigo, quem, quem, em, em))
          return { ok: false, motivo: 'Você já usou este cupom.' };
        if (area && await um('select 1 from cupom_usos u join compras k on k.id = u.compra_id where u.cupom = ? and u.pago = 1 and k.area_hash = ?', c.codigo, area))
          return { ok: false, motivo: 'Este cupom já foi usado neste talhão.' };
        if (c.so_primeira && await um("select 1 from compras k where k.status = 'pago' and ((? is not null and k.conta_id = ?) or (? is not null and lower(k.email) = ?))", quem, quem, em, em))
          return { ok: false, motivo: 'Este cupom é só para a primeira compra.' };
        if (c.usos_max != null) {
          const n = await um('select count(*) n from cupom_usos u where u.cupom = ? and u.pago = 1 and not ' + mesma, c.codigo, quem, quem, em, em);
          if (n.n >= c.usos_max) return { ok: false, motivo: 'Os usos deste cupom acabaram.' };
        }
      }
      return { ok: true, codigo: c.codigo, desconto: c.desconto, fixo: c.fixo, gratis: !!c.gratis, validade: c.validade || null, ilimitado: !!c.ilimitado };
    },
    /* reserva o cupom para a compra; devolve a compra pendente que perdeu a reserva (ou null). Lança se já foi pago. */
    async cupomReservar({ codigo, conta, email, compra }) {
      const c = await um('select ilimitado from cupons where codigo = ?', codigo);
      if (c && c.ilimitado) return null;
      const em = email ? String(email).trim().toLowerCase() : null;
      if (!conta && !em) throw new Error('sem dono');
      const u = conta ? await um('select compra_id, pago from cupom_usos where cupom = ? and conta_id = ?', codigo, conta)
        : await um('select compra_id, pago from cupom_usos where cupom = ? and conta_id is null and email = ?', codigo, em);
      if (u) {
        if (u.pago) throw new Error('cupom já usado');
        if (conta) await rodar('update cupom_usos set compra_id = ?, criado_em = ?, email = coalesce(?, email) where cupom = ? and conta_id = ?', compra, agora(), em, codigo, conta);
        else await rodar('update cupom_usos set compra_id = ?, criado_em = ? where cupom = ? and conta_id is null and email = ?', compra, agora(), codigo, em);
        return u.compra_id !== compra ? u.compra_id : null;
      }
      await rodar('insert into cupom_usos (cupom, conta_id, email, compra_id, criado_em) values (?, ?, ?, ?, ?)', codigo, conta || null, em, compra, agora());
      return null;
    },

    /* ---------- cadastro e talhões ---------- */
    async perfil(contaId) {
      const p = await um('select * from perfis where conta_id = ?', contaId);
      return p ? Object.assign({}, p, { user_id: p.conta_id }) : null;
    },
    async perfilGravar(contaId, d) {
      const t = agora();
      await rodar('insert into perfis (conta_id, nome, cpf, whatsapp, cep, logradouro, numero, complemento, bairro, cidade, uf, ibge, criado_em, atualizado_em) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'on conflict (conta_id) do update set nome = excluded.nome, cpf = excluded.cpf, whatsapp = excluded.whatsapp, cep = excluded.cep, logradouro = excluded.logradouro, numero = excluded.numero, ' +
        'complemento = excluded.complemento, bairro = excluded.bairro, cidade = excluded.cidade, uf = excluded.uf, ibge = excluded.ibge, atualizado_em = excluded.atualizado_em',
        contaId, d.nome, d.cpf, d.whatsapp, d.cep, d.logradouro, d.numero, d.complemento || null, d.bairro, d.cidade, d.uf, d.ibge || null, t, t);
    },
    talhoes: async contaId => (await todos('select * from talhoes where conta_id = ? order by atualizado_em desc limit 300', contaId)).map(talhaoDe),
    async talhaoGravar(contaId, t) {
      const h = agora();
      await rodar('insert into talhoes (conta_id, chave, codigo, nome, area_hash, ha, centro, contorno, criado_em, atualizado_em) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'on conflict (conta_id, chave) do update set codigo = excluded.codigo, nome = excluded.nome, area_hash = excluded.area_hash, ha = excluded.ha, centro = excluded.centro, contorno = excluded.contorno, atualizado_em = excluded.atualizado_em',
        contaId, t.chave, t.codigo, t.nome, t.area_hash || null, t.ha == null ? null : t.ha, t.centro ? JSON.stringify(t.centro) : null, t.contorno ? JSON.stringify(t.contorno) : null, h, h);
    },

    /* ---------- projetos (R2) ---------- */
    projetosPronto: () => !!r2,
    async projetoGravar(contaId, chave, corpo) { await r2.put(chaveProjeto(contaId, chave), corpo, { httpMetadata: { contentType: 'application/gzip' } }); },
    async projetoLer(contaId, chave) { const o = await r2.get(chaveProjeto(contaId, chave)); return o ? await o.arrayBuffer() : null; },

    /* ---------- excluir a conta ----------
       Apaga sessões, cadastro, talhões, projetos, usos de cupom e a conta. As compras pagas ficam (obrigação
       fiscal), mas desligadas: sem conta e com uma chave de acesso que ninguém tem. */
    async contaExcluir(contaId) {
      if (r2) {
        for (let volta = 0; volta < 50; volta++) {
          const l = await r2.list({ prefix: 'projetos/' + contaId + '/', limit: 1000 });
          const nomes = (l.objects || []).map(o => o.key);
          if (nomes.length) await r2.delete(nomes);
          if (!l.truncated) break;
        }
      }
      const tranca = await sha256(aleatorio(32));
      await db.batch([
        db.prepare('update compras set conta_id = null, acesso_hash = ? where conta_id = ?').bind(tranca, contaId),
        db.prepare('delete from cupom_usos where conta_id = ?').bind(contaId),
        db.prepare('delete from talhoes where conta_id = ?').bind(contaId),
        db.prepare('delete from perfis where conta_id = ?').bind(contaId),
        db.prepare('delete from sessoes where conta_id = ?').bind(contaId),
        db.prepare('delete from contas where id = ?').bind(contaId)]);
    }
  };
}
