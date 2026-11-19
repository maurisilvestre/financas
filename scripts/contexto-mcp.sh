#!/usr/bin/env bash
# Contexto da casa para o MCP: um texto seu (quem usa cada conta, qual cartão é o do dia a dia,
# regras combinadas) que vai no fim das instruções do servidor MCP, para o Claude entender as suas
# contas. Fica no seu banco (fin.user_settings, chave "contexto_mcp"), nunca no código nem no git.
# Até 4.000 caracteres.
#
# Uso:  ./scripts/contexto-mcp.sh              mostra o contexto atual
#       ./scripts/contexto-mcp.sh arquivo.md   grava o conteúdo do arquivo
#       ./scripts/contexto-mcp.sh --apagar     tira o contexto
#
# O MCP lê o contexto quando abre: comece uma conversa nova no Claude depois de mudar.
# O banco precisa estar no ar (docker compose up -d).
set -euo pipefail
cd "$(dirname "$0")/.."

LIMITE=4000
psql_app() { docker compose exec -T db psql -U fin_app -d financas -v ON_ERROR_STOP=1 -X -At "$@"; }

case "${1:-}" in
  '')
    atual=$(psql_app -c "SELECT value #>> '{}' FROM fin.user_settings WHERE key = 'contexto_mcp'")
    if [ -n "$atual" ]; then printf '%s\n' "$atual"; else echo "(sem contexto)"; fi
    ;;
  --apagar)
    psql_app -c "DELETE FROM fin.user_settings WHERE key = 'contexto_mcp'" >/dev/null
    echo "Contexto apagado."
    ;;
  -*)
    echo "Uso: ./scripts/contexto-mcp.sh [arquivo.md | --apagar]" >&2
    exit 1
    ;;
  *)
    [ -f "$1" ] || { echo "Arquivo não encontrado: $1" >&2; exit 1; }
    texto=$(cat "$1")
    n=$(printf '%s' "$texto" | wc -m | tr -d ' ')
    [ "$n" -le "$LIMITE" ] || { echo "O texto tem $n caracteres; o limite é $LIMITE." >&2; exit 1; }
    # O texto vai numa variável do psql (:'texto' cuida das aspas), não colado no SQL.
    psql_app -v texto="$texto" >/dev/null <<'SQL'
INSERT INTO fin.user_settings (key, value) VALUES ('contexto_mcp', to_jsonb(:'texto'::text))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
SQL
    echo "Contexto gravado ($n caracteres). Comece uma conversa nova no Claude para ele valer."
    ;;
esac
