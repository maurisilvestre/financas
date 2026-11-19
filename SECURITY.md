# Segurança

## Reportar uma vulnerabilidade

Não abra uma issue pública. Use o **report privado de vulnerabilidade** do GitHub, na aba *Security* do repositório (*Report a vulnerability*). Descreva o problema e como reproduzir, **sem dados reais**.

## Modelo de ameaça

O app foi feito para rodar na máquina do próprio usuário, ou num servidor dentro da rede privada dele. Ele **não tem login**, então as defesas partem do princípio de que só quem está na máquina, ou na rede privada, chega até ele.

**Rede**

- O Postgres e o app web escutam só em `127.0.0.1`.
- O acesso de outros aparelhos é feito por um proxy HTTPS dentro da rede privada (por exemplo, `tailscale serve`).
- O app aceita só os nomes exatos listados em `WEB_ALLOWED_HOSTS`. Expor o app na internet (`tailscale funnel`, porta aberta no roteador) não é suportado.

**Navegador:** a API se defende de outros sites abertos no mesmo navegador.

- **`Host`:** só `127.0.0.1`, `localhost` e os nomes de `WEB_ALLOWED_HOSTS`, o que bloqueia DNS rebinding.
- **Escrita:** só com JSON e com `Origin` igual ao `Host`, o que bloqueia CSRF.
- **Cabeçalhos:** sem CORS, com CSP restrita e corpo de até 64 KB.

**Banco**

- **`fin_readonly`:** só `SELECT`.
- **`fin_mcp`:** grava só a camada do usuário (categorias, regras, metas, planos), sem `DELETE` e sem acesso às tabelas da Pluggy.
- **MCP:** não tem SQL livre nem acesso ao `raw` da Pluggy, que traz CPFs e números de conta.
- **Regras:** o MCP só cria regras do tipo "contém", para que uma descrição maliciosa não induza uma regex cara.

**Segredos**

- As credenciais da Pluggy e a chave da Anthropic ficam só no `.env`, que não vai para o git.
- A chave da Anthropic só chega ao container do `sync`.
- Os logs não mostram segredos, ids completos nem payloads.
- O arquivo `.claude/settings.json` impede o Claude Code de ler o `.env`, chaves e backups.

**IA**

- Para a API da Anthropic vão só descrição, valor e data, mais os nomes das categorias e, se configurado, o nome do titular.
- As descrições são tratadas como dados de terceiros que podem trazer injeção de prompt. As defesas estão em [docs/ia.md](docs/ia.md).
- Uma sugestão nunca vira categoria sem o usuário aplicar.

**Backup:** o backup é criptografado com age quando `BACKUP_AGE_RECIPIENT` está definido. Sem a chave, ele fica em claro, e o log avisa.

## Para quem usa

- Mantenha o `.env` com permissão `600` e nunca o compartilhe.
- Configure a criptografia do backup e guarde a chave privada do age fora do computador.
- Mantenha o Docker e o sistema atualizados.
- Revogue o consentimento no Meu Pluggy se deixar de usar o app.
