# Histórico e campanhas: importação sem nova cobrança

Entrega de 28/10/2026: exportador privado e importador transacional preparados e
ensaiados localmente com o backup real. **Não houve migração remota ou deploy
nesta entrega.** O congelamento do legado, o delta capturado durante o corte e
a aplicação no coordenador remoto ainda precisam ser ensaiados.

## O que muda

`pix-worker/tools/legado.mjs` lê contas, compras, campanhas e usos de uma cópia
SQLite. Produz `plantare-legado/v1`: histórico por sub com IDs pagos e regras/usos
de campanha. Não inclui e-mails, sessões, CPF, geometria ou chaves de acesso.
Subs e IDs continuam sendo dados privados; manifesto e SQLite ficam fora do Git.

As compras legadas continuam no provedor original e não se tornam compras
centrais. O importador Atos alimenta somente histórico de primeira compra e
consumos de campanha; não cria Pix, fatura, nota, evento ou direito de download.
Contas sem compras entram explicitamente com histórico zero conferido.

Conversão de regras preserva percentuais em pontos-base, reais em centavos e
hectares em centésimos. Valores sem representação exata são recusados. Campanhas
inativas permanecem inativas no catálogo proposto; ilimitadas conservam a exceção
do legado. O catálogo é `Object.fromEntries(manifesto.campanhas.map(c =>
[c.codigo, c.config]))`, a conferir antes de configurar `PLANTARE_CUPONS` no corte.
A importação do estado **não publica esse catálogo** nem habilita compras.

## Proteções

- Repetição do mesmo manifesto retorna o marco existente sem incrementar usos.
- Cada delta contém o snapshot completo e o digest anterior: duas continuações
  concorrentes não substituem uma à outra. O digest identifica os bytes JSON
  gerados, não é assinatura nem autorização; manter o formato do exportador.
- IDs pagos e usos anteriores não podem sumir ou trocar de dono. Mudanças de
  regra/versão de campanha exigem revisão e outro procedimento.
- O histórico soma apenas o incremento legado e preserva compras centrais
  posteriores. Histórico já conferido sem marco ou perdido após um marco bloqueia.
- Reservas e consumos centrais permanecem; colisões de pessoa/talhão e capacidade
  de campanha insuficiente bloqueiam o delta inteiro.
- Validação, atualização e marco são transacionais. Falha de escrita reverte tudo.
- Compras pendentes, visitantes pagos sem vínculo por conta, divergência de e-mail
  histórico, e-mails duplicados e usos órfãos/inconsistentes bloqueiam o export.
  Não associar visitante por e-mail automaticamente.
- Manifestos acima de 100.000 bytes são recusados: o importador atual atende o
  inventário pequeno e não implementa migração paginada.

## Repetição privada

Usar Node 24 e o export SQL conferido na restauração isolada. Os caminhos abaixo
são exemplos privados fora dos repositórios; a saída deve ainda não existir.

```powershell
# Na raiz Plantare
node pix-worker/tools/exportar-legado.mjs C:\tmp\privado\backup.sql C:\tmp\privado\inicial.json
# Na raiz Atos; sem --aplicar, somente simula os registros de domínio
node homologacao/ensaiar-legado.mjs C:\tmp\privado\inicial.json C:\tmp\privado\ensaio.sqlite
node homologacao/ensaiar-legado.mjs C:\tmp\privado\inicial.json C:\tmp\privado\ensaio.sqlite --aplicar
# Repetir confirma idempotência. Para delta, exportar snapshot completo com o digest anterior:
node pix-worker/tools/exportar-legado.mjs C:\tmp\privado\backup-final.sql C:\tmp\privado\delta.json DIGEST_ANTERIOR
```

O comando Atos opera **somente SQLite local**, nunca o DO remoto. Usa a mesma
função transacional destinada ao ensaio, bloqueada fora de ambiente de teste e
sem flag específica. Ela não tem rota HTTP nem foi ligada ao Worker produtivo.
Sua simulação cria apenas a estrutura técnica local do SQLite, sem registros
de domínio. Arquivos privados não são eliminados automaticamente.

## Evidência e limites

O backup real anterior gerou uma conta, uma compra paga e três campanhas. O
manifesto passou por simulação, aplicação local, reinício/repetição e delta sem
alterações. A repetição não incrementou o histórico. É replay do retrato de backup,
**não captura de alterações produtivas depois dele**. Os testes sintéticos cobrem
acréscimo de pagamento tardio, compra central posterior, concorrência, falha de
escrita, conflito, restrições de cupom e bloqueio de produção.

Próximo ponto: aplicar o mecanismo em um coordenador remoto isolado, ensaiar
freeze/delta/coorte e capturar inventário final do gateway. A prova do webhook
originado no Mercado Pago e o login OIDC remoto completo seguem pendentes.
Manter credenciais/webhook legados durante o dreno; não apagar orders anteriores.
O ensaio remoto anterior está em [ATOS-M4-REMOTO.md](ATOS-M4-REMOTO.md).
