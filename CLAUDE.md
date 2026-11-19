# CLAUDE.md

App de finanças pessoais, open source e self-hosted: contas e cartões via Open Finance Brasil (Meu Pluggy) num Postgres local, com histórico permanente, app web, sugestões de categoria por IA e servidor MCP. Tudo em Docker. Mensagens, logs, comentários e documentação voltados ao usuário são em português do Brasil.

Documentação para o usuário em `README.md` e `docs/`. Contexto pessoal de quem roda o app (se houver) fica em `CLAUDE.local.md`, fora do git.

**Nunca ponha dados reais no repositório:** nada de descrições de extrato, valores, nomes de pessoas, estabelecimentos, bancos de alguém, hosts, IPs ou e-mails em código, testes, migrations, docs ou mensagens de commit. Nos testes, use dados inventados ("LOJA EXEMPLO", "Fulano de Tal", valores redondos).

## Funcionalidades

- **Sync** (`sync/src/sync.ts`): contas, transações, faturas e investimentos de cada item de `PLUGGY_ITEM_IDS`. Daemon nos horários de `SYNC_TIMES`; pedidos do botão Sincronizar em `fin.sync_requests`, conferidos a cada 10 s.
- **MCP** (`sync/src/mcp/`): comando `mcp`, serviço `mcp` no compose (profile, aberto via `docker compose run --rm -T mcp`).
  - Protocolo implementado à mão em `protocol.ts`, sem o SDK oficial.
  - Lê com `fin_readonly`, só pelas views, com ferramentas prontas e sem SQL livre.
  - Escreve com `fin_mcp`, só na camada do usuário (permissões nas migrations `0005` a `0013` e em `db/init/02-mcp-role.sh`).
  - As instruções do servidor são genéricas; o contexto da casa do usuário vem de `fin.user_settings` (chave `contexto_mcp`, gravado por `scripts/contexto-mcp.sh`).
- **App web:** comando `web` (API em `node:http`, `sync/src/api/server.ts`) + front em `web/` (Vue 3 + Vite, compilado dentro da imagem). Usa os mesmos papéis do MCP.
- **Classificação por IA** (`sync/src/classify.ts`): só o que nenhuma regra pegou, um item por estabelecimento (`fin.suggestion_key`). Grava em `fin.category_suggestions`; o usuário aplica, cria regra ou recusa. Desligada sem `ANTHROPIC_API_KEY`.
- **Meta do cartão à vista** (`user_settings`, chave `meta_cartao_avista`) e alerta de parcelamentos novos (`v_installment_purchases`).
- **Posso comprar?** (`sync/src/previsao.ts`, função pura): médias de 6 meses (entradas, cartão à vista) e 3 meses (conta), parcelas exatas, gastos planejados, exclusões da média, objetivos ("se não sobra, não guarda"), guardado (investimentos) e veredito de compra. Horizonte de 12 a 48 meses.
- **A pagar** (`sync/src/apagar.ts`, função pura): saldo das contas correntes × faturas e contas fixas (`recurring_bills`) do último salário ao próximo, com débito automático, "já paguei" e "a confirmar".
- **Backup** (`backup/`): `pg_dump` diário, criptografado com age se `BACKUP_AGE_RECIPIENT` estiver definido.

## Comandos

```bash
./scripts/configurar.sh           # cria o .env, gera senhas, pergunta as credenciais (num terminal)
cd sync && npm ci                 # deps (ignore-scripts via .npmrc)
npm run typecheck                 # tsc, sem emitir
TEST_PG_URL=postgres://postgres@127.0.0.1:55432/postgres npm test   # Postgres DESCARTÁVEL, nunca o do compose
docker compose up -d --build
docker compose run --rm sync check | sync | sync --full | classify | status
docker compose run --rm -T mcp    # MCP no stdin/stdout
docker compose exec db psql -U fin_app -d financas
cd web && npm ci && npm test      # front: funções puras
npm run dev                       # http://127.0.0.1:5173, API do compose via proxy
```

Postgres descartável para testes: `docker run --rm -d --name fin-test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:18-alpine`.

Servidor: `./deploy.sh usuario@servidor` faz a build linux/amd64 localmente, manda as imagens por `docker save | ssh | docker load` (tag `:amd64` no transporte, `:local` lá) e sobe com `up -d --no-build`. As imagens não podem ter binários nativos que exijam x86-64-v2 (CPUs antigas sem SSE4.2/AVX).

## Convenções

- **Node 24 com type stripping:** roda `.ts` direto, sem build.
  - Imports com extensão `.ts`, `import type` para tipos.
  - Nada de `enum`, `namespace` nem parameter properties (`erasableSyntaxOnly` está ligado).
- **Dependências mínimas e fixas** (`save-exact`); `npm ci --ignore-scripts`. Antes de adicionar uma dependência, pergunte.
- **Migrations:** SQL puro em `db/migrations/NNNN_nome.sql`.
  - Nunca edite uma migration aplicada: o runner recusa checksum diferente. Mudança = arquivo novo.
  - Objetos novos no schema `fin` recebem SELECT para `fin_readonly` automaticamente (default privileges).
