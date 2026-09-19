# Plantare · serviço de pagamento e entrega

Cloudflare Worker que cobra os arquivos do Plantare Maps por Pix (Mercado Pago, Orders API) e **gera os arquivos pagos** (KML, KMZ, AB, rota, Shapefile, GeoJSON, CSV).
O app não tem mais esse gerador: depois do pagamento, ele manda o plano para `/pacote` e recebe os arquivos prontos, carimbados com a conta e o pedido.
Relatório PDF, imagem PNG e projeto JSON continuam grátis e saem do próprio navegador.

- Preço: calculado aqui, a partir do polígono do talhão (`src/preco.js`; a mesma conta está copiada no `plantare-maps.html`).
- Conta: login do Supabase (Google ou link/código por e-mail). Cada compra fica ligada a uma conta e a um talhão.
- Cupons: tabela `cupons` no Supabase, **um uso por conta** (desconto, preço fixo ou cortesia).

## Publicar (uma vez)

### 1. Supabase
1. **SQL Editor › New query**: cole `supabase/plantare.sql` inteiro e clique **Run**. Cria `compras`, `cupons`, `cupom_usos`, as regras de acesso (RLS) e as funções.
2. **Authentication › URL Configuration**
   - Site URL: `https://plantaremaps.com.br`
   - Redirect URLs: `https://plantaremaps.com.br`, `https://plantaremaps.com.br/**` (e `http://localhost:*` se testar local)
3. **Authentication › Sign In / Providers › Google**: ligue e cole o *Client ID* e o *Client Secret* do Google.
   No Google Cloud Console (APIs e serviços › Credenciais › Criar ID do cliente OAuth › Aplicativo da Web):
   - Origens JavaScript autorizadas: `https://plantaremaps.com.br`
   - URIs de redirecionamento autorizados: `https://yhzyfcdfpezgtnrrslqv.supabase.co/auth/v1/callback`
4. (Opcional) **Authentication › Emails › Magic Link**: acrescente `{{ .Token }}` ao texto para o e-mail trazer também o código de 6 dígitos.
   O envio de e-mail padrão do Supabase tem limite baixo por hora; para uso real, configure um SMTP próprio em **Authentication › Emails › SMTP**.
5. **Project Settings › API Keys**: copie a **Secret key** (`sb_secret_…`). Ela vai só no Worker (passo 2) e nunca no app nem no repositório.

### 2. Worker
```bash
npm install
npx wrangler login
npx wrangler secret put MP_ACCESS_TOKEN        # Access Token de produção do Mercado Pago
npx wrangler secret put MP_WEBHOOK_SECRET      # assinatura secreta da tela de Webhooks
npx wrangler secret put SUPABASE_SERVICE_KEY   # a Secret key do passo 1.5
npx wrangler secret put AVISO_EMAIL            # (opcional) recebe a cópia de cada cortesia
npx wrangler deploy
```
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
`/preco` (orçamento), `/eu` (compras pagas da conta), `/cobranca` (Pix), `/cortesia`, `/status/:id`, `/pacote` (arquivos pagos), `/webhook`, `/saude`.
Todas, menos `/preco`, `/saude` e `/webhook`, pedem `Authorization: Bearer <token do login>`.

## Testes
`npm test` roda 54 casos contra um Mercado Pago e um Supabase falsos: tabela de preços, login, cupom por conta, cortesia, Pix assíncrono, webhook e a entrega dos arquivos (só as camadas pagas, carimbadas, do talhão certo).
