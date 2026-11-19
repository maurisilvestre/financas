-- Ajustes depois do primeiro sync com dados reais do Meu Pluggy.

SET timezone TO 'America/Sao_Paulo';

-- 1. Âncora de religação sem providerId.
--    O Meu Pluggy manda providerId e providerCode nulos em 100% das transações. Sobrava só
--    "data + valor + descrição", que não religa quando a Pluggy recria a transação mudando a
--    descrição ou o valor. O instante exato (com milissegundos) identifica a transação:
--    no cartão vem de creditCardMetadata.transactionDateTime (instante da compra, igual em
--    todas as parcelas; por isso a religação também compara o número da parcela), na conta
--    vem de date. Data sem hora (meia-noite em Brasília ou UTC) → NULL.
--    Mesma regra de preciseInstant() em sync/src/normalize.ts; aqui só preenche o que já existe.
ALTER TABLE fin.transactions ADD COLUMN precise_at timestamptz;
COMMENT ON COLUMN fin.transactions.precise_at IS
  'Instante exato da transação (cartão: transactionDateTime; conta: date). NULL quando o banco só informa o dia.';

UPDATE fin.transactions t
SET precise_at = x.ts
FROM (
  SELECT id, coalesce(raw->'creditCardMetadata'->>'transactionDateTime', raw->>'date')::timestamptz AS ts
  FROM fin.transactions
) x
WHERE x.id = t.id
  AND (x.ts AT TIME ZONE 'America/Sao_Paulo')::time <> '00:00'
  AND (x.ts AT TIME ZONE 'UTC')::time <> '00:00';

CREATE INDEX transactions_precise_idx ON fin.transactions (account_id, precise_at) WHERE precise_at IS NOT NULL;

-- 2. Débito automático da fatura na conta corrente ("GASTOS CARTAO DE CREDITO - DOCTO: ...").
--    Sem esta regra, o pagamento da fatura do cartão contava como gasto, em dobro com as compras.
INSERT INTO fin.category_rules (category_id, match_type, pattern, priority)
SELECT id, 'contains', 'gastos cartao de credito', 20 FROM fin.categories WHERE name = 'Pagamento de fatura';

-- 3. Plano de parcelas: não projeta parcelamento parado.
--    Se a próxima parcela já devia ter vindo num mês que passou (antecipação, estorno,
--    cancelamento), o resto não é projetado. Antes, a view projetava parcelas em meses passados.
CREATE OR REPLACE VIEW fin.v_installment_plan AS
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
WHERE g.max_seen IS NOT NULL
  AND date_trunc('month', g.last_seen_date) + interval '1 month' >= date_trunc('month', current_date);

-- 4. Categorias e notas suas cujas transações sumiram da Pluggy.
--    Sem providerId a religação depende de atributos; quando nem eles batem, a transação
--    antiga ganha deleted_at e o seu override sai dos relatórios junto com ela. O sync avisa;
--    esta view mostra o que reaplicar na transação nova.
CREATE VIEW fin.v_lost_overrides AS
SELECT
  o.transaction_id,
  coalesce(a.display_name, a.marketing_name, a.name) AS account,
  t.local_date,
  coalesce(o.custom_description, t.description)      AS description,
  t.signed_amount,
  c.name                                             AS category,
  o.note,
  o.ignored,
  t.deleted_at
FROM fin.transaction_overrides o
JOIN fin.transactions t ON t.id = o.transaction_id
JOIN fin.accounts a ON a.id = t.account_id
LEFT JOIN fin.categories c ON c.id = o.category_id
WHERE t.deleted_at IS NOT NULL;
