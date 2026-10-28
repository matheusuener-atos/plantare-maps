# Homologação e preparação do corte

Estado em 26/10/2026: M3 implementado na branch, com prova entre dois Workers
locais. Produção ainda usa o legado; não houve deploy nem migração remota.
A autorização do dono de ativar quando pertinente está registrada e não
depende de nova confirmação.

## Evidência já obtida

O roteiro local descrito em [ATOS-M3.md](ATOS-M3.md) comprovou snapshot,
evento assinado, projeção, arquivos, devolução, persistência após reinício e
rollback da flag sem troca de provedor. Backup SQLite local restaurado em
cópia isolada passou em `integrity_check`; isso não comprova restauração
do D1 remoto nem inclui R2 remoto.

Inventário remoto somente por SELECT, com `rows_written=0` e `changed_db=false`:

| Medida | Resultado observado |
| --- | --- |
| Compras pagas | 1, valor total R$ 0,00 |
| Compras pendentes/canceladas/expiradas | Nenhuma linha nesses estados |
| Compras visitantes | 0 |
| Contas | 1 |
| Campanhas ativas | 3, todas ilimitadas |
| Registros de uso de cupom | 0 |

É um retrato, não uma trava de escrita. Repetir o inventário e capturar delta
imediatamente antes do corte. Não inferir ausência futura de pagamentos tardios.
O SQL reproduzível está em `pix-worker/tools/inventario-cobranca.sql`.

Consulta de nomes dos segredos do Worker `atos-teste` confirmou
`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `NFSE_CHAVE_MESTRA` já configurados.
Não foram lidos seus valores. O par de segredos específico Plantare — S2S e
eventos de compra — ainda não está configurado nesse Worker. Não reutilizar
o segredo de PAVLVS nem os avisos de login.

## Próxima execução

1. Preparar Worker Plantare de teste com D1 e, para testar projetos, R2
   exclusivos. Publicar a branch Atos de teste e Plantare de teste, sem
   domínios/bancos/buckets de produção. Configurar par S2S, origem/checkout
   de teste e entrega `PLANTARE_EVENTOS_TESTE` ao receptor real do Plantare.
2. Usar comprador/vendedor de teste do Mercado Pago já configurados na Atos.
   Registrar pagamento, cortesia, devolução integral/parcial e tentativa tardia.
   Validar recuperação por painel e fatura/nota de teste; não tratar Sefin
   simulada como homologação fiscal externa.
3. Provar perda de resposta, evento repetido/fora de ordem, concorrência do
   último cupom e Atos indisponível antes de entregar. Repetir com conta errada,
   conta excluída, hash/camadas trocados e prazo vencido.
4. Fazer export/backup real antes do corte e restaurar em outro D1 isolado,
   com amostra dos objetos R2; conferir quantidades, vínculos e downloads.
   Registrar o último marco e aplicar o delta de alterações após a cópia.
5. Congelar novas reservas legadas durante o corte; definir a versão das
   campanhas centrais, importar histórico conferido por sub e estado de usos
   sem cobrar/emitir de novo. Mesmo as campanhas ilimitadas precisam ter
   regras/benefícios conferidos. Não manter dois reservadores de campanha limitada.
6. Habilitar primeiro uma coorte controlada após rever a trava de ambiente
   junto às evidências. Observar pagamentos, eventos, filas financeira/fiscal,
   downloads e revisões. O código desta branch ainda bloqueia novas centrais
   fora de teste; não retirar essa trava isoladamente.

## Reversão e dreno

Desligar apenas novas intenções centrais; conservar provedor, receptor, segredos,
snapshots e consulta para as anteriores. Não emitir outro Pix por timeout.
Não remover `/webhook` nem token/segredo legados enquanto houver orders antigas
ou possibilidade de retorno/devolução; documentar o dreno por ID e estado.
Uma ausência de pendentes neste inventário não autoriza removê-los.

O corte será pertinente quando essas provas remotas, importação/delta e
restauração estiverem concluídas. A implementação local e o CI aprovados
são parte da evidência, não substituem essas condições.

## Atualização de 28/10/2026

[Prova remota e restauração](ATOS-M4-REMOTO.md) executadas: gateway real de teste,
eventos entre Workers, arquivos pagos, devoluções, replay, cortesia, concorrência
e rollback. D1 e amostra R2 produtivos restaurados em recursos isolados e conferidos.
Houve publicação e migração apenas em teste; produção permanece sem corte.
M4 segue aberto para importação de histórico/campanhas, delta/coorte, webhook do
gateway e login remoto completo. Controladores temporários encerrados.
