# Rodar num servidor em casa

Dá para deixar o app num computador sempre ligado (um PC antigo com Linux, por exemplo) e abrir pelo navegador do celular ou do notebook. Os dois scripts abaixo rodam na sua máquina de trabalho e falam com o servidor por SSH.

## Requisitos do servidor

- Linux x86_64 com Docker e Compose v2 (`docker compose version`).
- Acesso por SSH com chave, sem senha.
- Cerca de 500 MB de memória livre para o Postgres, o sync e o app.

CPUs antigas sem AVX ou SSE4.2 servem: as imagens não usam binários nativos que exijam essas instruções.

## Publicar: `deploy.sh`

```bash
DEPLOY_WEB_HOST=servidor.tail0000.ts.net ./deploy.sh usuario@servidor
```

O script:

1. faz a build das imagens para `linux/amd64` aqui (funciona num Mac arm64);
2. manda as imagens por SSH (`docker save | gzip | ssh | docker load`), sem registry;
3. copia para `~/financas` só o que o runtime usa: o compose e `db/init`;
4. na primeira vez, copia o seu `.env`, com `SYNC_ON_START=false` e `WEB_ALLOWED_HOSTS` igual a `DEPLOY_WEB_HOST`. Depois disso, nunca mexe no `.env` de lá;
5. sobe tudo com `docker compose up -d --no-build` (o migrate roda antes do resto) e apaga as imagens antigas.

Para publicar uma versão nova, rode o mesmo comando. `DEPLOY_DIR` muda a pasta no servidor.

## Levar os dados de outra máquina

Começando do zero no servidor, use o botão **Sincronizar** do app (ou ponha `SYNC_ON_START=true` no `.env` de lá): o primeiro sync busca 12 meses.

Se o app já roda em outra máquina e você quer levar o histórico (inclusive o que passou dos 12 meses que a Pluggy devolve), use backup e restore, **antes** do primeiro sync no servidor:

1. Na máquina antiga, faça um backup e pare o app, para os dois não sincronizarem ao mesmo tempo:

   ```bash
   docker compose exec backup backup.sh now
   docker compose down
   ```

2. No servidor, troque o banco recém-criado pelo `deploy.sh`, ainda vazio, por um novo:

   ```bash
   ssh usuario@servidor 'cd financas && docker compose down && docker volume rm financas_pgdata && docker compose up -d db \
     && until docker compose exec -T db pg_isready -q -h 127.0.0.1 -U postgres -d financas; do sleep 2; done'
   ```

   O `pg_isready` pela rede (`-h 127.0.0.1`) só responde quando a inicialização do banco termina.

3. Da máquina antiga, mande o backup direto para o restore no servidor. A descriptografia acontece aqui, e a chave privada do age não vai para o servidor:

   ```bash
   age -d -i ~/.config/financas-backup.key backups/financas-AAAAMMDD-HHMMSS.dump.age \
     | ssh usuario@servidor 'cd financas && docker compose exec -T db pg_restore -U postgres -d financas --exit-on-error --single-transaction'
   ```

   Para um backup sem criptografia, troque o `age -d ...` por `cat backups/financas-AAAAMMDD-HHMMSS.dump`.
4. Suba o resto no servidor: `ssh usuario@servidor 'cd financas && docker compose up -d'`.

O `deploy.sh` copia o seu `.env` na primeira vez, então as senhas dos papéis no servidor são as mesmas da máquina antiga e o restore funciona.

## Abrir de outro aparelho: Tailscale

O app não tem login. Por isso ele e o banco escutam só em `127.0.0.1`, e o acesso de fora passa por um proxy HTTPS dentro da sua rede privada. Com o [Tailscale](https://tailscale.com), no servidor:

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8737
```

Abra `https://<nome-do-servidor>.<sua-tailnet>.ts.net:8443` em qualquer aparelho da sua tailnet. O nome exato vai em `WEB_ALLOWED_HOSTS` no `.env` do servidor; sem ele, o app recusa o pedido. Troque a porta 8443 se ela estiver em uso.

**Nunca use `tailscale funnel`** nem abra a porta no roteador: isso poria os seus dados financeiros na internet, sem senha.

## MCP com o app no servidor

O Claude abre o MCP no servidor por SSH. Veja a configuração em [mcp.md](mcp.md#configurar).

## Logs e manutenção

```bash
ssh usuario@servidor 'cd financas && docker compose ps'
ssh usuario@servidor 'cd financas && docker compose logs -f sync'
```

O backup roda no servidor e grava em `~/financas/backups` lá. Configure a criptografia ([backup.md](backup.md)) no `.env` do servidor e copie os backups para fora dele de vez em quando.
