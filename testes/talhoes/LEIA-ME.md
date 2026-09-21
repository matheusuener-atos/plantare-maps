# Talhões de teste

Cada arquivo aqui é um talhão de verdade que o teste de regras (`npm test`) gera e confere.

Para acrescentar um caso que deu problema no campo:

1. Salve o projeto no app (Salvar projeto) ou guarde o `.kml` do talhão.
2. Copie o arquivo para esta pasta, com um nome que diga o que ele tem de especial
   (por exemplo `obstaculo-grande-no-meio.kml`, `divisa-em-curva.kml`).
3. Rode `npm test`. A partir daí, qualquer mudança no gerador que quebre esse talhão aparece na hora.
