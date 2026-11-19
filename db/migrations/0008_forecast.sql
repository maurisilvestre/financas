-- Previsão ("guardião do compra ou não compra"): gastos planejados e o que fica fora da média.
-- Camada do usuário, como categorias, regras e overrides: o sync nunca escreve aqui.

-- Compras aprovadas (e gastos sazonais conhecidos, como IPVA) que ainda não aconteceram.
-- Entram na previsão até virarem 'realizado' (a transação de verdade chegou) ou 'cancelado'.
CREATE TABLE fin.planned_expenses (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  reason        text CHECK (length(reason) <= 500),             -- o porquê
  total_amount  numeric(14,2) NOT NULL CHECK (total_amount > 0),
  installments  int NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 48),
  first_month   date NOT NULL CHECK (first_month = date_trunc('month', first_month)::date),
  status        text NOT NULL DEFAULT 'planejado' CHECK (status IN ('planejado', 'realizado', 'cancelado')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- O que não entra nas médias da previsão: uma categoria inteira (ex.: um curso que acabou) ou as
-- transações cuja descrição contém um trecho (ex.: uma assinatura cancelada). Só "contém", sem regex.
CREATE TABLE fin.forecast_exclusions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pattern      text CHECK (length(pattern) BETWEEN 3 AND 80),
  category_id  bigint REFERENCES fin.categories(id) ON DELETE CASCADE,
  reason       text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((pattern IS NULL) <> (category_id IS NULL))
);

-- Escrita pelo MCP e pelo app (papel fin_mcp): inserir e mudar status; nada de DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') THEN
    GRANT SELECT, INSERT ON fin.planned_expenses, fin.forecast_exclusions TO fin_mcp;
    GRANT UPDATE (status, updated_at) ON fin.planned_expenses TO fin_mcp;
    GRANT UPDATE (active) ON fin.forecast_exclusions TO fin_mcp;
  END IF;
END $$;
