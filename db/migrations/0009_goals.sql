-- Objetivos (reserva de emergência, quitar uma dívida, uma viagem...): quanto
-- guardar por mês para cada um. Na previsão, o aporte sai da sobra como um compromisso, até o
-- objetivo completar; assim uma compra só "cabe" se não atrapalhar o que já foi combinado.
-- Camada do usuário, como os gastos planejados: o sync nunca escreve aqui.
CREATE TABLE fin.goals (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  reason          text CHECK (length(reason) <= 500),             -- o porquê
  target_amount   numeric(14,2) NOT NULL CHECK (target_amount > 0),
  saved_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),  -- já guardado (o usuário atualiza)
  monthly_amount  numeric(14,2) NOT NULL CHECK (monthly_amount > 0),
  start_month     date NOT NULL CHECK (start_month = date_trunc('month', start_month)::date),
  status          text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'concluido', 'cancelado')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Escrita pelo MCP e pelo app (papel fin_mcp): criar e ajustar valores, aporte, início e status.
-- O nome e o porquê ficam como foram criados; nada de DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') THEN
    GRANT SELECT, INSERT ON fin.goals TO fin_mcp;
    GRANT UPDATE (target_amount, saved_amount, monthly_amount, start_month, status, updated_at) ON fin.goals TO fin_mcp;
  END IF;
END $$;
