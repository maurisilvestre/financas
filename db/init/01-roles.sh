#!/bin/sh
# Roda uma única vez, quando o volume do Postgres está vazio (docker-entrypoint-initdb.d).
# Cria os dois papéis da aplicação e passa a posse do banco para fin_app.
#
#   fin_app      -> dono do schema; usado pelas migrations, pelo sync e (depois) pela API
#   fin_readonly -> só leitura; para o MCP e ferramentas de consulta
#
# Se trocar as senhas no .env depois do primeiro start, rode ALTER ROLE manualmente
# (ver README, seção "Trocar senhas").
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD não definido}"
: "${READONLY_DB_PASSWORD:?READONLY_DB_PASSWORD não definido}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v dbname="$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" \
  -v ro_pw="$READONLY_DB_PASSWORD" <<'SQL'
CREATE ROLE fin_app LOGIN PASSWORD :'app_pw';
CREATE ROLE fin_readonly LOGIN PASSWORD :'ro_pw';

-- fin_app vira dono do banco: pode criar o schema e extensões confiáveis (unaccent) via migrations.
ALTER DATABASE :"dbname" OWNER TO fin_app;

-- Ninguém além dos papéis da aplicação conecta.
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO fin_app, fin_readonly;

-- O papel de leitura não consegue escrever nem por engano.
ALTER ROLE fin_readonly SET default_transaction_read_only = on;

ALTER ROLE fin_app SET search_path = fin, public;
ALTER ROLE fin_readonly SET search_path = fin, public;
SQL
