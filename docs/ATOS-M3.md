# Compras centrais, projeção e entrega no Plantare

Implementado em 26/10/2026, sobre o CI do PR #4 e o contrato do PR #5.
Depende da plataforma Atos até o PR #13. Checkout central segue limitado a
teste; nenhuma migração ou publicação de produção foi executada nesta entrega.

## Responsabilidades e armazenamento

Plantare autentica a Conta Atos pela sessão local, calcula área e hash usando
o algoritmo existente e normaliza as camadas. Somente esse escopo é enviado
à Atos. Dono, preço e área informados pelo app não são autoridades. Geometria
e projeto não são enviados ao serviço de cobrança.

`0002_atos_compras.sql` acrescenta três tabelas:

| Tabela | Responsabilidade |
| --- | --- |
| `atos_intencoes` | Dono local e sub, escopo imutável, provedor, orçamento e marcador de conta excluída |
| `atos_compras` | Snapshot versionado, uma compra por intenção, contadores de download |
| `atos_inbox` | ID e digest do evento, recebimento e descarte por conta excluída |

As tabelas, IDs, chaves, datas e regras de download das compras legadas não
são reescritos. A migração não importa histórico, não cria cobranças e não
emite notas fiscais.

## Intenção, orçamento e checkout

`POST /atos/intencoes` exige sessão e recebe `{intent_id, plano, polys,
camadas, cupom?}`. Antes da chamada externa, salva dono, provedor e digest
do escopo. Mesmo ID com outro escopo é conflito. O orçamento da Atos é
validado e persistido antes de pedir a compra; as chaves S2S de orçamento e
checkout derivam do ID estável. Timeout preserva a intenção, sem fallback
para Mercado Pago legado. Orçamento vencido exige ação explícita de criar
outro orçamento; não troca silenciosamente a referência.

O app guarda o ID por conta/escopo no navegador e recupera a mesma compra.
Exibe o valor final da Atos e oferece **Abrir checkout Atos**, em pop-up;
se o navegador não abrir a janela, o link continua disponível como aba.
Preço local é apenas estimativa. Não há iframe ou confirmação por mensagem
de janela. Login é obrigatório para novas compras centrais; visitantes
antigos continuam com a chave original.

## Eventos e projeção

`POST /api/atos/eventos` é separado dos avisos OIDC em `/atos/avisos`.
Exige JSON de até 16 KiB, `Atos-Evento` e HMAC-SHA256 do corpo bruto com
`Atos-Assinatura: t=<segundos>,v1=<hex>`, tolerância de cinco minutos.
Confere tipo, produto, sub, schema, versão, IDs e escopo/orçamento locais.
Intenção desconhecida é recusada para reentrega, sem inventar vínculo por e-mail.

Inbox e projeção são gravados no mesmo `DB.batch`. Triggers verificam
conflitos também no commit: mesmo evento ou versão com conteúdo diferente
é erro; versão antiga não substitui nova; versão maior não restaura estado
revogado nem altera datas congeladas. Uma intenção não pode ganhar outro ID
de compra. Falha de banco não confirma recebimento.

Exclusão da conta marca suas intenções na mesma transação que remove sessões
e conta. Eventos posteriores são recebidos com descarte registrado, sem
recriar dono ou direito. Novo cadastro com o mesmo sub/e-mail não reata as
compras da conta local excluída.

## Consulta, listagem e arquivos

`GET /status/<cmp-id>` exige o mesmo dono, consulta a Atos e atualiza a
projeção. IDs centrais nunca são usados como orders do Mercado Pago.

`POST /pacote` central consulta o snapshot da Atos antes de gerar os arquivos;
confere dono, talhão, camadas permitidas, estado, direito ativo e prazo absoluto
`baixar_ate`. A configuração legada `REBAIXAR_DIAS` não prorroga esse prazo.
Indisponibilidade da Atos retorna erro temporário e preserva a compra. Uma
devolução recebida enquanto um GET antigo está em voo prevalece na projeção.
O contador usa incremento SQL, sem redefinir o contador legado.

`GET /eu?limite=50&cursor=...` combina as fontes, com cursor vinculado à conta,
até 100 linhas por página e indicação de continuação. O app percorre todas as
páginas e não considera uma compra central revogada/vencida como já paga para
download. O extrato mostra sua situação. `GET /eu` sem parâmetros conserva o
contrato legado para apps instalados. `GET /atos/compras` oferece a projeção
central paginada. Listagens são informativas; autorização vem da consulta
central antes da entrega.

## Configuração e reversão

| Configuração | Uso |
| --- | --- |
| `ATOS_NOVAS_COMPRAS` | `0` por padrão; `1` seleciona Atos somente para novas intenções |
| `AMBIENTE` | Novas compras centrais exigem `teste` nesta versão |
| `ATOS_COBRANCA_ORIGEM` | Origem Atos permitida, sem caminho; teste exige origem isolada |
| `ATOS_COBRANCA_TOKEN` | Segredo S2S, pelo menos 32 caracteres; não chega ao app |
| `ATOS_COMPRAS_SEGREDO` | Segredo exclusivo dos eventos de compra; não é o de avisos OIDC |

Aplicar a migração primeiro no banco isolado de teste, depois configurar a
integração. Não apontar o ambiente de teste ao D1/R2 de produção. Redirecionamentos
S2S são tratados manualmente e rejeitados, sem seguir com o token. A URL de
checkout precisa coincidir com a origem configurada e o ID da compra.

Desligar `ATOS_NOVAS_COMPRAS` bloqueia novas intenções, mas mantém recuperação,
eventos, consulta e entrega das anteriores. Manter origem, token, segredo e
tabelas. O endpoint legado recusa criar Pix para talhão com intenção central
da mesma conta. Não remover webhook/credenciais legados durante o dreno.

## Evidências

- `npm test`: 149 verificações aprovadas — 107 legadas, 18 novas de integração
  e 24 de preço/geometria. Cobrem dono errado, hashes/camadas, cortesia, prazo,
  devolução, versões fora de ordem, duplicação, rollback e exclusão de conta.
- Build de Worker e site em `wrangler deploy --dry-run`, sem publicação.
- Dois Workers Cloudflare locais: Atos/DO SQLite e Plantare/D1. Criação da
  intenção, Pix fictício, evento assinado, inbox/projeção, arquivos e devolução
  com download bloqueado. As migrações foram aplicadas apenas no D1 local.
- Edge com app/API/checkout em origens distintas: orçamento final, pop-up,
  confirmação por consulta do servidor e layout desktop/390 px. O plano foi
  preparado com fixture; não houve prova em equipamento nem geração de campo
  nova. O teste da entrega de arquivos foi executado pela API real do Worker.
- Reinício real preservou compra devolvida; desligar a flag manteve o mesmo
  ID, bloqueou novas intenções e impediu Pix legado de fallback.
- Backup nativo SQLite do D1 local e restauração em cópia isolada conservaram
  contagens, compra devolvida e integridade. Não é restauração de backup remoto.

Gateway, sessões/perfil e certificado do harness são sintéticos; Sefin é
simulada. Esta prova não substitui gateway real, configuração remota dos dois
Workers e corte de campanhas. Veja [M4 — homologação e corte](ATOS-M4.md).
