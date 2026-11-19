# Sugestões de categoria por IA (opcional)

Depois de cada sync, o Claude Haiku sugere uma categoria para cada estabelecimento que nenhuma regra pegou. **Nada muda nos relatórios** até você aplicar a sugestão na tela Sugestões.

## Ligar

1. Crie uma chave em [platform.claude.com](https://platform.claude.com) → API Keys. O uso é cobrado pela Anthropic.
2. Rode `./scripts/configurar.sh` no seu terminal e informe a chave, ou ponha em `ANTHROPIC_API_KEY` no `.env`. Opcionalmente, informe em `CLASSIFY_OWNER_NAME` o seu nome como aparece nos Pix, para a IA reconhecer as transferências entre as suas contas.
3. Rode `docker compose up -d` para o sync pegar a chave.
4. Para classificar já: `docker compose run --rm sync classify`.

Para desligar sem tirar a chave: `CLASSIFY_AFTER_SYNC=false`.

## O que vai para a Anthropic

- Só **descrição, valor e data** de uma transação por estabelecimento (a mais recente), mais os nomes das categorias e, se você configurar, o seu nome.
- **Não vai** conta, número de cartão, id interno, CPF nem o payload da Pluggy. Há teste que confere os campos.
- A chave só existe no `.env` e no container do `sync`. O app web e o MCP não a recebem.

## Descrições maliciosas

As descrições vêm de terceiros, e o texto de um Pix é livre. As defesas:

- O prompt diz que as descrições são dados e que instruções dentro delas devem ser ignoradas.
- Descrição com cara de instrução vai sozinha num pedido, para não influenciar as outras, e fica com no máximo 50% de confiança.
- "Aplicar todas" só aplica gasto em saída de dinheiro e receita em entrada. Movimentações (fatura, investimento, transferência) e sugestões que não combinam com o sinal do valor ficam marcadas "confira", para você aplicar uma a uma.

## Custo

A primeira rodada manda cada estabelecimento sem categoria uma vez, em lotes de 40; depois, cada sync só manda o que for novo. Com um modelo pequeno como o Haiku, algumas centenas de estabelecimentos custam centavos de dólar. O log do `sync` mostra os tokens de cada rodada. O modelo fica em `CLASSIFY_MODEL`.

## Como funciona

- A sugestão fica em `fin.category_suggestions`, uma por estabelecimento. A chave é a descrição sem números, então "Loja 3/10" e "Loja 4/10" contam como o mesmo estabelecimento.
- Quando a IA não tem segurança, ela não sugere nada.
- Sugestão recusada não volta.
- Ao aplicar, as transações ganham a categoria como escolha sua. Para valer também para as próximas, use "Regra".
