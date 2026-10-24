# Cobrança do Plantare pela Atos — plano de adaptação

Estado em 24/10/2026: **proposta**, sem alteração de pagamento, credenciais,
rotas ou banco em produção. Acompanhamento: [issue #2](https://github.com/matheusuener-atos/plantare-maps/issues/2).

O contrato entre os serviços ficará em `docs/PLANTARE-COBRANCA.md` no
repositório `matheusuener-atos/atos.dev.br`, na entrega coordenada deste
plano. Esse documento é a referência para payloads, eventos e autoridade
monetária; esta página detalha a adaptação local.

## Comportamento atual a preservar

| Área | Implementação atual |
| --- | --- |
| Preço | `pix-worker/src/preco.js` e bloco `preco` no HTML: preço por área/camadas, mínimo, faixas e cupons |
| Pedido | `criarCobranca` cria order Pix; `cortesia` cria `CORT-…` sem gateway |
| Identidade | Conta Atos ligada por `contas.atos_sub`; sessão local; compra visitante por chave com hash |
| Compra | `compras.id` é order/cortesia; talhão em `area_hash`, camadas, valor, estado e datas |
| Consulta | `/status/:id` consulta o legado; `/eu` lista compras pagas da conta |
| Entrega | `/pacote` exige dono ou chave, pagamento, mesmo talhão e camadas liberadas |
| Prazo | `REBAIXAR_DIAS=365`; `0` significa sem limite, segundo a configuração atual |
| Dados | D1 para estado e R2 para projetos; nenhuma geometria precisa ir à Atos |

O hash atual depende da ordem dos pontos/anéis e arredonda a sete casas.
Não alterar essa identidade ao integrar cobrança; geometrias equivalentes
podem ter hashes diferentes. Não renumerar compras nem recalcular suas datas.

## Adaptação proposta

1. Manter o Worker como autoridade de geometria, área e seleção de camadas.
   Resolver o `sub` a partir da sessão/conta; não aceitar dono nem preço do app.
2. Persistir intenção com dono, hash, camadas e provedor de cobrança antes
   de pedir checkout à Atos. Repetir intenção após timeout deve recuperar a
   compra anterior. Nenhum fallback automático para um segundo Pix legado.
3. Exibir orçamento final retornado pela Atos e levar ao checkout hospedado.
   V1 exige Conta Atos para novas compras centrais; os visitantes antigos
   continuam usando a chave original. Não vincular pedido por e-mail coincidente.
4. Criar tabelas aditivas de intenções, compras centrais e inbox, separadas de
   `compras`. A referência central nunca é usada como se fosse ID de order MP.
5. Receber o evento novo proposto `compra.atualizada` em endpoint próprio,
   separado de `/atos/avisos` (revogação OIDC). Verificar assinatura sobre o
   corpo bruto, dono, produto, schema, versão e ID antes de persistir.
6. Gravar inbox e snapshot na mesma transação D1. Duplicata/versão antiga
   válida não reaplica; versão maior atualiza; mesmo número com conteúdo
   diferente é erro de integridade. Não responder sucesso sem persistir.
7. Na entrega central, consultar o estado atual na Atos antes de gerar o
   pacote. Falha da Atos gera indisponibilidade temporária, não nova cobrança.
   Conferir `baixar_ate` absoluto, estado, dono, hash e camadas; devolução
   revoga o direito. Não inferir pagamento do redirecionamento do navegador.
8. Adaptar `/eu` para combinar as duas fontes sem limite silencioso ou
   duplicação e mostrar qual pedido cada compra representa. Manter contratos
   de `/status`, `/pacote` e os domínios antigos para visitantes/app legado.

As novas rotas, flags e tabelas ainda precisam ser implementadas. A Atos
atual resolve ofertas fixas e um retrato de direito por produto; sua consulta
de direitos não é a lista autoritativa de compras de talhões.

## Cupons, migração e reversão

- O orçamento monetário e os cupons novos passam à Atos, com tarifa
  versionada e limites globais concorrentes. O Plantare não recebe um valor
  calculado pelo navegador como autoridade.
- Migrar regras, consumo e reservas ativas, não só o código dos cupons.
  Congelar novas reservas no corte e aplicar o delta de pagamentos tardios.
  Nunca deixar os dois serviços reservar livremente a mesma campanha.
- Preservar compras pagas, chaves de visitantes, usos e prazos existentes.
  Não emitir nova cobrança ou nota ao importar o histórico.
- A flag futura escolhe só o provedor de novas intenções. Cada intenção
  mantém seu provedor mesmo se a flag mudar.
- Reversão interrompe novas intenções centrais, mas mantém reconciliação,
  recebimento de eventos e entrega das já criadas. Voltar ao legado exige
  verificar exclusividade de cupons e ausência de intenção central conflitante.
- Não retirar `/webhook` nem credenciais legadas antes de reconciliar
  pendências e confirmar o dreno de pós-pagamento/devolução. Não remover as
  tabelas centrais num rollback de código.

## Verificações que liberam a implementação

| Cenário | Resultado exigido |
| --- | --- |
| Sessão de outra conta, hash ou camadas alterados | Sem acesso ao orçamento/compra/download |
| Duas chamadas e timeout após gateway aceitar | Uma compra e um Pix para a intenção |
| Cupom com último uso disputado por duas contas | Uma reserva aceita; recuperação não cria consumo extra |
| Mesmo evento duas vezes, versões invertidas | Uma aplicação; versão velha não ressuscita direito |
| Pagamento seguido de devolução, inclusive fora de ordem | Estado reconciliado sem download após revogação |
| Atos indisponível antes da entrega | Mensagem temporária, sem perda do pedido nem novo Pix |
| Compra antiga com conta ou chave visitante | Consulta e arquivos preservados segundo a regra legada |
| Restore/rollback com compras centrais em andamento | Sem perda de eventos, mudança de provedor ou dupla cobrança |

Começar por contrato executável e preço na Atos, depois checkout e eventos,
projeção/compatibilidade no Plantare, e só então homologação entre dois
Workers de teste e corte por coorte. Não usar produção para provar o contrato.

As suítes existentes em `pix-worker/test/testes.mjs` cobrem o legado. O
[PR #4](https://github.com/matheusuener-atos/plantare-maps/pull/4) acrescenta CI
e paridade de preço/núcleo e deve ser integrado antes das mudanças funcionais.
A homologação da cobrança não substitui a validação dos arquivos em equipamento.
