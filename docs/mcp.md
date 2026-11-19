# MCP: conversar com seus dados no Claude

O app tem um servidor [MCP](https://modelcontextprotocol.io) (Model Context Protocol). Com ele, o Claude Desktop, o Claude Code ou outro cliente MCP consulta os seus dados e responde perguntas como "para onde foi o dinheiro este mês?" ou "posso comprar isto?" com os seus números de verdade.

**Como funciona:**

- O cliente abre o servidor num container a cada conversa (`docker compose run --rm -T mcp`). A comunicação é pelo stdin/stdout, sem nenhuma porta aberta, e o container some quando a conversa acaba.
- O modelo não escreve SQL. Ele usa **ferramentas prontas**, que leem pelas views do banco, e uma parte delas grava só nas suas categorias, regras e planos, sempre com a sua confirmação.
- Antes de usar, leia [Privacidade](#privacidade-o-que-vai-para-a-ia): o que o Claude consulta vai para o provedor do modelo.

## Antes de começar

- O app instalado (veja o [README](../README.md#instalar)). Se o banco estiver parado, o `docker compose run` do MCP sobe o `db` sozinho.
- Pelo menos um sync feito, para haver dados.
- O Claude Desktop, o Claude Code ou outro cliente MCP que use stdio.

## Configurar

### Claude Code

Na pasta do projeto:

```bash
claude mcp add --scope user financas -- docker compose --project-directory "$PWD" run --rm -T mcp
claude mcp list          # deve mostrar financas como conectado
```

Numa sessão do Claude Code, `/mcp` mostra o servidor e as ferramentas.

### Claude Desktop

1. Abra *Configurações → Desenvolvedor → Editar configuração*. O arquivo é:
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
2. Acrescente o servidor em `mcpServers`, sem apagar o que já estiver lá:

   ```json
   {
     "mcpServers": {
       "financas": {
         "command": "/usr/local/bin/docker",
         "args": ["compose", "--project-directory", "/caminho/para/financas", "run", "--rm", "-T", "mcp"]
       }
     }
   }
   ```

   - Em `--project-directory`, ponha o caminho completo da pasta do projeto.
   - Em `command`, ponha o caminho completo do Docker, porque o Claude Desktop não usa o `PATH` do seu terminal. Descubra com `which docker` (macOS e Linux) ou `where docker` (Windows). No macOS, costuma ser `/usr/local/bin/docker` ou `/opt/homebrew/bin/docker`. No Windows, `C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe`, com as barras duplicadas no JSON.
   - Com o projeto dentro do WSL, no Windows: `"command": "wsl"` e `"args": ["-e", "docker", "compose", "--project-directory", "/home/voce/financas", "run", "--rm", "-T", "mcp"]`.
3. Feche o Claude Desktop por completo (no macOS, Cmd+Q) e abra de novo.
4. Numa conversa nova, o servidor `financas` aparece no menu de ferramentas e conectores. Teste com "quanto gastei este mês?".

### App num servidor

Com o app num servidor em casa ([servidor.md](servidor.md)), o MCP roda lá, por SSH. O login por chave precisa funcionar sem pedir senha, porque o cliente não tem onde você digitar:

```json
"financas": {
  "command": "/usr/bin/ssh",
  "args": ["-T", "-o", "BatchMode=yes", "usuario@servidor", "cd financas && docker compose run --rm -T mcp"]
}
```

No Claude Code: `claude mcp add --scope user financas -- ssh -T -o BatchMode=yes usuario@servidor 'cd financas && docker compose run --rm -T mcp'`.

### Outros clientes MCP

Qualquer cliente que fale MCP por stdio serve: o comando é `docker` e os argumentos são `compose --project-directory /caminho/para/financas run --rm -T mcp`. O servidor aceita as versões do protocolo de `2024-11-05` a `2025-11-25`.

## O que perguntar

Alguns exemplos:

- "Quanto entrou e quanto saiu nos últimos 3 meses? Separe cartão e conta."
- "Para onde foi o dinheiro do cartão este mês, comparado com a média?"
- "Quais assinaturas e contas fixas eu tenho, e quais dariam para cortar?"
- "Quanto das minhas parcelas ainda vai cair em cada mês?"
- "O dinheiro da conta dá até o próximo salário?"
- "Posso comprar uma geladeira de R$ 4.000 em 10x a partir do mês que vem?"
- "Monte um plano para eu juntar R$ 10.000 de reserva sem deixar o saldo negativo."
- "Categorize as transações que estão sem categoria."

## Prompts prontos

No Claude Desktop, ficam no botão "+" da conversa. Cada um já diz ao Claude quais ferramentas usar e como responder.

| Prompt | Pede | O que faz |
|--------|------|-----------|
| **posso comprar** | o que, valor, motivo | Simula a compra na previsão e dá o veredito com números (cabe, no limite ou não cabe). Mostra a partir de quando cabe, quanto cortar e a troca com os objetivos. Se você decidir comprar, oferece registrar como gasto planejado. |
| **equilibrar objetivos** | — | Monta um plano de aportes por objetivo que mantém o saldo positivo em todos os meses e deixa folga para viver, no cenário da média e no da meta do cartão. |
| **dicas de economia** | meses (padrão 3) | Retrato de entradas e saídas, onde está gastando mais, o que cortar ou renegociar com a economia mensal de cada item, e ideias para aumentar a receita. |
| **categorizar pendentes** | — | Agrupa o que está sem categoria por estabelecimento e propõe regras e categorias numa tabela. Só grava depois da sua aprovação. |

## Ferramentas

### Leitura

| Ferramenta | O que devolve | Principais parâmetros |
|------------|---------------|-----------------------|
| `resumo_mensal` | gastos (cartão e conta), receitas, saldo e quantas sem categoria, mês a mês | `meses` (padrão 12, até 36) |
| `gastos_por_categoria` | total, número de transações e média mensal por categoria | `de`, `ate` (AAAA-MM), `fluxo` (expense ou income), `origem` (cartao ou conta), `por_mes` |
| `buscar_transacoes` | transações, a quantidade encontrada e a soma de todas | `texto`, `categoria`, `sem_categoria`, `conta`, `origem`, `fluxo`, `de`, `ate`, `valor_min`, `valor_max`, `incluir_ignoradas`, `limite` (até 500), `offset` |
| `gastos_recorrentes` | o que se repete em vários meses (assinaturas, mensalidades, contas fixas) | `meses` (padrão 6), `minimo_meses` (padrão 3) |
| `compromissos_futuros` | parcelas que ainda vão cair, por mês e por parcelamento | — |
| `contas` | contas e cartões: saldo, limite, vencimento da fatura, final do número e expiração do consentimento | — |
| `faturas` | faturas: vencimento, total, mínimo, encargos (juros, multa, IOF) e pagamentos | `meses` (padrão 6) |
| `categorias` | categorias e as regras de cada uma | — |
| `a_pagar` | o que sai das contas correntes até o próximo salário e se o saldo dá | — |
| `previsao` | previsão mês a mês, objetivos, guardado, o que ficou fora da média e, com `valor`, a simulação de uma compra | `meses` (12 a 48), `cenario` (media ou meta), `reserva`, `margem` (padrão 1.000), `valor`, `parcelas`, `mes`, `descricao` |

### Escrita

Todas gravam só na camada do usuário e nenhuma apaga nada. O Claude Desktop pede a sua confirmação antes de cada uma.

| Ferramenta | O que grava |
|------------|-------------|
| `definir_categoria` | a categoria (e uma nota) de uma transação; o id vem de `buscar_transacoes` |
| `criar_regra` | uma regra "contém": toda transação com o trecho na descrição ganha a categoria, inclusive o histórico; responde quantas pegou |
| `planejar_gasto` | um gasto decidido que ainda não aconteceu (à vista ou parcelado), para entrar na previsão |
| `atualizar_planejado` | marca um gasto planejado como realizado ou cancelado |
| `excluir_da_previsao` | tira da média uma categoria ou um trecho da descrição que não vai mais se repetir |
| `remover_exclusao_da_previsao` | devolve à média algo que tinha sido excluído |
| `criar_objetivo` | um objetivo: quanto juntar, quanto já tem, quanto guardar por mês e a partir de quando |
| `atualizar_objetivo` | muda valor, já guardado, aporte, início ou status (concluído, cancelado) de um objetivo |

**Para desfazer:**

- **Categoria de uma transação:** troque na tela Transações do app.
- **Gasto planejado, exclusão ou objetivo:** marque como cancelado (pelo Claude ou no app).
- **Regra:** desative por SQL, porque o MCP não apaga:

  ```bash
  docker compose exec db psql -U fin_app -d financas -c "UPDATE fin.category_rules SET enabled = false WHERE id = 123"
  ```

  O id está na saída de `categorias`.

## Contexto da casa (opcional)

O Claude entende melhor as suas contas se souber como vocês as usam. Por exemplo:

- quem usa cada conta ou cartão, e qual é o do dia a dia;
- de qual conta saem as contas fixas, e quando cai o salário;
- regras combinadas ("não parcelamos compras do mercado");
- objetivos e prioridades.

Escreva num arquivo `contexto-mcp.md`, com até 4.000 caracteres. Exemplo inventado:

```text
Somos duas pessoas e dividimos as contas.
O cartão "A" é o do dia a dia; o "B" fica para viagens e compras grandes.
As contas fixas saem da conta conjunta, e o salário cai por volta do dia 5.
Combinamos não parcelar compras do mercado.
A prioridade agora é a reserva de emergência.
```

Grave no banco:

```bash
./scripts/contexto-mcp.sh contexto-mcp.md   # grava
./scripts/contexto-mcp.sh                   # mostra o atual
./scripts/contexto-mcp.sh --apagar          # tira
```

- O texto fica no seu banco (`fin.user_settings`, chave `contexto_mcp`), nunca no código. O arquivo `contexto-mcp.md` já está no `.gitignore`.
- O servidor acrescenta o texto no fim das instruções que manda ao Claude. Ele lê o contexto quando abre: comece uma conversa nova depois de mudar.
- Como as instruções vão para o modelo, não escreva ali o que não mandaria numa conversa (senhas, números de conta, CPF).

## Privacidade: o que vai para a IA

Numa conversa, **o que o Claude consulta vai para o provedor do modelo** (a Anthropic, no caso do Claude), como parte da conversa e nos termos da sua conta. Isso inclui descrições, valores e datas das transações, nomes das contas e o final dos números, saldos, faturas e o contexto da casa.

**Nunca vai:**

- CPF, números completos de conta ou cartão e o payload bruto da Pluggy (`raw`): as ferramentas não têm acesso a eles;
- as credenciais da Pluggy e da Anthropic: o container do MCP não as recebe;
- o banco inteiro: só o que cada ferramenta devolve, com limite de linhas.

Isso é diferente das [sugestões de categoria por IA](ia.md), que mandam só descrição, valor e data de um item por estabelecimento. Se quiser menos exposição, peça análises agregadas ("totais por categoria") em vez de listas de transações.

## Segurança

- **Leitura:** papel `fin_readonly`, só `SELECT` e só pelas views. Não há SQL livre.
- **Escrita:** papel `fin_mcp`. Grava só a camada do usuário (categorias das transações, regras, status das sugestões, meta, gastos planejados, exclusões, objetivos e contas fixas), sem `DELETE` e sem acesso aos dados da Pluggy. Há testes para cada permissão.
- **Regras só do tipo "contém":** uma regex cara, induzida por uma descrição maliciosa, deixaria todas as consultas lentas.
- **Descrições são dados de terceiros:** o texto de um Pix é livre. As instruções do servidor mandam o modelo tratá-las como dados, nunca como instruções, e avisar se alguma pedir para gravar algo.
- **Confirmação:** mantenha a aprovação manual das ferramentas de escrita no seu cliente. Evite "permitir sempre" nelas.
- **Sem porta:** o servidor não abre porta nenhuma. Só o processo que o cliente abriu fala com ele, e o log vai para o stderr, separado do protocolo.

## Problemas comuns

| Sintoma | Causa provável |
|---------|----------------|
| O servidor não aparece ou aparece desconectado | O Docker não está rodando, o caminho do `docker` ou da pasta está errado no JSON, ou o JSON ficou inválido (vírgula sobrando). |
| Erro de conexão com o banco no log | O `docker compose run` sobe o `db` sozinho, mas ele não ficou saudável. Veja `docker compose logs db`. |
| A primeira resposta demora alguns segundos | O container sobe a cada conversa. É normal. |
| Ferramenta de escrita dá "permission denied" | Falta `MCP_DB_PASSWORD` no `.env`, ou o banco foi criado antes do papel `fin_mcp` existir. No segundo caso, rode `docker compose exec db sh /docker-entrypoint-initdb.d/02-mcp-role.sh` e `docker compose up -d`. |
| Dados desatualizados | O MCP lê o banco; quem traz dados novos é o sync. Clique em **Sincronizar** no app. |
| Por SSH: "Permission denied (publickey)" | O login por chave não funciona sem senha. Teste no terminal: `ssh -o BatchMode=yes usuario@servidor true`. |
| O contexto da casa não fez efeito | Comece uma conversa nova; o servidor lê o contexto ao abrir. |

**Logs do Claude Desktop:** `~/Library/Logs/Claude/mcp-server-financas.log` no macOS, ou `%APPDATA%\Claude\logs\` no Windows.

## Testar sem o Claude

O servidor fala JSON-RPC, uma mensagem por linha. Para conferir a conexão e listar as ferramentas:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"teste","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | docker compose run --rm -T mcp 2>/dev/null
```

E para chamar uma ferramenta:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"resumo_mensal","arguments":{"meses":3}}}' \
  | docker compose run --rm -T mcp 2>/dev/null
```

O `2>/dev/null` esconde os logs, que saem no stderr.

## Para quem desenvolve

- **Protocolo:** implementado à mão em `sync/src/mcp/protocol.ts`, sem o SDK oficial.
- **Ferramentas, prompts e instruções:** em `sync/src/mcp/tools.ts`. As consultas ficam em `sync/src/queries.ts`, compartilhadas com a API do app.
- **Ferramenta nova:**
  1. Escreva uma função em `queries.ts`, com o schema dos parâmetros em `SCHEMAS`.
  2. Registre-a em `tools.ts`, com uma descrição que diga ao modelo quando usar e com as anotações (`READ` ou `WRITE`).
  3. Teste em `sync/test/mcp.integration.test.ts`.
- **Nunca:** SQL livre, acesso ao `raw` ou escrita fora da camada do usuário. Ferramenta de escrita diz "GRAVA" na descrição e pede que o modelo só use depois de o usuário concordar.
- **stdout é só do protocolo:** qualquer log vai para o stderr.
