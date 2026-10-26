-- Somente leitura. Não lista e-mails, subs, chaves de visitantes ou códigos de cupom.
SELECT status, count(*) AS quantidade,
  sum(CASE WHEN conta_id IS NULL THEN 1 ELSE 0 END) AS visitantes,
  sum(valor) AS valor_total
FROM compras GROUP BY status;
SELECT count(*) AS contas FROM contas;
SELECT count(*) AS campanhas_ativas,
  sum(CASE WHEN ilimitado=0 THEN 1 ELSE 0 END) AS limitadas
FROM cupons WHERE ativo=1;
SELECT pago,count(*) AS usos FROM cupom_usos GROUP BY pago;
