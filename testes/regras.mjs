/* Banco de regras do gerador de percurso.
   Abre o app num Chrome sem janela, gera o plano de cada talhão de testes/talhoes/ com
   várias combinações de preferências e confere as regras que não podem ser violadas.

   Uso:  cd testes && npm install && npm test
   Um talhão novo é só copiar o .kml (ou .json de projeto) para testes/talhoes/.

   Regras duras (quebram o teste):
     R1  sem bifurcação: o percurso não cruza a si mesmo
     R2  nada invade a cerca nem obstáculo
     R3  nenhuma curva fecha abaixo do raio da máquina
     R4  "desviar e seguir" não pode gerar volta completa em obstáculo
     R5  "sempre pela bordadura" não pode virar volta pelo caminho curto
     R6  cobertura mínima conforme a preferência de conflito
     R7  "desviar e seguir" não pode aplicar o contorno do obstáculo como caminho
     R8  o percurso é um caminho só: cada perna começa onde a anterior terminou
     R9  nenhuma manobra encosta no meio de uma linha (isso é um garfo: a máquina não sabe seguir)
     R10 o percurso de trabalho não cruza a si mesmo (sem tolerância de ângulo; a volta ao início é medida à parte)
   O que o plano avisa que não atendeu (percViolacoes) sai no relatório, sem quebrar o teste. */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(AQUI, '..', 'plantare-maps.html');
const TALHOES = path.join(AQUI, 'talhoes');
let PORTA = 0;   // porta livre escolhida na hora: dá para rodar duas vezes ao mesmo tempo

/* combinações que exercitam os caminhos que mais brigam entre si */
const CASOS = [
  { nome: 'padrão', pref: {} },
  { nome: 'desviar + sem sobrepor', pref: { obst: 'desviar', sobreAplicado: false, conflito: 'falha' } },
  { nome: 'volta no obstáculo + sobrepor', pref: { obst: 'volta', conflito: 'sobrepor' } },
  { nome: 'retorno pela bordadura', pref: { retorno: 'bordadura' } },
  { nome: 'guarda-chuva', pref: { manobra: 'guarda' } },
];

const servidor = http.createServer((q, r) => {
  if (q.url === '/' || q.url.startsWith('/?')) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(readFileSync(APP)); }
  else { r.writeHead(404); r.end(); }
});
await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
PORTA = servidor.address().port;

console.log('Gerando os planos num Chrome sem janela. Cada combinação leva de alguns segundos a alguns minutos.\n');
const talhoes = readdirSync(TALHOES).filter(f => /\.(kml|kmz|json)$/i.test(f));
if (!talhoes.length) { console.log('Nenhum talhão em testes/talhoes/. Copie um .kml para lá.'); servidor.close(); process.exit(0); }

const navegador = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const falhas = [], linhas = [];

