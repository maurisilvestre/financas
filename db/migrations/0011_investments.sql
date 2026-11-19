-- Investimentos de cada item (CDBs, caixinhas...), como a Pluggy devolve em /investments: o
-- "guardado" da casa. A previsão parte dele para ver por quanto tempo cobre os meses negativos.
-- Dados da Pluggy: só o sync escreve; o que some da Pluggy ganha deleted_at.
CREATE TABLE fin.investments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pluggy_id      uuid NOT NULL UNIQUE,
  item_id        uuid NOT NULL REFERENCES fin.items(id),
  type           text,
  subtype        text,
  name           text,
  balance        numeric(14,2),
  currency_code  text,
  balance_date   date,                       -- data da posição do saldo
  status         text,                       -- ACTIVE, PENDING, TOTAL_WITHDRAWAL
  raw            jsonb NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE INDEX investments_item_idx ON fin.investments (item_id) WHERE deleted_at IS NULL;

-- O guardado, sem o raw (que pode ter número de conta e CPF). Dono: a conta corrente do mesmo item.
CREATE VIEW fin.v_investments AS
SELECT
  i.id,
  i.item_id,
  owner.name AS owner,
  i.type,
  i.subtype,
  i.name,
  i.balance,
  i.currency_code,
  i.balance_date,
  i.status,
  i.last_seen_at
FROM fin.investments i
LEFT JOIN LATERAL (
  SELECT coalesce(a.display_name, a.marketing_name, a.name) AS name
  FROM fin.accounts a
  WHERE a.item_id = i.item_id AND a.subtype = 'CHECKING_ACCOUNT'
  ORDER BY a.id LIMIT 1
) owner ON true
WHERE i.deleted_at IS NULL;
