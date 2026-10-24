# Plantare · serviço de conta, pagamento e entrega

> A cobrança direta descrita aqui é a implementação atual. A integração
> central com a Atos está no [plano de adaptação](../docs/COBRANCA-ATOS.md),
> ainda sem migração de pagamentos ou mudança de rotas em produção.

Cloudflare Worker que guarda as contas do Plantare Maps, cobra os arquivos por Pix (Mercado Pago, Orders API) e **gera os arquivos pagos** (KML, KMZ, AB, rota, Shapefile, GeoJSON, CSV).
O app não tem mais esse gerador: depois do pagamento, ele manda o plano para `/pacote` e recebe os arquivos prontos, carimbados com a conta e o pedido.
Relatório PDF, imagem PNG e projeto JSON continuam grátis e saem do próprio navegador.

- Preço: calculado aqui, a partir do polígono do talhão (`src/preco.js`; a mesma conta está copiada no `plantare-maps.html`).
- Conta: **Conta Atos** ("Entrar com Atos", OpenID Connect pelo pacote [`@atos.dev.br/entrar`](https://atos.dev.br/integracao/)). Cada compra fica ligada a uma conta e a um talhão.
- Dados: **Cloudflare D1** (contas, sessões, compras, cupons, cadastro, talhões) e **R2** (o projeto inteiro de cada talhão). Só o `src/dados.js` conhece os dois: trocar de serviço é reescrever esse arquivo, com as mesmas funções.
- Cupons: tabela `cupons` no D1, **um uso por conta** (desconto, preço fixo ou cortesia).

### Como o login funciona
1. O app chama `POST /conta/atos/ida`; o Worker gera `state`, `nonce` e o `code_verifier` (PKCE S256) e devolve o endereço da Atos. O app guarda esses valores e abre a Atos numa janela (bloqueada: na mesma aba, com o projeto salvo).
2. A Atos volta para a página do app (`ATOS_VOLTA`) com `?code=…&state=…&iss=…`. O app manda o endereço e o que guardou para `POST /conta/atos/volta`.
3. O Worker confere `state` e `iss`, troca o código no `/oauth/token` (com o segredo do acesso) e confere o `id_token` (ES256 pela JWKS, `aud`, `exp`, `nonce`). Exige e-mail confirmado na Atos.
4. Acha a conta pelo `sub` da Atos ou cria uma; se o e-mail ou o nome mudaram na Atos, acompanha.
5. Abre uma sessão: um token aleatório de 30 dias (o banco guarda só o SHA-256). O app manda `Authorization: Bearer <token>` em tudo da conta. Vencido, entra-se de novo; `/conta/sair` e "Excluir conta" apagam a sessão na hora.
6. Se a pessoa tira a permissão do Plantare na Atos (Minha conta › Aplicativos com acesso) ou sai da lista de liberados, a Atos avisa em `POST /atos/avisos` e as sessões dela acabam na hora, em todos os aparelhos. A conta e o que ela tem ficam; ao entrar de novo, a Atos pede a permissão outra vez.

### Avisos da Atos (uma vez)
Em atos.dev.br › Workspace › Integrações › Plantare Maps › **Avisos ao seu sistema**: endereço `https://pix.plantaremaps.com.br/atos/avisos`, **Cadastrar e gerar o segredo**, e o segredo (que a Atos mostra uma vez só) vai no Worker com `npx wrangler secret put ATOS_AVISOS_SEGREDO`. **Mandar um aviso de teste** deve aparecer como entregue. Sem o segredo, a rota responde 503 e a Atos tenta de novo mais tarde.

## Publicar (uma vez)

```bash
npm install
npx wrangler login
npx wrangler d1 create plantare                    # o id vai em [[d1_databases]] no wrangler.toml (já está)
npx wrangler d1 migrations apply plantare --remote # cria as tabelas (migrations/)
npx wrangler r2 bucket create plantare-projetos    # precisa do R2 ligado no painel (R2 Object Storage)
npx wrangler secret put MP_ACCESS_TOKEN            # Access Token de produção do Mercado Pago
npx wrangler secret put MP_WEBHOOK_SECRET          # assinatura secreta da tela de Webhooks
npx wrangler secret put ATOS_CLIENT_SECRET         # o segredo do acesso na Atos
npx wrangler secret put ATOS_AVISOS_SEGREDO        # o segredo dos avisos da Atos (veja acima)
npx wrangler secret put AVISO_EMAIL                # (opcional) recebe a cópia de cada cortesia
npx wrangler deploy
```
**Conta Atos** (atos.dev.br › Workspace › Integrações): acesso do tipo servidor, com o endereço de retorno `https://plantaremaps.com.br/` (a própria página do app, com a barra no fim). No `wrangler.toml`, `ATOS_CLIENT_ID` com o client_id do acesso e `ATOS_VOLTA` com o mesmo endereço. Com `ATOS_CLIENT_ID` vazio, as rotas `/conta/atos/*` respondem 503 e ninguém entra.
**Precisa do plano Workers Paid** (US$ 5/mês na conta Cloudflare). Montar os arquivos gasta de ~40 ms (talhão pequeno) a ~300 ms de CPU (575 ha), e o plano grátis corta em 10 ms por pedido.

Webhook do Mercado Pago: `https://pix.plantaremaps.com.br/webhook`, evento **Order (Mercado Pago)**. Com ele, o pagamento fica registrado mesmo se a pessoa fechar o app antes do Pix cair.

Confira: `https://pix.plantaremaps.com.br/saude` deve responder `{"ok":true,"banco":true,...}`.

## Cupons
Crie e edite pelo D1. Um tipo por cupom:

| coluna | exemplo | efeito |
|---|---|---|
| `desconto` | `0.10` | 10% de desconto |
| `fixo` | `2` | a compra sai por R$ 2,00 (nunca acima do preço normal) |
| `gratis` | `1` | cortesia: baixa sem Pix, recibo por e-mail |

Regras opcionais: `usos_max` (quantas pessoas podem usar), `validade` (data ISO, ex. `2026-12-31T23:59:59Z`), `so_primeira` (`1`: só para quem nunca comprou), `area_min` (ha), `ilimitado` (`1`: não conta uso nenhum), `ativo` (`0` desliga).
Cada pessoa (a conta, ou o e-mail de quem compra sem conta) usa o mesmo cupom uma vez, e cada cupom vale uma vez por talhão. Se a pessoa gerar outro Pix com o mesmo cupom, o Pix anterior é cancelado.

```bash
npx wrangler d1 execute plantare --remote --command "insert into cupons (codigo, gratis, usos_max, validade) values ('AMIGO', 1, 10, '2026-12-31T23:59:59Z')"
npx wrangler d1 execute plantare --remote --command "select codigo, desconto, fixo, gratis, ilimitado, usos_max, validade, ativo from cupons"
```

## Ajustes

| O quê | Onde |
|---|---|
| Quem pode chamar o serviço | `ORIGENS` no `wrangler.toml` (`null` libera o arquivo local, só para teste) |
| Rebaixar uma compra | `REBAIXAR_DIAS` (padrão 365; 0 = sem limite). Vale para o mesmo talhão e as mesmas camadas, em qualquer aparelho com a mesma conta |
| Validade do Pix | `EXPIRA` (padrão `PT30M`) |
| Aprovação automática do Pix de teste | `PAGADOR_TESTE = "APRO"`, **só com o token do vendedor de teste**. Apague antes de ir para produção |
| Preços e faixas | `src/preco.js` **e** o bloco `preco` do `plantare-maps.html` |
| Arquivos pagos (formato) | `src/exportar.js` |
| Onde os dados ficam | `src/dados.js` (e `migrations/` para o esquema do D1) |

## Rotas
`/preco` (orçamento), `/eu` (compras pagas da conta), `/cobranca` (Pix), `/cortesia`, `/status/:id`, `/pacote` (arquivos pagos), `/webhook` (Mercado Pago), `/atos/avisos` (Atos), `/saude`;
da conta: `/conta/atos/ida` e `/conta/atos/volta` (login), `/conta/sair`, `/conta/perfil`, `/conta/talhoes`, `/conta/talhoes/:chave`, `/conta/projetos/:chave`, `/conta/excluir`.
As da conta e `/eu` pedem `Authorization: Bearer <token da sessão>`; Pix, status e pacote aceitam a conta ou a chave de acesso de quem comprou sem conta.

## Testes
`npm test` roda 107 casos contra um Mercado Pago e uma Atos falsos e um D1 de verdade em SQLite (o `node:sqlite` do Node 24, com a mesma migração que vai ao ar) e um R2 em memória: tabela de preços, cupons (por conta, por e-mail, por talhão, ilimitado, banco fora do ar), cortesia, Pix assíncrono, webhook, a entrega dos arquivos (só as camadas pagas, carimbadas, do talhão certo), cadastro, talhões e projetos da conta (cada conta só vê o seu), sair e sessão vencida, excluir a conta e o "Entrar com Atos" (PKCE, `state` e código usados de novo, `id_token` assinado por outra chave, e-mail não confirmado, `access_denied`, e-mail trocado na Atos, segredo do acesso confidencial) e os avisos da Atos (assinatura, aviso velho, acesso tirado e lista de liberados encerrando só as sessões da pessoa).
