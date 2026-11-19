-- Views de leitura. São a interface para a API, o frontend e o MCP:
-- consulte as views, não as tabelas, e a lógica de categoria/fluxo fica num lugar só.

DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'America/Sao_Paulo');
END $$;
SET timezone TO 'America/Sao_Paulo';

-- Transação "efetiva": aplica seus overrides e a primeira regra que casar.
-- flow = expense | income | transfer. Sem categoria, o sinal decide.
CREATE VIEW fin.v_transactions AS
SELECT
  t.id,
  t.account_id,
  coalesce(a.display_name, a.marketing_name, a.name)       AS account,
  a.subtype                                                AS account_subtype,
  t.local_date,
  date_trunc('month', t.local_date)::date                  AS month,
  coalesce(o.custom_description, t.description)            AS description,
  t.description                                            AS bank_description,
  t.signed_amount,
  t.currency_code,
  t.status,
  t.operation_type,
  t.installment_number,
  t.total_installments,
  t.installment_group_id,
  cat.id                                                   AS category_id,
  cat.name                                                 AS category,
  CASE
    WHEN o.category_id IS NOT NULL THEN 'manual'
    WHEN r.category_id IS NOT NULL THEN 'rule'
  END                                                      AS category_source,
  coalesce(
    cat.kind,
    CASE WHEN t.signed_amount < 0 THEN 'expense' ELSE 'income' END
  )                                                        AS flow,
  coalesce(o.ignored, false)                               AS ignored,
  o.note,
  t.first_seen_at
FROM fin.transactions t
JOIN fin.accounts a ON a.id = t.account_id
LEFT JOIN fin.transaction_overrides o ON o.transaction_id = t.id
LEFT JOIN LATERAL (
  SELECT cr.category_id
  FROM fin.category_rules cr
  WHERE cr.enabled
    AND (cr.account_id IS NULL OR cr.account_id = t.account_id)
    AND CASE cr.match_type
          WHEN 'operation_type' THEN t.operation_type = cr.pattern
          WHEN 'contains' THEN position(fin.norm_text(cr.pattern) IN fin.norm_text(t.description)) > 0
          WHEN 'regex' THEN fin.norm_text(t.description) ~* cr.pattern
        END
  ORDER BY cr.priority, cr.id
  LIMIT 1
) r ON o.category_id IS NULL
LEFT JOIN fin.categories cat ON cat.id = coalesce(o.category_id, r.category_id)
WHERE t.deleted_at IS NULL;

-- Totais por mês e categoria. Gastos aparecem positivos (estornos abatem).
CREATE VIEW fin.v_monthly_by_category AS
SELECT
  month,
  flow,
  category_id,
  coalesce(category, 'Sem categoria') AS category,
  sum(CASE WHEN flow = 'expense' THEN -signed_amount ELSE signed_amount END) AS total,
  count(*) AS transactions
FROM fin.v_transactions
WHERE NOT ignored
GROUP BY month, flow, category_id, category;

-- Resumo mensal: gastos, receitas e saldo do mês.
CREATE VIEW fin.v_monthly_summary AS
SELECT
  month,
  coalesce(sum(-signed_amount) FILTER (WHERE flow = 'expense'), 0) AS expenses,
  coalesce(sum(signed_amount)  FILTER (WHERE flow = 'income'), 0)  AS income,
  coalesce(sum(signed_amount)  FILTER (WHERE flow = 'income'), 0)
    - coalesce(sum(-signed_amount) FILTER (WHERE flow = 'expense'), 0) AS net,
  count(*) FILTER (WHERE category_id IS NULL AND flow <> 'transfer') AS uncategorized
FROM fin.v_transactions
WHERE NOT ignored
GROUP BY month;

-- Plano de parcelas: uma linha por parcela, lançada (já veio do banco) ou projetada
-- (ainda não veio; estimada a partir da última parcela conhecida).
CREATE VIEW fin.v_installment_plan AS
WITH g AS (
  SELECT
    ig.*,
    last.installment_number AS max_seen,
    last.local_date         AS last_seen_date
  FROM fin.installment_groups ig
  LEFT JOIN LATERAL (
    SELECT t.installment_number, t.local_date
    FROM fin.transactions t
    WHERE t.installment_group_id = ig.id AND t.deleted_at IS NULL
    ORDER BY t.installment_number DESC, t.local_date DESC
    LIMIT 1
  ) last ON true
)
SELECT
  g.id                                    AS group_id,
  g.account_id,
  g.description,
  t.installment_number,
  g.total_installments,
  date_trunc('month', t.local_date)::date AS month,
  -t.signed_amount                        AS amount,
  'lancada'::text                         AS source,
  t.status,
  t.id                                    AS transaction_id
FROM g
JOIN fin.transactions t ON t.installment_group_id = g.id AND t.deleted_at IS NULL
LEFT JOIN fin.transaction_overrides o ON o.transaction_id = t.id
WHERE NOT coalesce(o.ignored, false)
UNION ALL
SELECT
  g.id,
  g.account_id,
  g.description,
  n,
  g.total_installments,
  (date_trunc('month', g.last_seen_date) + make_interval(months => n - g.max_seen))::date,
  g.installment_amount,
  'projetada',
  'PROJECTED',
  NULL
FROM g
CROSS JOIN LATERAL generate_series(g.max_seen + 1, g.total_installments) AS n
WHERE g.max_seen IS NOT NULL;

-- Quanto já está comprometido com parcelas, por cartão e mês (do mês atual em diante).
CREATE VIEW fin.v_future_commitments AS
SELECT
  p.account_id,
  coalesce(a.display_name, a.marketing_name, a.name) AS account,
  p.month,
  sum(p.amount) AS committed,
  count(*)      AS installments,
  count(*) FILTER (WHERE p.source = 'projetada') AS projected_installments
FROM fin.v_installment_plan p
JOIN fin.accounts a ON a.id = p.account_id
WHERE p.month >= date_trunc('month', current_date)::date
GROUP BY p.account_id, account, p.month;

-- Contas com a saúde da conexão (consentimento do Open Finance expira em 12 meses).
CREATE VIEW fin.v_accounts AS
SELECT
  a.id,
  coalesce(a.display_name, a.marketing_name, a.name) AS name,
  a.type,
  a.subtype,
  right(regexp_replace(coalesce(a.number, ''), '\D', '', 'g'), 4) AS number_last4,
  a.balance,
  a.credit_limit,
  a.available_credit_limit,
  a.balance_close_date,
  a.balance_due_date,
  a.is_hidden,
  a.item_id,
  i.status            AS item_status,
  i.execution_status  AS item_execution_status,
  i.last_updated_at   AS bank_data_updated_at,
  i.consent_expires_at,
  (i.consent_expires_at IS NOT NULL AND i.consent_expires_at < now() + interval '30 days') AS consent_expiring,
  a.last_synced_at
FROM fin.accounts a
JOIN fin.items i ON i.id = a.item_id;

CREATE VIEW fin.v_bills AS
SELECT
  b.id,
  b.account_id,
  coalesce(a.display_name, a.marketing_name, a.name) AS account,
  b.due_date,
  b.total_amount,
  b.minimum_payment_amount,
  b.finance_charges_total,
  b.payments_total
FROM fin.credit_card_bills b
JOIN fin.accounts a ON a.id = b.account_id;

CREATE VIEW fin.v_last_sync AS
SELECT DISTINCT ON (status) status, id, trigger, started_at, finished_at, stats, error
FROM fin.sync_runs
ORDER BY status, started_at DESC;
