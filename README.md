# Finanças

App de finanças pessoais que roda na sua máquina. Ele lê as suas contas e os seus cartões pelo **Open Finance Brasil** (via [Meu Pluggy](https://meu.pluggy.ai)), guarda tudo num Postgres local, com histórico permanente, e ajuda a responder perguntas do dia a dia:

- Para onde foi o dinheiro este mês?
- O que ainda falta pagar até o próximo salário, e o saldo dá?
- Posso fazer esta compra? Se não, a partir de quando, e o que cortar?
- Quais assinaturas e contas fixas pesam mais?

Os seus dados ficam no seu computador. Nada é enviado a terceiros, a não ser que você ligue as sugestões de categoria por IA, que mandam só descrição, valor e data.

*English: a self-hosted personal finance app for Brazilian Open Finance (via Meu Pluggy), with a local Postgres, a web app, AI-assisted categorization and an MCP server for Claude. The documentation is in Portuguese.*

## O que tem

- **Sync automático** com a Pluggy, duas vezes por dia, sem apagar nada: o histórico além dos 12 meses que a Pluggy devolve fica só com você.
- **App web** (funciona no celular):
  - **Visão geral:** mês a mês, cartão × conta e gastos por categoria.
  - **Meta do cartão à vista:** quanto gastar por mês no cartão sem parcelar.
  - **A pagar:** faturas e contas fixas até o próximo salário.
  - **Transações:** busca com filtros e categorização na própria linha.
  - **Recorrentes:** assinaturas, mensalidades e contas fixas.
  - **Parcelas:** o que já está comprometido nos próximos meses.
  - **Posso comprar?:** previsão de 1 a 4 anos, objetivos e simulação de compra.
- **Categorias e regras** que recategorizam o histórico inteiro na hora.
- **Sugestões de categoria por IA** (opcional, Claude Haiku). Nada muda até você aplicar.
- **MCP** para conversar com os seus dados no Claude Desktop ou no Claude Code: 10 ferramentas de leitura, 8 de escrita com confirmação e 4 prompts prontos ([guia](docs/mcp.md)).
- **Backup diário** criptografado com [age](https://age-encryption.org).
- **Servidor em casa** (opcional): publica num PC com Linux e abre no celular pelo Tailscale.

## Requisitos

- Docker com Compose v2 (Docker Desktop no macOS e no Windows com WSL 2; Docker Engine no Linux).
- Conta no Meu Pluggy com os seus bancos conectados, e uma aplicação no Dashboard da Pluggy ([passo a passo](docs/pluggy.md)).
- Opcionais: chave da API da Anthropic (sugestões por IA), `age` (backup criptografado), Tailscale (acesso de outros aparelhos).

## Instalar

**Com uma IA:** se você usa um agente que roda comandos (como o Claude Code), cole o prompt de [INSTALAR-COM-IA.md](INSTALAR-COM-IA.md). Ele faz quase tudo e deixa com você só o que é seu: as contas nos sites e as credenciais.

**À mão:**

```bash
git clone https://github.com/maurisilvestre/financas.git
cd financas
./scripts/configurar.sh                 # cria o .env, gera as senhas e pergunta as credenciais da Pluggy
docker compose build
docker compose run --rm sync check      # testa a conexão com a Pluggy e lista as contas
docker compose up -d                    # sobe tudo; o primeiro sync busca 12 meses
```

Abra **http://127.0.0.1:8737**. Depois do primeiro sync, faça as conferências de [docs/operacao.md](docs/operacao.md#conferir-com-os-seus-dados).

A parte que mais trava é a da Pluggy: criar a aplicação, conectar pelo MeuPluggy e copiar os ids. O [guia da Pluggy](docs/pluggy.md) tem o passo a passo com os nomes de cada tela e o que fazer quando algo não bate.

## Conversar com os seus dados (MCP)

O servidor MCP deixa o Claude consultar os seus dados e responder com os seus números: "para onde foi o dinheiro este mês?", "quais assinaturas dá para cortar?", "posso comprar isto em 10x?". Há prompts prontos (posso comprar, equilibrar objetivos, dicas de economia, categorizar pendentes). As ferramentas de escrita só mexem nas suas categorias, regras e planos, sempre com a sua confirmação.

No Claude Code, na pasta do projeto:

```bash
claude mcp add --scope user financas -- docker compose --project-directory "$PWD" run --rm -T mcp
```

O [guia do MCP](docs/mcp.md) cobre:

- o Claude Desktop (macOS, Windows e WSL) e o app num servidor por SSH;
- todas as ferramentas e prompts;
- o contexto da sua casa para o Claude;
- o que vai para o provedor do modelo e os problemas comuns.

## Documentação

| Guia | Assunto |
|------|---------|
| [docs/pluggy.md](docs/pluggy.md) | conectar os bancos e pegar as credenciais |
| [docs/app.md](docs/app.md) | as telas do app e como a previsão é feita |
| [docs/operacao.md](docs/operacao.md) | comandos do dia a dia, regras de categoria, conferências e problemas comuns |
| [docs/ia.md](docs/ia.md) | sugestões de categoria por IA: o que vai para a Anthropic e as defesas |
| [docs/mcp.md](docs/mcp.md) | conversar com os dados no Claude |
| [docs/backup.md](docs/backup.md) | backup criptografado e restore |
| [docs/servidor.md](docs/servidor.md) | rodar num servidor em casa e abrir no celular |
| [docs/arquitetura.md](docs/arquitetura.md) | serviços, dados, como o sync decide as coisas e testes |

## Segurança e privacidade

- O banco e o app escutam só em `127.0.0.1`. O app não tem login: para abrir de outro aparelho, use um proxy dentro da sua rede privada ([servidor.md](docs/servidor.md)), nunca a internet aberta.
- A API se defende de outros sites abertos no navegador: checa `Host` e `Origin`, aceita escrita só com JSON, não tem CORS e manda uma CSP restrita.
- As credenciais ficam só no `.env`, que não vai para o git. Os logs não mostram segredos nem ids completos.
- O MCP e o app leem com um papel só de leitura e gravam com um papel que só mexe nas suas categorias, regras e planos. Nunca apagam nada nem tocam nos dados do banco.

Mais detalhes, e como reportar uma vulnerabilidade, em [SECURITY.md](SECURITY.md).

## Contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md). Nunca inclua dados reais (descrições, valores, nomes, prints) em issues, testes ou pull requests.

## Aviso

Projeto pessoal, sem garantia. Não é aconselhamento financeiro nem de investimentos, e não tem vínculo com a Pluggy, com os bancos nem com a Anthropic. Confira os números com o app do seu banco antes de tomar decisões.

## Licença

[MIT](LICENSE).
