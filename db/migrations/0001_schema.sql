-- Schema base. Princípios:
--  * Nada é apagado: transações que somem da Pluggy ganham deleted_at (soft delete).
--  * Dados vindos da Pluggy (items, accounts, transactions, bills) ficam separados
--    da camada do usuário (categorias, regras, overrides), para que um re-sync
--    nunca sobrescreva uma edição sua.
--  * O payload bruto de cada registro fica em raw jsonb, para reprocessar quando
--    as heurísticas evoluírem.
--  * Valores em numeric(14,2), nunca float.

CREATE SCHEMA IF NOT EXISTS fin;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA fin;

-- Texto normalizado para comparações (minúsculas, sem acento, espaços colapsados).
CREATE FUNCTION fin.norm_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT trim(regexp_replace(lower(fin.unaccent('fin.unaccent'::regdictionary, t)), '\s+', ' ', 'g')) $$;

-- ---------------------------------------------------------------------------
-- Dados da Pluggy
-- ---------------------------------------------------------------------------

-- Uma conexão (item). No Meu Pluggy há um item por banco conectado.
CREATE TABLE fin.items (
  id                  uuid PRIMARY KEY,            -- id do item na Pluggy
  connector_name      text,
  status              text,                        -- UPDATED, UPDATING, LOGIN_ERROR, OUTDATED...
  execution_status    text,
  last_updated_at     timestamptz,                 -- última vez que a Pluggy atualizou com o banco
  consent_expires_at  timestamptz,
  raw                 jsonb NOT NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz NOT NULL DEFAULT now()
);

-- Contas e cartões. O id interno é estável; o pluggy_id muda se você reconectar o
-- banco (novo item), e a conta é religada pelo fingerprint.
CREATE TABLE fin.accounts (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pluggy_id               uuid NOT NULL UNIQUE,
  previous_pluggy_ids     uuid[] NOT NULL DEFAULT '{}',
  item_id                 uuid NOT NULL REFERENCES fin.items(id),
  fingerprint             text NOT NULL UNIQUE,    -- subtype|número normalizado|nome normalizado
  type                    text NOT NULL,           -- BANK | CREDIT
  subtype                 text NOT NULL,           -- CHECKING_ACCOUNT | SAVINGS_ACCOUNT | CREDIT_CARD
  name                    text NOT NULL,
  marketing_name          text,
  number                  text,
  display_name            text,                    -- nome que você escolher (ex.: "Cartão do dia a dia")
  is_hidden               boolean NOT NULL DEFAULT false,
  currency_code           text NOT NULL DEFAULT 'BRL',
  balance                 numeric(14,2),           -- BANK: saldo disponível | CREDIT: fatura aberta
  credit_limit            numeric(14,2),
  available_credit_limit  numeric(14,2),
  balance_close_date      date,
  balance_due_date        date,
  raw                     jsonb NOT NULL,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_synced_at          timestamptz NOT NULL DEFAULT now()
);

-- Histórico de saldo: uma foto por conta por dia (a última do dia vence).
CREATE TABLE fin.account_balance_snapshots (
  account_id              bigint NOT NULL REFERENCES fin.accounts(id),
  captured_on             date NOT NULL,
  balance                 numeric(14,2),
  credit_limit            numeric(14,2),
  available_credit_limit  numeric(14,2),
  captured_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, captured_on)
);

-- Compras parceladas: agrupa as parcelas de uma mesma compra (o Open Finance
-- não devolve um id de agrupamento, então o sync usa heurística).
CREATE TABLE fin.installment_groups (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id           bigint NOT NULL REFERENCES fin.accounts(id),
  group_key            text NOT NULL,               -- chave única do grupo
  match_key            text NOT NULL,               -- descrição normalizada (sem "2/6") | nº de parcelas
  description          text NOT NULL,
  total_installments   int  NOT NULL CHECK (total_installments > 1),
  installment_amount   numeric(14,2) NOT NULL,      -- valor (positivo) de uma parcela
  anchor_month         date NOT NULL,               -- mês estimado da 1ª parcela
  purchase_date        date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, group_key)
);

CREATE INDEX installment_groups_match_idx ON fin.installment_groups (account_id, match_key);

