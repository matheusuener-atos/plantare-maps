// Falha de upstream injetada somente via service binding do ensaio remoto.
export default {fetch(){return Response.json({erro:"indisponibilidade sintética de homologação"},{status:503})}};
