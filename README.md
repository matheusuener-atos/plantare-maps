# Plantare Maps

Planejamento agrícola a partir do talhão: bordadura, linhas AB, percurso,
manobras e exportação para uso em programas e equipamentos de campo.

- `plantare-maps.html`: aplicativo, incluindo interface e núcleo de cálculo.
- `pix-worker/`: conta, Pix, armazenamento e geração dos arquivos pagos.
- `site/`: montagem e publicação do aplicativo/PWA.
- `testes/`: regras de planejamento no navegador e regressões essenciais.

## Testes essenciais

Com Node.js 24, na raiz:

```sh
npm ci --prefix pix-worker --omit=dev
npm test
```

A instalação usa o lockfile do Worker e traz o SDK da Conta Atos. A execução
dos testes usa SQLite em memória, a migração D1 versionada e respostas
simuladas de Mercado Pago, Conta Atos, R2 e e-mail. Não exige segredos,
Wrangler, navegador ou acesso a contas reais.

| Comando | Cobertura |
| --- | --- |
| `npm run test:worker` | Suíte existente: conta, Pix, cupons, isolamento, revogação de sessões, preço por polígono e entrega dos formatos pagos com a fixture `pix-worker/test/plano_arvore.json` |
| `npm run test:nucleo` | Preço do HTML versus servidor, área com obstáculos, projeção UTM/WGS84 e continuidade de trechos |
| `npm test` | As duas suítes acima, parando se o Worker falhar |

O CI `.github/workflows/ci.yml` executa esses comandos em Linux e Windows,
com Node 24, nos pull requests e nas alterações da `main`. Também aceita
execução manual. Não publica o produto nem modifica serviços remotos.

Os testes de núcleo carregam os blocos reais de JavaScript do HTML em um
contexto isolado do Node; não mantêm cópias das funções do aplicativo.
`testes/casos-preco.json` fornece valores esperados para ambas as versões do
preço. Há também comparação das combinações de camadas, faixas e cupons.
Esses testes detectam divergência entre as duas implementações; não eliminam
a duplicação existente da regra de preço.

## Planejamento completo no navegador

```sh
npm ci --prefix testes
npm run test:campo
```

Este comando executa a suíte existente `testes/regras.mjs`, que exige Google
Chrome instalado, portas locais disponíveis e acesso às dependências do
aplicativo servidas por CDN e aos serviços do mapa. `playwright-core` controla
o Chrome instalado, sem instalar um navegador próprio.

A suíte importa os arquivos KML, KMZ e JSON de `testes/talhoes/`, gera planos
com diferentes preferências e verifica as regras descritas no próprio
arquivo: cruzamentos, invasão, raios, obstáculos, cobertura e continuidade.
Talhões grandes podem levar vários minutos por combinação. Ela é uma
verificação complementar e não está incluída no workflow essencial.

## Limites da verificação e roteiro de campo

O CI verifica primitivas geométricas e a entrega de um plano salvo. Não
comprova o planejamento completo na interface, precisão agronômica,
comportamento dos serviços Cloudflare reais, Pix de produção ou aceitação de
um arquivo por um monitor agrícola. A suíte do navegador também não substitui
validação em equipamento.

Para mudanças no gerador ou exportação, registrar na issue ou no PR:

1. Talhão de teste autorizado, equipamento/programa alvo, versão e sistema
   de coordenadas esperado. Usar dados fictícios ou autorizados para compartilhar.
2. Resultado da suíte de navegador para as preferências afetadas, incluindo
   obstáculos, raio mínimo da máquina e falhas que o programa avisa.
3. Importação dos formatos prometidos no equipamento/programa alvo:
   posicionamento, unidade, projeção, linhas AB, ordem e continuidade do
   percurso, bordadura e manobras. Anotar rejeições e diferenças.
4. Conferência por quem conhece a operação, incluindo limites do talhão e
   obstáculos. Registrar o resultado antes de uso operacional.
5. Para mudanças na cobrança, executar Pix e avisos em ambiente de teste e
   conferir que o pedido libera somente as camadas compradas, sem cobrança
   duplicada. Não registrar credenciais no relatório.

## Publicação

Veja [o serviço de conta, pagamento e entrega](pix-worker/README.md) para
configuração e publicação do Worker. O aplicativo é montado por
`site/montar.mjs`, conforme `site/wrangler.toml`. Publicação é uma etapa
separada da execução dos testes.

A [integração de compras Atos](docs/ATOS-M3.md) está implementada em teste,
com direitos por intenção e preservação do legado. [Homologação e corte](docs/ATOS-M4.md)
registram as evidências e o próximo ponto de implementação.
