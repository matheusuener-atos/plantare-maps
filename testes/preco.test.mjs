import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PRECO, NOMES_CAMADAS, calcularPreco, areaPoligonos } from '../pix-worker/src/preco.js';
import { carregarApp } from './carregar-app.mjs';

const app = carregarApp(['preco'], '({ PRECO, NOMES_CAMADAS, calcularPreco, areaPoligonos })');
const casos = JSON.parse(readFileSync(new URL('./casos-preco.json', import.meta.url)));
const camadas = Object.keys(PRECO.camadas);

test('a tabela de preço apresentada é a mesma usada para cobrar', () => {
  assert.deepEqual(structuredClone(app.PRECO), PRECO);
  assert.deepEqual(structuredClone(app.NOMES_CAMADAS), NOMES_CAMADAS);
});

for (const caso of casos) {
  test(`preço compartilhado: ${caso.nome}`, () => {
    const exibido = structuredClone(app.calcularPreco(caso.ha, caso.camadas, caso.cupom));
    const cobrado = calcularPreco(caso.ha, caso.camadas, caso.cupom);
    assert.equal(exibido.total, caso.total, 'valor esperado no app');
    assert.equal(cobrado.total, caso.total, 'valor esperado no servidor');
    assert.deepEqual(exibido, cobrado, 'todos os campos do orçamento devem coincidir');
  });
}

test('preço coincide nas combinações de camadas, limites e cupons', () => {
  const areas = [0, 0.01, 18.7, 299.99, 300, 300.01, 599.99, 600, 600.01, 999.99, 1000, 1000.01, 1200, 50000];
  const cupons = [undefined, 0, 0.1, 0.9, { fixo: 2 }, { fixo: 5000 }, { gratis: true }];
  for (let mascara = 0; mascara < 16; mascara++) {
    const escolhidas = camadas.filter((_, i) => mascara & (1 << i));
    for (const ha of areas) for (const cupom of cupons) {
      assert.deepEqual(structuredClone(app.calcularPreco(ha, escolhidas, cupom)),
        calcularPreco(ha, escolhidas, cupom), JSON.stringify({ ha, escolhidas, cupom }));
    }
  }
});

test('área faturada: mesmo talhão e obstáculos no app e no servidor', () => {
  const fixture = JSON.parse(readFileSync(new URL('../pix-worker/test/plano_arvore.json', import.meta.url)));
  assert.ok(areaPoligonos(fixture.polys) > 0);
  assert.equal(app.areaPoligonos(fixture.polys), areaPoligonos(fixture.polys));
  const outer = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]];
  const hole = [[0.002, 0.002], [0.008, 0.002], [0.008, 0.008], [0.002, 0.008]];
  const cheio = [{ outer, holes: [] }], vazado = [{ outer, holes: [hole] }];
  const esperado = areaPoligonos(cheio) - areaPoligonos([{ outer: hole, holes: [] }]);
  assert.equal(app.areaPoligonos(vazado), esperado);
  assert.equal(areaPoligonos(vazado), esperado);
  assert.equal(app.areaPoligonos([{ outer: [...outer].reverse(), holes: [[...hole].reverse()] }]), esperado);
});
