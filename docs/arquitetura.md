# Arquitetura

```
 Meu Pluggy (Open Finance)              sua máquina (docker compose)
 ┌───────────────────────┐     ┌────────────────────────────────────────────────┐
 │ seus bancos           │     │  sync ──(SYNC_TIMES)──► db (Postgres 18)        │
 │   └── api.pluggy.ai  ◄├─────┤  migrate (roda 1x antes)       │                │
 └───────────────────────┘     │  backup ──(diário, age)──► ./backups            │
                               │  web  ── 127.0.0.1:8737 ◄── navegador           │
                               │  mcp  ── stdin/stdout ◄── Claude Desktop/Code   │
                               └────────────────────────────────────────────────┘
```

## Serviços

| Serviço   | O que faz                                                                 |
|-----------|---------------------------------------------------------------------------|
| `db`      | Postgres 18, só em `127.0.0.1`. Schema `fin`.                              |
| `migrate` | aplica as migrations de `db/migrations` e sai                              |
| `sync`    | daemon: busca contas, transações, faturas e investimentos na Pluggy; classifica com IA, se ligada |
| `web`     | API (`node:http`) + front compilado (Vue 3)                                |
| `mcp`     | servidor MCP, aberto pelo Claude a cada conversa (profile, não sobe sozinho) |
| `backup`  | `pg_dump` diário, criptografado com age                                    |

`sync`, `web`, `mcp` e `migrate` usam a mesma imagem (`sync/`, Node 24 rodando TypeScript direto, sem build). Esses quatro containers rodam com sistema de arquivos somente leitura, sem capabilities e com `no-new-privileges`.

## Dados: duas camadas

- **Dados da Pluggy** (`accounts`, `transactions`, `bills`, `investments`...): só o sync escreve.
- **Camada do usuário** (`categories`, `category_rules`, `transaction_overrides`, `user_settings`, `planned_expenses`, `forecast_exclusions`, `goals`, `recurring_bills`): só você escreve, pelo app, pelo MCP ou por SQL. O sync nunca toca nela.

A leitura é feita pelas **views** (`v_transactions`, `v_monthly_summary`, `v_monthly_by_category`, `v_installment_plan`, `v_future_commitments`, `v_accounts`, `v_bills`, `v_bill_status`, `v_unbilled_card`, `v_investments`, `v_suggestions`, `v_installment_purchases`, `v_lost_overrides`, `v_sync_runs`). Elas aplicam categoria, regras e "ignorar" na hora da consulta, então mudar uma regra recategoriza o histórico inteiro.

**Papéis:** `fin_app` (o sync e o dono do schema), `fin_readonly` (só `SELECT`, usado para ler pelo app e pelo MCP) e `fin_mcp` (grava só a camada do usuário, sem `DELETE`).

**Dinheiro:** `numeric(14,2)` no banco e texto no Node e no front, nunca float. Quando o front precisa somar, soma em centavos inteiros.

## Como o sync decide as coisas

**Nada é apagado.** Se uma transação some da Pluggy, ela ganha `deleted_at` e sai das views, mas continua na tabela; se voltar, é "desapagada". Se a resposta vier vazia, ou se mais da metade da janela sumir de uma vez, nada é marcado e o sync registra um aviso. O mesmo vale para os investimentos.

**Ids que mudam.** A Pluggy recria a transação, com id novo, quando data, descrição ou valor mudam demais, e tudo ganha id novo quando um banco é reconectado. O sync religa a transação nova à linha existente, só entre linhas que não vieram mais, nesta ordem:

1. `providerId` (o id do próprio banco);
2. `providerCode` mais o valor;
3. instante exato (`precise_at`, com milissegundos) e número da parcela, com o mesmo valor **ou** a mesma descrição;
4. data, valor e descrição iguais.

Por isso as suas categorias e notas sobrevivem. No Meu Pluggy, `providerId` e `providerCode` vêm vazios, então valem as regras 3 e 4. Se uma transação com categoria sua sumir sem religar, o sync avisa e ela aparece em `fin.v_lost_overrides`. Contas são religadas por tipo e número (cartão pelos 4 últimos dígitos).

**Janela.** O primeiro sync de uma conta busca 365 dias; os seguintes, 120, o que cobre parcelas pendentes e correções tardias.

**Sinais.** `signed_amount` segue uma convenção única: entrada positiva, saída negativa. Ele vem do campo `type` (DEBIT/CREDIT), porque o sinal de `amount` muda conforme o tipo de conta.

**Datas.** A Pluggy manda datas em UTC, e o sync converte para o horário de Brasília. Quando o banco só informa o dia, a data chega como meia-noite em Brasília ou em UTC, e as duas são tratadas como "só o dia".

**Parcelas.** O Open Finance informa "parcela 2 de 6", mas não manda um id da compra. O grupo é formado pela descrição sem o "02/06", pelo número de parcelas e pela data da compra (ou o mês estimado da 1ª parcela, com ±1 mês de tolerância). A view `v_installment_plan` projeta as parcelas que ainda não vieram; alguns bancos já mandam as futuras como `PENDING`. Se a próxima parcela devia ter vindo num mês que já passou (antecipação, estorno), o parcelamento é considerado encerrado.

**Um sync por vez**, garantido por advisory lock no Postgres.

## Estrutura

```
db/init/                     papéis fin_app, fin_readonly e fin_mcp (1º start do volume)
db/migrations/               schema, categorias iniciais, views; nunca editadas depois de aplicadas
sync/src/pluggy.ts           cliente da API da Pluggy (auth, cursor, retry)
sync/src/normalize.ts        datas, sinais, parcelas, identidade de conta
sync/src/sync.ts             orquestração, upsert, religação, soft delete, parcelas, investimentos
sync/src/classify.ts         sugestões de categoria por IA
sync/src/previsao.ts         previsão mês a mês e veredito de compra (função pura)
sync/src/apagar.ts           a pagar até o próximo salário (função pura)
sync/src/queries.ts          consultas e escritas do usuário, usadas pela API e pelo MCP
sync/src/api/server.ts       API do app web e arquivos do front
sync/src/mcp/                servidor MCP (protocolo à mão, sem SDK), ferramentas e prompts
sync/src/main.ts             CLI: migrate | check | sync [--full] | classify | daemon | status | mcp | web
web/                         front em Vue 3 + Vite, compilado dentro da imagem
backup/backup.sh             pg_dump + age + retenção
scripts/                     configurar.sh (o .env) e contexto-mcp.sh (contexto da casa)
deploy.sh                    publicar num servidor (build aqui, imagens por SSH)
```

## Testes

O teste de integração usa um Postgres descartável e uma API da Pluggy simulada. Nunca rode contra o banco do compose.

```bash
docker run --rm -d --name fin-test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:18-alpine
cd sync && npm ci
npm run typecheck
TEST_PG_URL=postgres://postgres@127.0.0.1:55432/postgres npm test
docker stop fin-test
cd ../web && npm ci && npm test        # front: funções puras, sem banco
```

Cobrem o sync (importação, sinais, religação, soft delete, reconexão, erros da API), os papéis do banco, a API do app (rotas e proteções de Host, Origin, Content-Type e tamanho), o MCP (protocolo, ferramentas e o papel `fin_mcp`), a classificação por IA (o que vai no pedido), a previsão, o a pagar e as funções do front.
