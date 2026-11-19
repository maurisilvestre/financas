# Como contribuir

Obrigado pelo interesse. Issues e pull requests são bem-vindos, em português.

## Antes de tudo: nada de dados reais

Este app lida com dados financeiros. Em issues, pull requests, testes, prints e logs, **nunca** inclua:

- descrições de transações, valores, nomes de pessoas ou de estabelecimentos tirados do seu extrato;
- ids de item ou de conta da Pluggy, números de cartão ou de conta, CPF;
- o conteúdo do `.env`, chaves ou backups.

Nos testes, use dados inventados ("LOJA EXEMPLO", "Fulano de Tal", valores redondos). Para mostrar um problema, descreva o formato ("a descrição vem como `PAGTO X - DOCTO: <número>`") em vez de colar o dado.

## Ambiente

```bash
# Postgres descartável para os testes (nunca rode os testes contra o banco do compose)
docker run --rm -d --name fin-test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:18-alpine

cd sync && npm ci
npm run typecheck
TEST_PG_URL=postgres://postgres@127.0.0.1:55432/postgres npm test

cd ../web && npm ci
npm test
npm run dev      # http://127.0.0.1:5173, com a API do compose em 127.0.0.1:8737
```

Node 24 roda o TypeScript direto (type stripping), sem build no backend.

## Convenções

As regras completas estão em [CLAUDE.md](CLAUDE.md), que também serve de guia para quem contribui com ajuda de IA. As principais:

- **Dependências mínimas e com versão fixa.** Pergunte numa issue antes de adicionar uma.
- **Migrations:** SQL puro em `db/migrations/NNNN_nome.sql`. Migration aplicada nunca é editada (o runner recusa checksum diferente): mudança é sempre um arquivo novo.
- **Leitura pelas views**, não pelas tabelas. Consulta nova da API ou do MCP é uma função nova em `sync/src/queries.ts`.
- **Dinheiro** é `numeric` no banco e texto no código, nunca float.
- **O sync nunca escreve na camada do usuário** (categorias, regras, metas, planos).
- **Lógica pura com teste:** previsão, a pagar e as funções do front têm testes sem banco; o resto, testes de integração.
- **Textos para o usuário** em português do Brasil.

## Pull requests

- Um assunto por PR, com testes do que mudou.
- `npm run typecheck` e os testes dos dois pacotes passando.
- Se mudar algo visível, descreva o antes e o depois (prints só com dados inventados).
- Mudanças nas defesas de segurança (Host, Origin, CSP, papéis do banco, o que vai para a IA) precisam de justificativa e de teste.
