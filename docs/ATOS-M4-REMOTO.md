# M4: prova remota e restauração isolada

Estado em 28/10/2026: homologação remota avançada, **corte ainda pendente**.
Foram publicados Workers e aplicadas migrações exclusivamente no ambiente
isolado de teste. Produção não recebeu publicação, migração ou alteração de
pedidos/campanhas.

## Ambientes e proteção

| Serviço/recurso | Finalidade |
| --- | --- |
| `atos-teste.matheusuener-atos.workers.dev` | Coordenador/conta/faturamento Atos com KV isolado |
| `plantare-atos-teste.matheusuener-atos.workers.dev` | Plantare com D1 e R2 exclusivos |
| `atos-plantare-homolog-contas` | KV novo, sem contas ou sessões produtivas |
| `plantare-atos-teste` | D1 novo com migrações 0001 e 0002 |
| `plantare-atos-teste-projetos` | R2 exclusivo de teste |
| `plantare-atos-restauro` | D1 separado para restaurar o export produtivo |
| `plantare-atos-restauro-projetos` | R2 privado para restaurar a amostra produtiva |
| `plantare-atos-falha` | Upstream sintético 503, sem rota pública, só service binding |

Os bancos/buckets de restauração não estão ligados aos Workers públicos.
Export, dados pessoais, sessões, tokens e chaves de objetos ficaram em arquivos
privados fora do Git; os relatórios contêm apenas contagens, IDs de fixtures
e resultados. Os validadores de configuração verificam nomes, ausência de
rotas produtivas e separação dos recursos; segredos não podem estar em `vars`.

Plantare → Atos usa `ATOS_COBRANCA`; Atos → Plantare usa
`PLANTARE_EVENTOS_TESTE`. Os service bindings foram validados remotamente.
O canal S2S e o HMAC de eventos usam segredos distintos dos avisos OIDC e do
token do controlador. Nenhum segredo existente do Mercado Pago foi exportado.

## Resultados observados

- API real de teste do Mercado Pago: vendedor de teste confirmado antes da
  compra; Pix de R$ 188,40 aprovado com APRO; repetição de intenção manteve
  uma compra/fatura. Não houve transferência real de dinheiro.
- Evento assinado da Atos efetivamente recebido pelo inbox D1 remoto.
- 41 arquivos produzidos. O teste exige formatos pagos e valida KML, assinatura
  ZIP de KMZ e features GeoJSON, além de CSV. A fixture anterior sem seleção
  de formatos foi corrigida; presença da licença não é prova de exportação paga.
- Devolução integral e parcial aceitas pelo gateway, com acesso bloqueado.
  Eventos antigos repetidos após revogação não restauraram o direito.
- Cortesia confirmou sem Pix; CSV liberado apenas no escopo concedido.
  Outra conta, talhão ou camada não autorizada não obtiveram arquivos.
- Duas contas disputaram o último cupom: uma reserva aceita e uma recusada.
  A compra vencedora confirmou depois de desligar novas intenções e foi
  reembolsada ao encerrar o ensaio.
- Indisponibilidade 503 foi injetada trocando apenas o service binding de
  teste para o Worker de falha. Download retornou 503 e não criou Pix legado.
  Restaurado o binding, o download de cortesia voltou e a intenção existente
  conservou ID/provedor; novas intenções seguiram bloqueadas pela flag.

Esse último cenário é uma falha sintética de upstream no ambiente remoto,
não uma afirmação de perda natural de pacote ou timeout do provedor. O teste
de timeout/rollback transacional permanece nas suítes automatizadas.

Sessões/perfis foram criados por fixtures autenticadas; login OIDC remoto
completo não foi exercitado. O estado do gateway foi confirmado por GET, não
se comprovou atualização exclusivamente por webhook originado no Mercado
Pago. A Sefin remota não foi exercitada nesta rodada. Não houve teste de campo
em equipamento.

## Backup e restauração reais

Foi exportado o D1 produtivo por operação de leitura e importado no banco
`plantare-atos-restauro`. A comparação privada conferiu **todas as colunas e
linhas** das sete tabelas abaixo, sem imprimir seus dados:

| Tabela | Linhas idênticas |
| --- | ---: |
| contas | 1 |
| compras | 1 |
| cupons | 3 |
| cupom_usos | 0 |
| perfis | 1 |
| sessoes | 1 |
| talhoes | 1 |

O único projeto encontrado no inventário de talhões foi baixado do R2
produtivo e restaurado com a mesma chave em outro bucket privado. A releitura
conferiu os 328.163 bytes com SHA-256 idêntico. A produção não foi usada como
destino da restauração. `PRAGMA integrity_check` não foi aceito pela API D1;
a evidência remota é importação concluída e comparação exata, não execução
desse pragma no serviço.

O SQL de inventário e o export são retratos. É necessário capturar e aplicar
o delta no corte; a restauração comprovada não congela alterações futuras.

## Repetição do ensaio

O controlador está em entry point separado e é bloqueado sem ambiente de
teste, flag e token. A preparação só cria contas sintéticas `hmg-UUID`.
Não oferece SQL, URL arbitrária de gateway ou credencial fornecida pelo app.

1. Conferir `homologacao/validar-config.mjs` nas duas branches. Configurar
   `PLANTARE_HOMOLOG_ATIVO=1` apenas durante o ensaio e
   `ATOS_NOVAS_COMPRAS=1` apenas no Plantare de teste.
2. Usar os segredos já guardados no serviço; o arquivo privado do operador
   contém somente `atos`, `plantare` e `homolog`. Não colocá-lo no Git.
3. Executar `node homologacao/executar.mjs <arquivo-privado> <relatorio.json>`.
   O script verifica vendedor de teste e exercita intenção, pagamento, arquivos,
   evento, fatura, reembolso parcial/total, replay e cortesia. Não forja estados.
4. Para restauração: executar `homologacao/verificar-restauro.mjs` com o export,
   resultado privado das sete consultas SELECT e as duas cópias do objeto R2.
   A saída não contém as linhas nem os tokens.
5. Após ensaio, desligar novas intenções, restaurar o binding Atos e publicar
   `PLANTARE_HOMOLOG_ATIVO=0` em ambos os Workers. Confirmar 404 mesmo com o
   token correto; não apagar registros ou trocar o provedor de compras existentes.

Esse encerramento foi realizado. Novas intenções centrais estão desligadas e
os dois controladores retornaram 404. Produção respondeu HTTP 200 nos checks
de site Atos e saúde do Plantare.

## Próximo ponto de código e condições do corte

Preparar importação **idempotente** do histórico conferido por sub e das
campanhas/usos, sem novo pagamento ou nota; ensaiar congelamento, delta e
coorte. Comprovar webhook enviado pelo próprio Mercado Pago e login OIDC
no par isolado. Manter webhook/credenciais legados durante o dreno.

A autorização do dono de ativar produção quando pertinente continua válida;
as condições acima permanecem pendentes. M4 não deve ser encerrado apenas
porque os testes remotos de gateway e restauração passaram.
