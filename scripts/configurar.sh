#!/usr/bin/env bash
# Prepara o .env: cria a partir do .env.example, gera as senhas do banco (aleatórias, sem mostrar
# na tela) e, se rodar num terminal, pergunta as credenciais da Pluggy e os opcionais sem ecoar
# os segredos. Pode rodar de novo quantas vezes quiser: só preenche o que estiver vazio e nunca
# troca o que já está preenchido.
#
# Uso:  ./scripts/configurar.sh              senhas + perguntas (num terminal)
#       ./scripts/configurar.sh --so-senhas  sem perguntas: cria o .env e gera as senhas
#                                            (é o que uma IA pode rodar por você)
set -euo pipefail
cd "$(dirname "$0")/.."

SO_SENHAS=false
[ "${1:-}" = "--so-senhas" ] && SO_SENHAS=true

command -v openssl >/dev/null || { echo "Precisa do openssl para gerar as senhas." >&2; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Criei o .env a partir do .env.example."
fi
chmod 600 .env

# Valor atual de uma chave do .env (vazio se não existe).
valor() { grep -E "^$1=" .env | head -n 1 | cut -d= -f2- || true; }

# Troca a linha CHAVE= (ou acrescenta no fim), sem passar o valor pela linha de comando de outros
# processos nem pela tela. O awk lê do ambiente para não interpretar barras invertidas.
definir() {
  local chave=$1 novo=$2 tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/financas-env.XXXXXX")
  if grep -qE "^$chave=" .env; then
    CHAVE="$chave" NOVO="$novo" awk '
      BEGIN { c = ENVIRON["CHAVE"]; v = ENVIRON["NOVO"] }
      index($0, c "=") == 1 && !feito { print c "=" v; feito = 1; next }
      { print }' .env > "$tmp"
  else
    cat .env > "$tmp"
    printf '%s=%s\n' "$chave" "$novo" >> "$tmp"
  fi
  cat "$tmp" > .env # mantém a permissão 600 do .env
  rm -f "$tmp"
}

# --- senhas do banco ----------------------------------------------------------------------------
# Hexadecimal: sem "$", aspas ou barras, que o compose ou o shell poderiam interpretar.
geradas=0
for chave in POSTGRES_SUPERUSER_PASSWORD APP_DB_PASSWORD READONLY_DB_PASSWORD MCP_DB_PASSWORD; do
  if [ -z "$(valor "$chave")" ]; then
    definir "$chave" "$(openssl rand -hex 24)"
    geradas=$((geradas + 1))
  fi
done
echo "Senhas do banco: $geradas gerada(s) agora; as que já existiam ficaram como estavam."

# --- perguntas (só num terminal) ----------------------------------------------------------------
perguntar() {
  local chave=$1 texto=$2 secreto=${3:-} resp=''
  if [ -n "$(valor "$chave")" ]; then
    echo "  $chave: já preenchido."
    return
  fi
  if [ -n "$secreto" ]; then
    read -r -s -p "  $texto: " resp
    echo
  else
    read -r -p "  $texto: " resp
  fi
  # Sem espaços nas pontas; nos IDs, sem espaço nenhum ("id1, id2" → "id1,id2").
  resp=$(printf '%s' "$resp" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ "$chave" = PLUGGY_ITEM_IDS ] && resp=$(printf '%s' "$resp" | tr -d '[:space:]')
  [ -n "$resp" ] && definir "$chave" "$resp"
  return 0
}

if ! $SO_SENHAS && [ -t 0 ]; then
  echo
  echo "Pluggy (veja docs/pluggy.md). Os segredos não aparecem na tela enquanto você digita."
  perguntar PLUGGY_CLIENT_ID "Client ID (dashboard.pluggy.ai → sua aplicação)"
  perguntar PLUGGY_CLIENT_SECRET "Client Secret" secreto
  perguntar PLUGGY_ITEM_IDS "IDs dos items, separados por vírgula"
  echo
  echo "Opcionais (Enter para pular):"
  perguntar ANTHROPIC_API_KEY "Chave da API da Anthropic, para sugerir categorias" secreto
  perguntar CLASSIFY_OWNER_NAME "Seu nome como aparece nos Pix, para reconhecer transferências entre suas contas"
  perguntar BACKUP_AGE_RECIPIENT "Chave PÚBLICA do age para criptografar o backup (age1...)"
fi

# --- o que falta ---------------------------------------------------------------------------------
echo
faltam=''
for chave in PLUGGY_CLIENT_ID PLUGGY_CLIENT_SECRET PLUGGY_ITEM_IDS; do
  [ -n "$(valor "$chave")" ] || faltam="$faltam $chave"
done
if [ -n "$faltam" ]; then
  echo "Falta preencher no .env:$faltam"
  echo "Rode ./scripts/configurar.sh num terminal ou edite o .env (só você deve ver esses valores)."
else
  echo "Pluggy preenchida. Próximo passo:  docker compose run --rm sync check"
fi
recipient=$(valor BACKUP_AGE_RECIPIENT)
if [ -z "$recipient" ]; then
  echo "Aviso: sem BACKUP_AGE_RECIPIENT, o backup diário fica SEM criptografia (veja docs/backup.md)."
elif [ "${recipient#age1}" = "$recipient" ]; then
  echo "Aviso: BACKUP_AGE_RECIPIENT deveria começar com age1 (é a chave pública do age)." >&2
fi