CREATE TABLE fin.transactions (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pluggy_id                   uuid NOT NULL UNIQUE,
  previous_pluggy_ids         uuid[] NOT NULL DEFAULT '{}',
  account_id                  bigint NOT NULL REFERENCES fin.accounts(id),
  provider_id                 text,                 -- id do banco (Open Finance); âncora para religar
  provider_code               text,
  occurred_at                 timestamptz NOT NULL, -- campo date da Pluggy (UTC)
  local_date                  date NOT NULL,        -- data no fuso de Brasília (ver normalize.ts)
  description                 text NOT NULL,
  description_raw             text,
  amount                      numeric(14,2) NOT NULL, -- como a Pluggy devolve
  signed_amount               numeric(14,2) NOT NULL, -- entrada +, saída − (derivado de type)
  currency_code               text NOT NULL,
  amount_in_account_currency  numeric(14,2),
  type                        text NOT NULL CHECK (type IN ('DEBIT', 'CREDIT')),
  status                      text NOT NULL CHECK (status IN ('PENDING', 'POSTED')),
  operation_type              text,
  pluggy_category             text,
  installment_number          int,
  total_installments          int,
  purchase_date               date,
  bill_pluggy_id              uuid,
  card_number                 text,
  installment_group_id        bigint REFERENCES fin.installment_groups(id),
  raw                         jsonb NOT NULL,
  first_seen_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz           -- sumiu da Pluggy; pode voltar
);

CREATE INDEX transactions_account_date_idx ON fin.transactions (account_id, local_date);
CREATE INDEX transactions_provider_idx ON fin.transactions (account_id, provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX transactions_live_date_idx ON fin.transactions (local_date) WHERE deleted_at IS NULL;
CREATE INDEX transactions_group_idx ON fin.transactions (installment_group_id) WHERE installment_group_id IS NOT NULL;

-- Faturas de cartão (só conexões Open Finance reguladas, que é o caso do Meu Pluggy).
CREATE TABLE fin.credit_card_bills (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pluggy_id               uuid NOT NULL UNIQUE,
  account_id              bigint NOT NULL REFERENCES fin.accounts(id),
  due_date                date NOT NULL,
  total_amount            numeric(14,2) NOT NULL,
  minimum_payment_amount  numeric(14,2),
  allows_installments     boolean,
  finance_charges_total   numeric(14,2),
  payments_total          numeric(14,2),
  raw                     jsonb NOT NULL,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_card_bills_account_due_idx ON fin.credit_card_bills (account_id, due_date);

-- Log de cada execução do sync.
CREATE TABLE fin.sync_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger      text NOT NULL,                         -- manual | schedule | startup
  status       text NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'success', 'partial', 'error')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  stats        jsonb NOT NULL DEFAULT '{}',
  error        text
);

-- ---------------------------------------------------------------------------
-- Sua camada (nunca é tocada pelo sync)
-- ---------------------------------------------------------------------------

CREATE TABLE fin.categories (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  color       text,
  sort_order  int NOT NULL DEFAULT 100
);

-- Regras de categorização. A de menor prioridade que casar vence.
-- Editar uma regra recategoriza o histórico inteiro (a categoria é calculada na view).
CREATE TABLE fin.category_rules (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id  bigint NOT NULL REFERENCES fin.categories(id) ON DELETE CASCADE,
  match_type   text NOT NULL CHECK (match_type IN ('contains', 'regex', 'operation_type')),
  pattern      text NOT NULL,
  account_id   bigint REFERENCES fin.accounts(id) ON DELETE CASCADE, -- null = todas as contas
  priority     int NOT NULL DEFAULT 100,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Edições manuais por transação (chave = id interno, estável mesmo se o pluggy_id mudar).
CREATE TABLE fin.transaction_overrides (
  transaction_id      bigint PRIMARY KEY REFERENCES fin.transactions(id) ON DELETE CASCADE,
  category_id         bigint REFERENCES fin.categories(id) ON DELETE SET NULL,
  custom_description  text,
  note                text,
  ignored             boolean NOT NULL DEFAULT false,  -- fora dos relatórios
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Permissões do papel somente leitura (MCP)
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA fin TO fin_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA fin TO fin_readonly;
GRANT EXECUTE ON FUNCTION fin.norm_text(text) TO fin_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA fin GRANT SELECT ON TABLES TO fin_readonly;
