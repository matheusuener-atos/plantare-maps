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
