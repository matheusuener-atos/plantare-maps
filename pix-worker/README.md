# Plantare · serviço de pagamento e entrega

Cloudflare Worker que cobra os arquivos do Plantare Maps por Pix (Mercado Pago, Orders API) e **gera os arquivos pagos** (KML, KMZ, AB, rota, Shapefile, GeoJSON, CSV).
O app não tem mais esse gerador: depois do pagamento, ele manda o plano para `/pacote` e recebe os arquivos prontos, carimbados com a conta e o pedido.
Relatório PDF, imagem PNG e projeto JSON continuam grátis e saem do próprio navegador.

- Preço: calculado aqui, a partir do polígono do talhão (`src/preco.js`; a mesma conta está copiada no `plantare-maps.html`).
- Conta: **Conta Atos** ("Entrar com Atos", OpenID Connect pelo pacote [`@atos.dev.br/entrar`](https://atos.dev.br/integracao/)). Cada compra fica ligada a uma conta e a um talhão.
- Cupons: tabela `cupons` no Supabase, **um uso por conta** (desconto, preço fixo ou cortesia).

### Como o login funciona
1. O app chama `POST /conta/atos/ida`; o Worker gera `state`, `nonce` e o `code_verifier` (PKCE S256) e devolve o endereço da Atos. O app guarda esses valores e abre a Atos numa janela (bloqueada: na mesma aba, com o projeto salvo).
2. A Atos volta para a página do app (`ATOS_VOLTA`) com `?code=…&state=…&iss=…`. O app manda o endereço e o que guardou para `POST /conta/atos/volta`.
3. O Worker confere `state` e `iss`, troca o código no `/oauth/token` e confere o `id_token` (ES256 pela JWKS, `aud`, `exp`, `nonce`). Exige e-mail confirmado na Atos.
4. Acha o login do Supabase da pessoa pelo `sub` da Atos (tabela `contas_atos`); na primeira entrada, pelo e-mail (quem entrava pelo Google ou pelo código cai na mesma conta), ou cria um. Se o e-mail mudou na Atos, acompanha.
5. Abre a sessão do Supabase dessa pessoa (um link de entrada gerado e conferido aqui mesmo, sem e-mail) e devolve ao app. Daí em diante tudo é como antes: RLS, renovação pelo `refresh_token`, `Authorization: Bearer` no Worker.

## Publicar (uma vez)

### 1. Supabase
1. **SQL Editor › New query**: cole `supabase/plantare.sql` inteiro e clique **Run**. Cria `compras`, `cupons`, `cupom_usos`, as regras de acesso (RLS) e as funções. Depois rode, em ordem, os `00x_*.sql` (o `007_conta_atos.sql` é o do login pela Atos).
2. **Authentication › Sign In / Providers**
   - **Google**: desligue. O app não oferece mais.
   - **Email**: deixe ligado. O Worker abre a sessão por um link de entrada gerado no servidor (`admin/generate_link` + `verify`), que passa por esse provedor.
3. (Opcional, não testado) Quem já tinha conta ainda consegue pedir um código direto à API do Supabase, por fora do app. Para fechar isso, tire `{{ .ConfirmationURL }}` e `{{ .Token }}` do modelo **Authentication › Emails › Magic Link**: o link gerado pelo Worker não passa por e-mail.
4. **Project Settings › API Keys**: copie a **Secret key** (`sb_secret_…`). Ela vai só no Worker (passo 2) e nunca no app nem no repositório.

### 2. Worker
```bash
npm install
npx wrangler login
npx wrangler secret put MP_ACCESS_TOKEN        # Access Token de produção do Mercado Pago
npx wrangler secret put MP_WEBHOOK_SECRET      # assinatura secreta da tela de Webhooks
npx wrangler secret put SUPABASE_SERVICE_KEY   # a Secret key do passo 1.4
npx wrangler secret put AVISO_EMAIL            # (opcional) recebe a cópia de cada cortesia
npx wrangler deploy
```
**Conta Atos** (atos.dev.br › Workspace › Integrações): o aplicativo cadastrado com o endereço de retorno `https://plantaremaps.com.br/` (a própria página do app, com a barra no fim). No `wrangler.toml`, `ATOS_CLIENT_ID` com o client_id do acesso e `ATOS_VOLTA` com o mesmo endereço de retorno. Com `ATOS_CLIENT_ID` vazio, as rotas `/conta/atos/*` respondem 503 e ninguém entra.
Acesso do tipo **servidor** (com segredo): `compatibility_flags = ["nodejs_compat"]` no `wrangler.toml` e `npx wrangler secret put ATOS_CLIENT_SECRET` (o pacote lê o segredo de `process.env`). Acesso **público** não usa segredo.
**Precisa do plano Workers Paid** (US$ 5/mês na conta Cloudflare). Montar os arquivos gasta de ~40 ms (talhão pequeno) a ~300 ms de CPU (575 ha), e o plano grátis corta em 10 ms por pedido.

Webhook do Mercado Pago: `https://pix.plantaremaps.com.br/webhook`, evento **Order (Mercado Pago)**. Com ele, o pagamento fica registrado mesmo se a pessoa fechar o app antes do Pix cair.

Confira: `https://pix.plantaremaps.com.br/saude` deve responder `{"ok":true,"banco":true,...}`.

## Cupons
Crie e edite em **Table Editor › cupons** (ou por SQL). Um tipo por cupom:

| coluna | exemplo | efeito |
|---|---|---|
| `desconto` | `0.10` | 10% de desconto |
| `fixo` | `2` | a compra sai por R$ 2,00 (nunca acima do preço normal) |
| `gratis` | `true` | cortesia: baixa sem Pix, recibo por e-mail |

Regras opcionais: `usos_max` (quantas contas podem usar), `validade`, `so_primeira` (só para quem nunca comprou), `area_min` (ha), `ativo`.
Cada conta usa o mesmo cupom uma vez. Se a pessoa gerar outro Pix com o mesmo cupom, o Pix anterior é cancelado.
O segredo `CUPONS` antigo não é mais lido: passe os códigos que você tinha para a tabela.

Exemplo:
```sql
insert into public.cupons (codigo, gratis, usos_max, validade) values ('AMIGO', true, 10, now() + interval '30 days');
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

## Rotas
`/preco` (orçamento), `/eu` (compras pagas da conta), `/cobranca` (Pix), `/cortesia`, `/status/:id`, `/pacote` (arquivos pagos), `/conta/atos/ida` e `/conta/atos/volta` (login), `/conta/excluir`, `/webhook`, `/saude`.
`/eu` e `/conta/excluir` pedem `Authorization: Bearer <token do login>`; Pix, status e pacote aceitam a conta ou a chave de acesso de quem comprou sem conta.

## Testes
`npm test` roda 98 casos contra um Mercado Pago, um Supabase e uma Atos falsos: tabela de preços, login, cupom por conta, cortesia, Pix assíncrono, webhook, a entrega dos arquivos (só as camadas pagas, carimbadas, do talhão certo) e o "Entrar com Atos" (PKCE, `state` e código usados de novo, `id_token` assinado por outra chave, e-mail não confirmado, `access_denied`, conta antiga ligada pelo e-mail, e-mail trocado na Atos, segredo do acesso confidencial).
