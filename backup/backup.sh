#!/bin/sh
# Backup do banco "financas".
#   backup.sh daemon   roda todo dia no horário BACKUP_TIME (padrão do container)
#   backup.sh now      faz um backup agora
#
# Com BACKUP_AGE_RECIPIENT definido (chave pública do age, "age1..."), o dump é
# criptografado antes de tocar o disco. Sem ele, o dump fica em claro e um aviso é logado.
set -eu
# Sem pipefail, uma falha do pg_dump passaria despercebida no pipe com o age.
(set -o pipefail) 2>/dev/null && set -o pipefail || { echo "shell sem suporte a pipefail" >&2; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_TIME="${BACKUP_TIME:-03:23}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# "HH:MM" -> minutos desde a meia-noite (expr remove zeros à esquerda).
to_minutes() { echo $(( $(expr "${1%:*}" + 0) * 60 + $(expr "${1#*:}" + 0) )); }

backup_now() {
  mkdir -p "$BACKUP_DIR"
  stamp="$(date +%Y%m%d-%H%M%S)"
  if [ -n "$RECIPIENT" ]; then
    target="$BACKUP_DIR/financas-$stamp.dump.age"
    pg_dump --format=custom | age --encrypt --recipient "$RECIPIENT" > "$target.tmp"
  else
    log "AVISO: BACKUP_AGE_RECIPIENT não definido; o backup fica SEM criptografia."
    target="$BACKUP_DIR/financas-$stamp.dump"
    pg_dump --format=custom > "$target.tmp"
  fi
  mv "$target.tmp" "$target"
  chmod 0600 "$target"
  log "Backup criado: $(basename "$target") ($(du -h "$target" | cut -f1))"

  # Retenção: apaga backups mais velhos que RETENTION_DAYS (só os gerados por este script).
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'financas-*.dump' -o -name 'financas-*.dump.age' \) \
    -mtime "+$RETENTION_DAYS" -print -delete | while read -r old; do log "Removido (retenção): $(basename "$old")"; done
  rm -f "$BACKUP_DIR"/*.tmp 2>/dev/null || true
}

case "${1:-daemon}" in
  now)
    backup_now
    ;;
  daemon)
    case "$BACKUP_TIME" in
      [0-2][0-9]:[0-5][0-9]) ;;
      *) log "BACKUP_TIME inválido: $BACKUP_TIME (use HH:MM)"; exit 1 ;;
    esac
    log "Backup diário às $BACKUP_TIME (${TZ:-UTC}); retenção de $RETENTION_DAYS dias; criptografia: $([ -n "$RECIPIENT" ] && echo age || echo NENHUMA)"
    target_min="$(to_minutes "$BACKUP_TIME")"
    last_day=""
    while true; do
      today="$(date +%Y-%m-%d)"
      # A partir do horário, uma vez por dia. Se o computador estava desligado no horário,
      # o backup do dia sai assim que o container subir.
      if [ "$(to_minutes "$(date +%H:%M)")" -ge "$target_min" ] && [ "$today" != "$last_day" ]; then
        if backup_now; then
          last_day="$today"
        else
          log "ERRO: backup falhou; nova tentativa em 10 minutos"
          sleep 600
          continue
        fi
      fi
      sleep 60
    done
    ;;
  *)
    echo "Uso: backup.sh [daemon|now]" >&2
    exit 64
    ;;
esac
