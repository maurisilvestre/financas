-- "A pagar até o próximo salário": as contas fixas da casa e o estado das faturas dos cartões.
--
-- Contas fixas (luz, água, internet, condomínio...): o dia em que costumam sair e um trecho
-- da descrição ("contém", como as regras) que reconhece o pagamento em qualquer conta corrente.
-- Assim a conta continua reconhecida quando o pagamento muda de banco. Camada do usuário: o
-- sync nunca escreve aqui.
CREATE TABLE fin.recurring_bills (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  pattern          text NOT NULL CHECK (length(pattern) BETWEEN 3 AND 80),
  due_day          smallint NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  expected_amount  numeric(14,2) CHECK (expected_amount > 0),   -- vazio: o que saiu no vencimento anterior
  account_id       bigint REFERENCES fin.accounts(id),           -- de onde sai (para conferir o saldo da conta)
  paid_until       date,                                         -- "já paguei": vencimentos até aqui estão pagos
  status           text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'encerrada')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Faturas fechadas: quanto de pagamento já chegou no próprio cartão perto do vencimento e a conta
-- corrente do mesmo banco (mesmo item da Pluggy), de onde a fatura costuma sair.
CREATE VIEW fin.v_bill_status AS
SELECT
  b.id,
  b.account_id,
  coalesce(a.display_name, a.marketing_name, a.name) AS account,
  b.due_date,
  b.total_amount,
  coalesce(p.pago, 0)::numeric(14,2) AS paid_amount,
  p.pago_em AS paid_at,
  payer.id AS payer_account_id
FROM fin.credit_card_bills b
JOIN fin.accounts a ON a.id = b.account_id
LEFT JOIN LATERAL (
  SELECT sum(t.signed_amount) AS pago, max(t.local_date) AS pago_em
  FROM fin.v_transactions t
  WHERE t.account_id = b.account_id AND t.flow = 'transfer' AND t.signed_amount > 0
    AND t.local_date BETWEEN b.due_date - 25 AND b.due_date + 5
) p ON true
LEFT JOIN LATERAL (
  SELECT c.id FROM fin.accounts c
  WHERE c.item_id = a.item_id AND c.subtype = 'CHECKING_ACCOUNT'
  ORDER BY c.id LIMIT 1
) payer ON true;

-- Gastos dos cartões que ainda não estão numa fatura fechada: a fatura aberta e as parcelas futuras.
CREATE VIEW fin.v_unbilled_card AS
SELECT vt.id, vt.account_id, vt.account, vt.local_date, (-vt.signed_amount)::numeric(14,2) AS amount
FROM fin.v_transactions vt
JOIN fin.transactions t ON t.id = vt.id
WHERE vt.account_subtype = 'CREDIT_CARD' AND t.bill_pluggy_id IS NULL AND vt.flow = 'expense' AND NOT vt.ignored;

-- Escrita pelo app e pelo MCP (papel fin_mcp): criar, ajustar e encerrar. O nome fica como foi
-- criado; nada de DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') THEN
    GRANT SELECT, INSERT ON fin.recurring_bills TO fin_mcp;
    GRANT UPDATE (pattern, due_day, expected_amount, account_id, paid_until, status, updated_at) ON fin.recurring_bills TO fin_mcp;
  END IF;
END $$;
