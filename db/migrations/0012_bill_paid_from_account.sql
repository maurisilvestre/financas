-- Fatura paga pela conta: em alguns bancos, o débito automático da fatura sai da conta corrente
-- dias antes de o pagamento aparecer no cartão. Agora a fatura
-- conta como paga também quando sai da conta corrente do mesmo banco o valor exato dela, perto do
-- vencimento. Sem isso, a fatura aparecia "atrasada" e o saldo (já sem o débito) a descontava de novo.
CREATE OR REPLACE VIEW fin.v_bill_status AS
SELECT
  b.id,
  b.account_id,
  coalesce(a.display_name, a.marketing_name, a.name) AS account,
  b.due_date,
  b.total_amount,
  greatest(coalesce(p.pago, 0), coalesce(d.pago, 0))::numeric(14,2) AS paid_amount,
  CASE WHEN coalesce(d.pago, 0) > coalesce(p.pago, 0) THEN d.pago_em ELSE p.pago_em END AS paid_at,
  payer.id AS payer_account_id
FROM fin.credit_card_bills b
JOIN fin.accounts a ON a.id = b.account_id
LEFT JOIN LATERAL (
  SELECT c.id FROM fin.accounts c
  WHERE c.item_id = a.item_id AND c.subtype = 'CHECKING_ACCOUNT'
  ORDER BY c.id LIMIT 1
) payer ON true
LEFT JOIN LATERAL (
  SELECT sum(t.signed_amount) AS pago, max(t.local_date) AS pago_em
  FROM fin.v_transactions t
  WHERE t.account_id = b.account_id AND t.flow = 'transfer' AND t.signed_amount > 0
    AND t.local_date BETWEEN b.due_date - 25 AND b.due_date + 5
) p ON true
LEFT JOIN LATERAL (
  SELECT -t.signed_amount AS pago, t.local_date AS pago_em
  FROM fin.v_transactions t
  WHERE t.account_id = payer.id AND t.signed_amount < 0
    AND abs(-t.signed_amount - b.total_amount) <= 0.01
    AND t.local_date BETWEEN b.due_date - 25 AND b.due_date + 5
  ORDER BY t.local_date DESC
  LIMIT 1
) d ON true;
