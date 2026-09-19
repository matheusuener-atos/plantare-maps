# Plantare · serviço Pix

Cloudflare Worker que cobra os arquivos do Plantare Maps por Pix (Mercado Pago, Orders API).
O preço é calculado aqui, a partir do polígono do talhão. A tabela fica em `src/preco.js`, e a mesma conta está copiada no `plantare.html`.

## Publicar (uma vez)

1. No Mercado Pago Developers, crie a aplicação e copie o **Access Token de produção**.
   Em **Webhooks**, cadastre `https://pix.plantaremaps.com.br/webhook` com o evento **Order (Mercado Pago)** e copie a **assinatura secreta**.
2. Neste diretório:
   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put MP_ACCESS_TOKEN
   npx wrangler secret put MP_WEBHOOK_SECRET
   npx wrangler deploy
   ```
   O `wrangler.toml` já liga o Worker em `pix.plantaremaps.com.br`. Como o domínio está na Cloudflare, o DNS é criado sozinho.
3. Confira: `https://pix.plantaremaps.com.br/saude` deve responder `{"ok":true,...}`.
4. No `plantare.html`, preencha `const PIX_API_PADRAO='https://pix.plantaremaps.com.br';` no bloco `preco`.
   Enquanto essa linha estiver vazia, o app fica no checkout demonstrativo, sem cobrança.

## Ajustes

| O quê | Onde |
|---|---|
| Quem pode chamar o serviço | `ORIGENS` no `wrangler.toml` (o endereço onde o Plantare estiver publicado; `null` libera o arquivo local, só para teste) |
| Cupons | `CUPONS` no `wrangler.toml`, ex.: `{"CAMPO10":0.10}` |
| Validade do Pix | `EXPIRA` (padrão `PT30M`) |
| Aprovação automática do Pix de teste | `PAGADOR_TESTE = "APRO"` no `wrangler.toml`, **só com o token do vendedor de teste**. Apague antes de ir para produção |
| Preços e faixas | `src/preco.js` **e** o bloco `preco` do `plantare.html` |

Para testar com credenciais de teste do Mercado Pago sem mexer no app publicado, abra o app e rode no console:
`localStorage.setItem('plantare_pix_api','https://pix.plantaremaps.com.br')`.

## Testes

`npm test` roda a tabela de preços, a criação do Pix, o status e a assinatura do webhook contra um Mercado Pago falso.