for (const arquivo of talhoes) {
  for (const caso of CASOS) {
    const ctx = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
    const pg = await ctx.newPage();
    const erros = []; pg.on('pageerror', e => erros.push(e.message));
    const rot = arquivo + ' · ' + caso.nome;
    const t0 = Date.now();
    process.stdout.write('  ▸ ' + rot.padEnd(46));
    try {
      await pg.goto('http://127.0.0.1:' + PORTA + '/');
      await pg.waitForFunction(() => typeof MAPA !== 'undefined' && MAPA.pronto, null, { timeout: 60000 });
      await pg.setInputFiles('#arquivo', path.join(TALHOES, arquivo));
      await pg.waitForFunction(() => E.passo === 'direcao' && E.opcoes && E.opcoes.length && !VOO.ativo, null, { timeout: 420000 });   // talhão grande demora a analisar
      await pg.evaluate(() => { const b = document.querySelector('#painelCorpo [data-opcao]'); if (b) b.click(); });
      await pg.evaluate(() => irParaPonto());
      await pg.waitForFunction(() => E.pontoSel && !E.comparando, null, { timeout: 240000 });
      await pg.evaluate(p => { E.pref = percLimpa(Object.assign({}, percPadrao(), p)); }, caso.pref);
      await pg.evaluate(() => irParaPrefs());
      await pg.evaluate(() => gerarPlano());
      await pg.waitForFunction(() => E.plano || E.etapa === 'plano', null, { timeout: 300000 });

      const r = await pg.evaluate(() => {
        const pl = E.plano, P = E.P, pr = percLimpa(E.pref), probs = pl.problemas || [];
        const raioMin = (pl.legs || []).reduce((m, l) => l.raio && l.raio < m ? l.raio : m, Infinity);
        return {
          pref: pr, legs: (pl.legs || []).length,
          cruzamentos: probs.filter(q => q.tipo === 'cruzamento').length,
          invasoes: probs.filter(q => q.grav === 'erro' && q.tipo !== 'cruzamento').length,
          raioCurto: probs.filter(q => /raio menor que o da máquina/i.test(q.m || '')).length,
          raioMin: isFinite(raioMin) ? +raioMin.toFixed(2) : null, rMin: P.rMin,
          voltasObst: (pl.legs || []).reduce((n, l) => n + (l.voltasCompletas | 0), 0),
          contornoLegs: (pl.legs || []).filter(l => l.tipo === 'contorno').length,
          retornoCurto: !!(pl.otimizados || {}).retorno,
          falha: (pl.cobertura || {}).falha_pct, sobrep: (pl.cobertura || {}).sobrep_pct,
          cortes: (() => { const L = pl.legs || [], d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]); let n = 0;
            for (let i = 1; i < L.length; i++) { const a = L[i-1].p, b = L[i].p; if (a && b && d(a[a.length-1], b[0]) > 1.5) n++; } return n; })(),
          garfos: (() => { const L = pl.legs || [], d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]); let n = 0;
            L.forEach((l, i) => { if (l.t !== 'm' || !l.p) return;
              for (const q of [l.p[0], l.p[l.p.length-1]]) L.forEach((w, j) => {
                if (w.t !== 'w' || !w.p || Math.abs(i - j) < 2 || w.tipo === 'bordadura') return;   // o anel da bordadura é percorrido de propósito
                let melhor = Infinity, s = 0, acc = 0, total = 0;
                for (let k = 1; k < w.p.length; k++) total += d(w.p[k-1], w.p[k]);
                for (let k = 1; k < w.p.length; k++) { const A = w.p[k-1], B = w.p[k], Ls = d(A, B) || 1;
                  const t = Math.max(0, Math.min(1, ((q[0]-A[0])*(B[0]-A[0]) + (q[1]-A[1])*(B[1]-A[1])) / (Ls*Ls)));
                  const dd = Math.hypot(q[0]-(A[0]+(B[0]-A[0])*t), q[1]-(A[1]+(B[1]-A[1])*t));
                  if (dd < melhor) { melhor = dd; s = acc + Ls*t; } acc += Ls; }
                if (melhor <= 1.5 && Math.min(s, total - s) > 3) n++; });
            }); return n; })(),
          cruzamentos: (() => {
            // mesma definição do app: garfo é quando os caminhos se separam de pelo menos um lado.
            // Andar por cima (juntos antes e depois) não é garfo — a máquina segue reto.
            const L = (pl.legs || []).filter(l => l.t !== 'x' && l.tipo !== 'bordadura' && l.tipo !== 'retorno' && l.p && l.p.length > 1);
            const cru = []; for (const l of L) for (const q of l.p) if (!cru.length || Math.hypot(q[0]-cru[cru.length-1][0], q[1]-cru[cru.length-1][1]) > 1e-6) cru.push(q);
            const pts = []; const PASSO = 2;                       // reamostra de 2 em 2 m
            for (let i = 1; i < cru.length; i++) { const a = cru[i-1], b = cru[i], d = Math.hypot(b[0]-a[0], b[1]-a[1]);
              for (let t = 0; t < d; t += PASSO) pts.push([a[0] + (b[0]-a[0]) * (t/d), a[1] + (b[1]-a[1]) * (t/d)]); }
            const cr = (a,b,c,d) => { const rx=b[0]-a[0], ry=b[1]-a[1], sx=d[0]-c[0], sy=d[1]-c[1], den=rx*sy-ry*sx;
              if (Math.abs(den) < 1e-12) return null; const qx=c[0]-a[0], qy=c[1]-a[1], t=(qx*sy-qy*sx)/den, u=(qx*ry-qy*rx)/den;
              return (t>1e-9 && t<1-1e-9 && u>1e-9 && u<1-1e-9) ? [a[0]+rx*t, a[1]+ry*t] : null; };
            const em = i => pts[Math.max(0, Math.min(pts.length-1, i))];
            const dd = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
            const CEL = 20, g = new Map(), seg = [];
            for (let i = 1; i < pts.length; i++) { const a = pts[i-1], b = pts[i]; seg.push({ i, a, b });
              const x0=Math.floor(Math.min(a[0],b[0])/CEL), x1=Math.floor(Math.max(a[0],b[0])/CEL);
              const y0=Math.floor(Math.min(a[1],b[1])/CEL), y1=Math.floor(Math.max(a[1],b[1])/CEL);
              for (let x=x0;x<=x1;x++) for (let y=y0;y<=y1;y++){ const c=x+'|'+y; let l=g.get(c); if(!l) g.set(c,l=[]); l.push(seg.length-1); } }
            const achados = [];
            for (const ids of g.values()) for (let p1=0;p1<ids.length;p1++) for (let q1=p1+1;q1<ids.length;q1++){
              const A = seg[ids[p1]], B = seg[ids[q1]]; if (Math.abs(A.i - B.i) < 6) continue;
              const x = cr(A.a, A.b, B.a, B.b); if (!x) continue;
              const lado = o => Math.min(dd(em(A.i+o), em(B.i+o)), dd(em(A.i+o), em(B.i-o)));
              if (lado(-6) <= 3 && lado(6) <= 3) continue;         // andam juntos: não é garfo
              if (achados.some(z => Math.hypot(z[0]-x[0], z[1]-x[1]) < 8)) continue; achados.push(x); }
            return achados.length; })(),
          fora: percViolacoes().map(v => v.t + ': ' + v.m)
        };
      });

      const erra = [];
      if (r.cruzamentos) erra.push('R1 bifurcação (' + r.cruzamentos + ')');
      if (r.invasoes) erra.push('R2 invasão (' + r.invasoes + ')');
      if (r.raioCurto) erra.push('R3 raio abaixo do da máquina (' + r.raioCurto + ')');
      if (r.pref.obst === 'desviar' && r.voltasObst) erra.push('R4 volta completa com "desviar" (' + r.voltasObst + ')');
      if (r.pref.obst === 'desviar' && r.contornoLegs) erra.push('R7 contorno do obstáculo virou caminho aplicado (' + r.contornoLegs + ')');
      if (r.pref.retorno === 'bordadura' && r.retornoCurto) erra.push('R5 retorno saiu pelo caminho curto');
      const limFalha = r.pref.conflito === 'falha' ? 6 : 2;
      if (r.falha > limFalha) erra.push('R6 falha de ' + r.falha.toFixed(1) + '% (limite ' + limFalha + '%)');
      if (r.cortes) erra.push('R8 percurso partido em ' + (r.cortes + 1) + ' pedaços');
      if (r.garfos) erra.push('R9 manobra encostando no meio de uma linha (' + r.garfos + ')');
      if (r.cruzamentos) erra.push('R10 o percurso cruza a si mesmo (' + r.cruzamentos + ')');
      if (erros.length) erra.push('erro de JavaScript: ' + erros[0]);

      linhas.push({ rot, ok: !erra.length, legs: r.legs, falha: +(+r.falha).toFixed(1), sobrep: +(+r.sobrep).toFixed(1), erra, fora: r.fora });
      console.log((erra.length ? 'FALHA' : 'ok   ') + '  (' + Math.round((Date.now() - t0) / 1000) + ' s)');
      if (erra.length) falhas.push(rot + ' → ' + erra.join(' · '));
    } catch (e) {
      linhas.push({ rot, ok: false, erra: ['não gerou: ' + String(e.message).slice(0, 80)], fora: [] });
      falhas.push(rot + ' → não gerou o plano');
      console.log('FALHA  (' + Math.round((Date.now() - t0) / 1000) + ' s)');
    }
    await ctx.close();
  }
}

await navegador.close(); servidor.close();

console.log('\n' + '='.repeat(72));
for (const l of linhas) {
  console.log((l.ok ? '  ok  ' : ' FALHA') + ' │ ' + l.rot.padEnd(42) + (l.legs ? ' ' + String(l.legs).padStart(4) + ' pernas · falha ' + l.falha + '% · sobrep ' + l.sobrep + '%' : ''));
  for (const e of l.erra) console.log('       │   ✗ ' + e);
  for (const v of l.fora) console.log('       │   · avisou: ' + v);
}
console.log('='.repeat(72));
console.log(falhas.length ? falhas.length + ' de ' + linhas.length + ' combinações violaram alguma regra.' : linhas.length + ' combinações, nenhuma regra violada.');
process.exit(falhas.length ? 1 : 0);
