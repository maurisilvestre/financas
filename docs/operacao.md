# Operação: dia a dia, conferências e problemas comuns

## Comandos do dia a dia

| Para…                                    | Rode                                                   |
|------------------------------------------|--------------------------------------------------------|
| Abrir o app                              | http://127.0.0.1:8737                                  |
| Sincronizar agora                        | botão **Sincronizar** no app, ou `docker compose run --rm sync sync` |
| Rebuscar os 12 meses inteiros            | `docker compose run --rm sync sync --full`             |
| Ver as últimas execuções e as contas     | `docker compose run --rm sync status`                  |
| Testar credenciais e listar contas       | `docker compose run --rm sync check`                   |
| Acompanhar os logs                       | `docker compose logs -f sync`                          |
| Pedir sugestões de categoria à IA agora  | `docker compose run --rm sync classify`                |
| Fazer um backup agora                    | `docker compose exec backup backup.sh now`             |
| Abrir o banco                            | `docker compose exec db psql -U fin_app -d financas`   |
| Atualizar depois de baixar código novo   | `git pull && docker compose up -d --build`             |

O sync roda sozinho nos horários de `SYNC_TIMES` (padrão: 07:17 e 19:17, horário de Brasília). Com `SYNC_ON_START=true`, roda também quando o container sobe, se o último sync tiver mais de 6 horas.

## Conferir com os seus dados

Depois do primeiro sync, vale conferir se as regras batem com o seu banco. Abra o banco (`docker compose exec db psql -U fin_app -d financas`) e rode:

```sql
-- Datas: compare algumas com o app do banco.
SELECT local_date, description, signed_amount, status FROM fin.v_transactions ORDER BY local_date DESC LIMIT 20;

-- Sinais: compras e saídas negativas; salário e estornos positivos.
SELECT account, flow, count(*), sum(signed_amount) FROM fin.v_transactions GROUP BY 1, 2;

-- Parcelas: cada compra parcelada deve virar um grupo só.
SELECT description, total_installments, count(*) FROM fin.v_installment_plan GROUP BY 1, 2 ORDER BY 1;

-- Pagamento de fatura deve cair em "Pagamento de fatura" (fluxo transfer), dos dois lados.
SELECT account, description, category, flow FROM fin.v_transactions
WHERE description ILIKE '%fatura%' OR description ILIKE '%pagamento recebido%';

-- Avisos do último sync (sinal inesperado, consentimento expirando...).
SELECT stats->'warnings' FROM fin.sync_runs ORDER BY id DESC LIMIT 1;
```

Se o seu banco descreve o pagamento da fatura de outro jeito (débito automático, por exemplo), crie uma regra para a categoria "Pagamento de fatura". Assim ele não conta como gasto em dobro com as compras.

## Categorias e regras

A categoria de cada transação é decidida na view `fin.v_transactions`, nesta ordem:

1. **Categoria escolhida por você** (`fin.transaction_overrides`): vale para uma transação e sobrevive a qualquer novo sync.
2. **Primeira regra que casar** (`fin.category_rules`, menor `priority` primeiro): por `operation_type` (tipo informado pelo banco), `contains` ou `regex`. A comparação é com a descrição em minúsculas e sem acento.
3. **Sem categoria:** o sinal decide se é gasto ou receita.

Editar uma regra recategoriza o histórico inteiro na hora. No app, isso tudo é feito na tela **Transações**; pelo MCP, conversando (prompt "categorizar pendentes"). Por SQL:

```sql
-- Regra nova: tudo que tiver "academia" vira Saúde
INSERT INTO fin.category_rules (category_id, match_type, pattern, priority)
SELECT id, 'contains', 'academia', 50 FROM fin.categories WHERE name = 'Saúde';

-- Pix para outra conta sua não é gasto (use o seu nome como aparece no extrato)
INSERT INTO fin.category_rules (category_id, match_type, pattern, priority)
SELECT id, 'contains', 'pix enviado fulano de tal', 15 FROM fin.categories WHERE name = 'Transferência entre contas';

-- Tirar uma transação dos relatórios
INSERT INTO fin.transaction_overrides (transaction_id, ignored) VALUES (123, true)
ON CONFLICT (transaction_id) DO UPDATE SET ignored = true, updated_at = now();
```

Categorias do tipo `transfer` (Pagamento de fatura, Investimentos, Transferência entre contas) ficam fora de gastos e receitas. Assim a compra no cartão conta uma vez só, e não de novo quando você paga a fatura.

## Consultas úteis

```sql
-- Gastos do mês por categoria
SELECT category, total FROM fin.v_monthly_by_category
WHERE month = date_trunc('month', current_date) AND flow = 'expense' ORDER BY total DESC;

-- Resumo mensal
SELECT * FROM fin.v_monthly_summary ORDER BY month DESC LIMIT 12;

-- Parcelas dos próximos meses
SELECT account, month, committed, installments FROM fin.v_future_commitments ORDER BY month, account;

-- Categorias suas cujas transações sumiram da Pluggy sem religar (o sync avisa)
SELECT * FROM fin.v_lost_overrides ORDER BY deleted_at DESC;
```

## Trocar senhas do banco

As senhas dos papéis são aplicadas só no primeiro start do volume do Postgres. Para trocar depois:

```bash
docker compose exec db psql -U postgres -d financas -c "ALTER ROLE fin_app PASSWORD 'nova-senha'"
# atualize APP_DB_PASSWORD no .env e:
docker compose up -d
```

O mesmo vale para `fin_readonly` (`READONLY_DB_PASSWORD`) e `fin_mcp` (`MCP_DB_PASSWORD`).

## Levar para outro computador

Copie a pasta do projeto com o `.env` e um backup recente, e siga o restore de [backup.md](backup.md). Se o outro computador for um servidor na sua rede, veja [servidor.md](servidor.md), que copia o banco ao vivo.

## Problemas comuns

- **O app mostra "Erro interno":** veja `docker compose logs web`. "statement timeout" indica uma máquina lenta demais para a consulta; tente de novo, ou rode num computador mais rápido.
- **"Checksum diferente" no migrate:** um arquivo de `db/migrations` foi alterado depois de aplicado. Migration aplicada não muda: mudança no schema é sempre um arquivo novo.
- **`docker compose` reclama de variável não definida:** falta algo no `.env`. Rode `./scripts/configurar.sh`, que mostra o que falta sem mostrar os valores.
- **Nada novo depois de sincronizar:** a Pluggy ainda não buscou os dados mais recentes no banco. Atualize a conexão no site do Meu Pluggy e sincronize de novo.
- **Porta ocupada:** troque `WEB_PORT` ou `DB_PORT` no `.env` e rode `docker compose up -d`.
