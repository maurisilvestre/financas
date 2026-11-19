#!/usr/bin/env bash
# Publica o app num servidor Linux x86_64 (um PC antigo em casa, por exemplo) sem build lá:
#   1. build das imagens próprias do compose para linux/amd64 aqui (funciona também num Mac arm64);
#   2. manda só essas imagens (financas/sync e financas/backup) por ssh, sem registry; as públicas,
#      como postgres:18-alpine, o servidor baixa sozinho;
#   3. copia para ~/financas só o que o runtime usa: o compose, db/init (montado no Postgres) e a
#      pasta de backups. O .env vai só se ainda não existir lá (nunca é sobrescrito), com
#      SYNC_ON_START=false e WEB_ALLOWED_HOSTS com o nome do tailscale serve;
#   4. sobe com "docker compose up -d --no-build"; o migrate roda antes do sync e do web, como aqui;
#   5. apaga as imagens antigas que ficaram sem tag (docker image prune -f).
#
# Uso:  ./deploy.sh usuario@servidor        (ou DEPLOY_HOST=usuario@servidor ./deploy.sh)
#       DEPLOY_DIR muda a pasta no servidor (padrão: financas, na home).
#       DEPLOY_WEB_HOST: nome do tailscale serve que vai para o 1º .env (ex.: servidor.tail0000.ts.net).
#
# Acesso remoto (no servidor, uma vez; troque 8443 se a porta estiver em uso):
#   sudo tailscale serve --bg --https=8443 http://127.0.0.1:8737
# Nunca use "tailscale funnel": ele abriria o app, que não tem login, para a internet.
#
# Não mexe nos dados: o volume do Postgres do servidor fica como está.
set -euo pipefail

DESTINO="${1:-${DEPLOY_HOST:-}}"
PASTA="${DEPLOY_DIR:-financas}"
WEB_HOST="${DEPLOY_WEB_HOST:-}"
PLATAFORMA=linux/amd64
# Tag só do transporte: a build amd64 não pode sobrescrever as imagens :local (arm64) que rodam
# aqui. No servidor, elas viram :local, o nome que o docker-compose.yml usa.
TAG=amd64
IMAGENS=(financas/sync financas/backup)

cd "$(dirname "$0")"
[ -n "$DESTINO" ] || { echo "Uso: ./deploy.sh usuario@servidor (ou DEPLOY_HOST=usuario@servidor)." >&2; exit 1; }
[ -f .env ] || { echo "Falta o .env aqui (o compose precisa dele até para a build)." >&2; exit 1; }

passo() { printf '\n== %s\n' "$*"; }

passo "Conferindo o servidor $DESTINO"
ARQ="$(ssh -n "$DESTINO" uname -m)"
[ "$ARQ" = x86_64 ] || { echo "Esperava x86_64 no servidor, veio $ARQ." >&2; exit 1; }
ssh -n "$DESTINO" 'docker compose version' >/dev/null

passo "Build para $PLATAFORMA (tag :$TAG)"
OVERRIDE="$(mktemp -t financas-deploy)"
trap 'rm -f "$OVERRIDE"' EXIT
cat > "$OVERRIDE" <<EOF
services:
  migrate: { image: financas/sync:$TAG, platform: $PLATAFORMA }
  sync: { image: financas/sync:$TAG, platform: $PLATAFORMA }
  web: { image: financas/sync:$TAG, platform: $PLATAFORMA }
  backup: { image: financas/backup:$TAG, platform: $PLATAFORMA }
EOF
# migrate e backup bastam: sync, web e mcp usam a mesma imagem do migrate.
docker compose -f docker-compose.yml -f "$OVERRIDE" build migrate backup

for img in "${IMAGENS[@]}"; do
  plat="$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$img:$TAG")"
  [ "$plat" = "$PLATAFORMA" ] || { echo "$img:$TAG saiu como $plat, não $PLATAFORMA." >&2; exit 1; }
done

passo "Mandando as imagens (docker save | gzip | ssh | docker load)"
docker save "${IMAGENS[@]/%/:$TAG}" | gzip | ssh "$DESTINO" 'gunzip | docker load'
ssh -n "$DESTINO" "set -e; for i in ${IMAGENS[*]}; do docker tag \$i:$TAG \$i:local; docker rmi \$i:$TAG >/dev/null; done"

passo "Copiando os arquivos do runtime para ~/$PASTA"
ssh -n "$DESTINO" "mkdir -p $PASTA/backups"
# COPYFILE_DISABLE: sem ele, o tar do Mac grava atributos estendidos como arquivos "._*". Em
# db/init, o Postgres tentaria rodar "._01-roles.sh" na criação do banco.
COPYFILE_DISABLE=1 tar -czf - docker-compose.yml db/init | ssh "$DESTINO" "tar -C $PASTA -xzf -"

if ssh -n "$DESTINO" "test -e $PASTA/.env"; then
  echo ".env já existe no servidor: não mexi."
else
  # O .env daqui, trocando duas linhas: sem sync na subida (dá tempo de restaurar um backup
  # antes, se você for levar dados) e o nome do tailscale serve. Vai pelo ssh (criptografado), sem passar pela
  # tela, só com permissão do dono; set -C não sobrescreve se ele aparecer no meio do caminho.
  { grep -Ev '^(SYNC_ON_START|WEB_ALLOWED_HOSTS)=' .env || true
    echo 'SYNC_ON_START=false'
    echo "WEB_ALLOWED_HOSTS=$WEB_HOST"
  } | ssh "$DESTINO" "umask 077; set -C; cat > $PASTA/.env"
  echo ".env copiado (primeira vez), com SYNC_ON_START=false e WEB_ALLOWED_HOSTS=${WEB_HOST:-(vazio)}."
  echo "Confira lá se algo mais muda no servidor (DB_PORT, WEB_PORT, SYNC_TIMES)."
  echo "Começando do zero? Use o botão Sincronizar ou ponha SYNC_ON_START=true lá. Levando dados? Veja docs/backup.md."
fi

passo "Subindo no servidor (docker compose up -d --no-build)"
ssh -n "$DESTINO" "cd $PASTA && docker compose up -d --no-build --remove-orphans && docker compose ps"

passo "Limpando as imagens antigas sem tag no servidor"
ssh -n "$DESTINO" 'docker image prune -f'

passo "Pronto"
echo "Logs: ssh $DESTINO 'cd $PASTA && docker compose logs -f sync'"
