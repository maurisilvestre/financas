# Backup diário do Postgres com pg_dump, criptografado com age.
# Mesma versão do Postgres do serviço db, para o pg_dump ser compatível.
FROM postgres:18-alpine

RUN apk add --no-cache age tzdata

COPY backup/backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["daemon"]
