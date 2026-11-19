-- Configurações do usuário (por enquanto, a meta mensal do cartão à vista) e a lista de
-- compras parceladas, para o alerta de parcelamentos novos no app.

-- Camada do usuário, como categorias, regras e overrides: o sync nunca escreve aqui.
CREATE TABLE fin.user_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Uma linha por compra parcelada (grupo de parcelas com alguma parcela viva).
-- Data da compra: a informada pelo banco ou, sem ela, o mês estimado da 1ª parcela.
CREATE VIEW fin.v_installment_purchases AS
SELECT
  g.id                                                     AS group_id,
  g.account_id,
  coalesce(a.display_name, a.marketing_name, a.name)       AS account,
  g.description,
  g.total_installments,
  g.installment_amount,
  (g.installment_amount * g.total_installments)::numeric(14,2) AS total_amount,
  coalesce(g.purchase_date, g.anchor_month)                AS purchase_date,
  g.purchase_date IS NOT NULL                              AS purchase_date_known
FROM fin.installment_groups g
JOIN fin.accounts a ON a.id = g.account_id
WHERE EXISTS (
  SELECT 1 FROM fin.transactions t
  LEFT JOIN fin.transaction_overrides o ON o.transaction_id = t.id
  WHERE t.installment_group_id = g.id AND t.deleted_at IS NULL AND NOT coalesce(o.ignored, false)
);

-- O app e o MCP (fin_mcp) leem e gravam as configurações.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') THEN
    GRANT SELECT, INSERT, UPDATE ON fin.user_settings TO fin_mcp;
  END IF;
END $$;
