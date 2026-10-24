import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { carregarApp } from './carregar-app.mjs';

const motor = carregarApp(['base', 'motor', 'exportacao'],
  '({ makeUTM, costurarLegs, trechosDeTrabalho, percursoContinuo })');

test('UTM respeita os referenciais do meridiano central no equador', () => {
  assert.deepEqual(structuredClone(motor.makeUTM(-57, false).fwd(-57, 0)), [500000, 0]);
  assert.deepEqual(structuredClone(motor.makeUTM(-57, true).fwd(-57, 0)), [500000, 10000000]);
});

test('UTM preserva coordenadas na ida e volta em diferentes regiões', () => {
  for (const [lon, lat] of [[-55, -12], [-47, -16], [-51, -30], [-60, 3]]) {
    const zone = Math.floor((lon + 180) / 6) + 1;
    const proj = motor.makeUTM(zone * 6 - 183, lat < 0);
    const volta = proj.inv(...proj.fwd(lon, lat));
    assert.ok(Math.abs(volta[0] - lon) < 1e-6, `longitude: ${lon}, ${lat}`);
    assert.ok(Math.abs(volta[1] - lat) < 1e-6, `latitude: ${lon}, ${lat}`);
  }
});

test('coordenadas do plano versionado sobrevivem à conversão UTM/WGS84', () => {
  const fixture = JSON.parse(readFileSync(new URL('../pix-worker/test/plano_arvore.json', import.meta.url)));
  const proj = motor.makeUTM(fixture.crs.zone * 6 - 183, fixture.crs.south);
  assert.ok(fixture.legs.length > 0);
  for (const leg of fixture.legs) for (const ponto of [leg.p[0], leg.p.at(-1)]) {
    const volta = proj.fwd(...proj.inv(...ponto));
    assert.ok(Math.hypot(volta[0] - ponto[0], volta[1] - ponto[1]) < 0.02,
      'conversão do percurso deve preservar pontos em até 2 cm');
  }
});

test('costura aproxima pontas vizinhas sem modificar o plano original', () => {
  const legs = [
    { t: 'w', p: [[0, 0], [10, 0]] },
    { t: 'm', p: [[10.2, 0], [10, 10]] },
  ];
  const antes = structuredClone(legs);
  const r = motor.costurarLegs(legs);
  assert.equal(r.costuras, 1);
  assert.equal(r.vaos.length, 0);
  assert.deepEqual(structuredClone(r.legs[1].p[0]), [10, 0]);
  assert.deepEqual(legs, antes);
});

test('um vão grande é declarado, sem inventar uma ligação', () => {
  const r = motor.costurarLegs([
    { t: 'w', p: [[0, 0], [10, 0]] },
    { t: 'w', p: [[20, 0], [30, 0]] },
  ]);
  assert.equal(r.costuras, 0);
  assert.equal(r.vaos.length, 1);
  assert.equal(r.vaos[0].d, 10);
  assert.deepEqual(structuredClone(r.legs[1].p[0]), [20, 0]);
});

test('deslocamento separa trechos de trabalho e seus pontos intermediários não são exportados', () => {
  const legs = [
    { t: 'w', p: [[0, 0], [10, 0]] },
    { t: 'x', p: [[10, 0], [15, 99], [20, 20]] },
    { t: 'w', p: [[20, 20], [30, 20]] },
  ];
  assert.equal(motor.trechosDeTrabalho(legs).length, 2);
  assert.deepEqual(structuredClone(motor.percursoContinuo(legs)), [[0, 0], [10, 0], [20, 20], [30, 20]]);
});