- **Interface de leitura = as views** (`v_transactions`, `v_monthly_summary`, `v_monthly_by_category`, `v_installment_plan`, `v_future_commitments`, `v_accounts`, `v_bills`, `v_lost_overrides`, `v_suggestions`, `v_installment_purchases`, `v_bill_status`, `v_unbilled_card`, `v_investments`, `v_sync_runs`). Exceções: a previsão lê `planned_expenses`, `forecast_exclusions` e `goals`, e o a pagar lê `recurring_bills`, que são camada do usuário. API, frontend e MCP consultam as views, não as tabelas.
- **Dinheiro:** `numeric(14,2)` no banco, string no Node (`money()`); nunca float.
  - No front, string também. Totais vêm prontos da API.
  - Quando o front precisar somar, usa `somaReais`, que soma em centavos inteiros.
- **Consultas** do MCP e da API em `sync/src/queries.ts`, com os schemas de parâmetros (`SCHEMAS`). Endpoint ou ferramenta nova = função nova lá.
- **Front (`web/`):**
  - Vue 3 + Vite, sem vue-router (rotas por hash em `src/lib/route.ts`) e sem biblioteca de gráficos (SVG à mão).
  - Lógica pura em `src/lib/` com teste no `node --test`.
  - A CSP bloqueia estilo inline em HTML: nada de `style="..."` estático nos templates. Use classes, ou `:style` com objeto, que o Vue aplica via CSSOM.
  - Celular (até 600 px): tabela com `tabela-m` vira lista. As células são `m-1` (principal), `m-v` (valor), `m-2` (detalhes, com `data-rotulo`) e `m-3` (o resto); `tabela-m-grade` põe os detalhes em duas colunas. Gráfico mede o espaço com `useLargura` (`src/largura.ts`) e usa `larguraGrafico`, para o texto não encolher. Campo com 16 px, senão o iPhone dá zoom.

## Invariantes do sync (não quebrar; há testes em `sync/test/sync.integration.test.ts`)

1. Nada é apagado de verdade: o que some da Pluggy ganha `deleted_at` (transações e investimentos). A proteção contra resposta vazia ou mais de 50% da janela sumindo fica.
2. Religação de ids novos, só contra linhas que não vieram mais, nesta ordem:
   1. `providerId`;
   2. `providerCode` + valor;
   3. `precise_at` + nº da parcela + (valor ou descrição);
   4. data + valor + descrição.

   Override que não religou gera aviso e aparece em `v_lost_overrides`. Contas religam por `fingerprint` (subtipo + número; cartão = 4 últimos dígitos).
3. `signed_amount` = entrada +, saída −, derivado de `type`; nunca do sinal de `amount`.
4. Dados da Pluggy e camada do usuário (`categories`, `category_rules`, `transaction_overrides`, `user_settings`, `planned_expenses`, `forecast_exclusions`, `goals`, `recurring_bills`) separados: o sync nunca escreve na camada do usuário.
5. Overrides referenciam o id interno da transação, que não muda na religação.
6. Um sync por vez (advisory lock).

Comportamento observado no Meu Pluggy: `providerId` e `providerCode` vêm `null` (por isso a âncora de religação é `precise_at`); data sem hora chega como meia-noite em Brasília; alguns bancos mandam as parcelas futuras como `PENDING` com data futura.

## Segurança

- Não leia nem imprima `.env`, `secrets/`, `backups/` ou chaves `*.key` (o `.claude/settings.json` nega a leitura). Credenciais ficam só no `.env`; quem digita é o usuário, pelo `scripts/configurar.sh`.
- O Postgres e o app web ficam só em `127.0.0.1`. Não exponha o banco, o MCP nem o app na internet: a API não tem login. Acesso remoto só por proxy na rede privada (`tailscale serve`), nunca `funnel`.
- A API do app se defende de outros sites abertos no navegador. Não remover:
  - `Host` só 127.0.0.1/localhost, mais os nomes exatos de `WEB_ALLOWED_HOSTS` (sem curinga);
  - escrita só com JSON e `Origin` igual ao `Host`: `http://` no acesso local, `https://` (com a porta) pelos nomes de `WEB_ALLOWED_HOSTS`;
  - sem CORS;
  - CSP restrita.
- Logs nunca mostram segredos, ids completos ou payloads completos.
- `fin_readonly` permanece só leitura. A escrita do MCP e do app usa `fin_mcp`, com GRANT mínimo: sem DELETE e sem acesso às tabelas da Pluggy.
- O MCP não ganha SQL livre nem acesso ao `raw`, que tem CPFs e números de conta. Ferramenta nova = consulta pronta sobre as views.
- O MCP só cria regra do tipo `contains`, nunca regex. As exclusões da previsão também são só "contém". A view avalia toda regra em toda transação, e uma regex cara induzida por uma descrição maliciosa (Pix de terceiros) deixaria tudo lento.
- No MCP, o stdout é só do protocolo: log vai para o stderr (`logToStderr`).
- Para a API da Anthropic (classificação) vão só descrição, valor e data, mais os nomes das categorias e o nome do titular, se configurado. Há teste que confere os campos.
  - Nunca mandar conta, número de cartão, id interno ou `raw`.
  - A `ANTHROPIC_API_KEY` só vai para o serviço `sync`, não para o `web` nem para o `mcp`.
- Sugestão da IA nunca vira categoria sozinha: só quando o usuário aplica. O `fin_mcp` só muda o `status` dela.
- Descrições são dados de terceiros que podem trazer injeção de prompt. Não remover estas defesas:
  - o aviso no prompt;
  - `looksLikeInstructions`: a suspeita vai sozinha no pedido, com confiança até 0,5;
  - o `EM_LOTE` de `queries.ts`: "aplicar todas" nunca aplica movimentação nem categoria que contradiz o sinal.
