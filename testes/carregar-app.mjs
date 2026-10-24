// Executa os blocos reais do HTML, sem copiar suas funções para os testes.
// Não carrega mapa, DOM, rede ou os blocos que iniciam a interface.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../plantare-maps.html', import.meta.url), 'utf8');

export function carregarApp(modulos, expressao) {
  const contexto = vm.createContext({ TextEncoder, TextDecoder, Blob });
  for (const nome of modulos) {
    const blocos = [...html.matchAll(/<script data-modulo="([^"]+)">([\s\S]*?)<\/script>/g)]
      .filter((b) => b[1] === nome);
    assert.equal(blocos.length, 1, `o módulo ${nome} deve existir uma única vez no HTML`);
    vm.runInContext(blocos[0][2], contexto, { filename: `plantare-maps.html:${nome}`, timeout: 5000 });
  }
  return vm.runInContext(expressao, contexto, { timeout: 5000 });
}
