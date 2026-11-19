# Backup e restore

A Pluggy devolve no máximo 12 meses de histórico. Tudo o que for mais antigo existe só no seu banco, então o backup importa.

O serviço `backup` faz `pg_dump` todo dia às `BACKUP_TIME`, ou assim que subir, se o computador estava desligado no horário. Os arquivos ficam em `./backups` e são apagados depois de `BACKUP_RETENTION_DAYS`.

## Criptografia (recomendado)

Com uma chave pública do [age](https://age-encryption.org) em `BACKUP_AGE_RECIPIENT`, o dump é criptografado antes de tocar o disco. **Sem ela, o backup fica sem criptografia** (o log avisa), com todos os seus dados financeiros em claro.

```bash
# macOS: brew install age · Debian/Ubuntu: sudo apt install age
age-keygen -o ~/.config/financas-backup.key   # mostra a chave pública "age1..."
```

1. Ponha a chave **pública** (`age1...`) em `BACKUP_AGE_RECIPIENT`, pelo `./scripts/configurar.sh` ou direto no `.env`.
2. Guarde a chave **privada** (o arquivo `.key`) no seu gerenciador de senhas e apague a cópia do disco, se quiser. Sem ela, não há restore.
3. Rode `docker compose up -d backup` para o serviço pegar a chave.

Os backups antigos, feitos sem criptografia, continuam em claro: apague-os depois que sair o primeiro criptografado.

Com criptografia, a pasta `backups` pode ir para a nuvem ou para um HD externo. Copie-a para fora da máquina de vez em quando.

## Restore

Num volume novo, por exemplo em outro computador, com o mesmo `.env`:

```bash
docker compose up -d db                       # cria o banco e os papéis com as senhas do .env
age -d -i ~/.config/financas-backup.key backups/financas-AAAAMMDD-HHMMSS.dump.age > /tmp/financas.dump
docker compose exec -T db pg_restore -U postgres -d financas --exit-on-error < /tmp/financas.dump
rm /tmp/financas.dump
docker compose up -d                          # o migrate não faz nada; o sync continua de onde parou
```

Para um backup sem criptografia, pule o passo do `age` e use o `.dump` direto.

## Backup agora

```bash
docker compose exec backup backup.sh now
```
