#!/bin/sh
# Cria (ou atualiza) o papel fin_mcp, usado pelas duas ferramentas de escrita do MCP
# (definir categoria, criar regra). Ele só escreve em transaction_overrides e category_rules.
#
# Roda sozinho no primeiro start do volume. Num banco que já existe, rode uma vez
# (depois de colocar MCP_DB_PASSWORD no .env e recriar o container do db):
#   docker compose up -d db
#   docker compose exec db sh /docker-entrypoint-initdb.d/02-mcp-role.sh
# É idempotente: rodar de novo só atualiza a senha e as permissões.
set -eu

if [ -z "${MCP_DB_PASSWORD:-}" ]; then
  echo "MCP_DB_PASSWORD vazio: papel fin_mcp não criado (as ferramentas de escrita do MCP não vão funcionar)." >&2
  exit 0
fi

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-financas}" \
  -v dbname="${POSTGRES_DB:-financas}" \
  -v mcp_pw="$MCP_DB_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE fin_mcp LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') \gexec
ALTER ROLE fin_mcp LOGIN PASSWORD :'mcp_pw';
GRANT CONNECT ON DATABASE :"dbname" TO fin_mcp;
ALTER ROLE fin_mcp SET search_path = fin, public;

-- Permissões nas tabelas (as mesmas da migration 0005). No primeiro start as tabelas
-- ainda não existem; aí quem aplica é a migration.
DO $$
BEGIN
  IF to_regclass('fin.transaction_overrides') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA fin TO fin_mcp;
    GRANT SELECT, INSERT, UPDATE ON fin.transaction_overrides TO fin_mcp;
    GRANT SELECT, INSERT ON fin.category_rules TO fin_mcp;
  END IF;
  -- Sugestões da IA (migration 0006): só marca como aplicada ou recusada.
  IF to_regclass('fin.category_suggestions') IS NOT NULL THEN
    GRANT SELECT ON fin.category_suggestions TO fin_mcp;
    GRANT UPDATE (status, decided_at) ON fin.category_suggestions TO fin_mcp;
  END IF;
  -- Configurações do usuário (migration 0007): meta do cartão à vista.
  IF to_regclass('fin.user_settings') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON fin.user_settings TO fin_mcp;
  END IF;
  -- Previsão (migration 0008): gastos planejados e exclusões da média; sem DELETE.
  IF to_regclass('fin.planned_expenses') IS NOT NULL THEN
    GRANT SELECT, INSERT ON fin.planned_expenses, fin.forecast_exclusions TO fin_mcp;
    GRANT UPDATE (status, updated_at) ON fin.planned_expenses TO fin_mcp;
    GRANT UPDATE (active) ON fin.forecast_exclusions TO fin_mcp;
  END IF;
  -- Objetivos (migration 0009): criar e ajustar valores, aporte, início e status; sem DELETE.
  IF to_regclass('fin.goals') IS NOT NULL THEN
    GRANT SELECT, INSERT ON fin.goals TO fin_mcp;
    GRANT UPDATE (target_amount, saved_amount, monthly_amount, start_month, status, updated_at) ON fin.goals TO fin_mcp;
  END IF;
END $$;
SQL
echo "Papel fin_mcp pronto."
