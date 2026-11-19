# Pluggy: conectar seus bancos

O app lê as suas contas pelo **Meu Pluggy**, o serviço da [Pluggy](https://pluggy.ai) para pessoas físicas lerem os próprios dados pelo Open Finance Brasil. Você autoriza cada banco uma vez no Meu Pluggy. Depois, o app busca os dados pela API da Pluggy, com credenciais que só existem no seu `.env`.

Para uso pessoal, o conector **MeuPluggy** é gratuito, não exige análise da empresa e não expira com o período de teste do Dashboard. O limite é de **até 5 conexões**, sem uso comercial ([guia oficial](https://docs.pluggy.ai/pt/docs/guides/meu-pluggy-personal-use)). Para uma empresa ler dados de clientes, o caminho é outro: a integração comercial da Pluggy.

## O que você vai precisar

| No `.env`              | O que é                                          | Onde aparece |
|------------------------|--------------------------------------------------|--------------|
| `PLUGGY_CLIENT_ID`     | identificador da sua aplicação                   | Dashboard → **Aplicações**, na linha da sua aplicação |
| `PLUGGY_CLIENT_SECRET` | senha da sua aplicação (segredo)                 | só uma vez, ao criar a aplicação ou ao gerar um novo |
| `PLUGGY_ITEM_IDS`      | um id por banco conectado, separados por vírgula | Dashboard → **Aplicações → sua aplicação → Demo → Itens Conectados** |

## Passo a passo

### 1. Conecte os bancos no Meu Pluggy

1. Crie a sua conta em [meu.pluggy.ai](https://meu.pluggy.ai).
2. Conecte cada banco. A autorização é do Open Finance: você informa o CPF, o Meu Pluggy abre o app ou o site do banco, e você aprova lá.
3. Cada banco é autorizado separadamente. Um banco que você adicionar depois precisa da própria autorização.

### 2. Crie a aplicação no Dashboard

1. Entre em [dashboard.pluggy.ai](https://dashboard.pluggy.ai) **com a mesma conta** do Meu Pluggy.
2. Em **Aplicações**, crie uma aplicação.
3. Anote o **Client Secret** na hora. Ele é exibido **uma vez só** e não pode ser visto de novo, nem pelo Dashboard nem pela API.
   - Perdeu? Na página da aplicação, use **Gerar novo secret**. O antigo para de funcionar na hora, então atualize o `.env`.
4. O **Client ID** fica sempre visível na lista de **Aplicações**.

Guarde o Client Secret no seu gerenciador de senhas até o passo 4.

### 3. Crie os items com o conector MeuPluggy

1. **Habilite o conector, se precisar.** Se o seu time usa uma seleção personalizada de conectores, vá em **Customização → Conectores**, procure `MeuPluggy` (aba **Conectores Diretos**, grupo **Pessoal**) e habilite-o. Na seleção padrão, ele já aparece.
2. Abra **Aplicações → sua aplicação → Demo** e clique em **Conectar Conta**.
3. Na janela que abrir, escolha **MeuPluggy** e entre com a sua conta do Meu Pluggy.
   - Não escolha o conector do seu banco nem o Sandbox.
   - **O erro mais comum:** se o Dashboard pedir o CPF e a aprovação do banco de novo, você escolheu o conector do banco em vez do MeuPluggy. Volte e escolha MeuPluggy.
4. Cada banco que você conectou no Meu Pluggy vira um **item** em **Itens Conectados**, na mesma página. Confira se há um item para cada banco.
5. Clique em cada item e copie o **itemId**, que tem um botão de copiar. Anote todos: a API não lista os items do Meu Pluggy depois.

### 4. Ponha tudo no `.env`

No seu terminal, na pasta do projeto:

```bash
./scripts/configurar.sh
```

Ele pergunta o Client ID, o Client Secret (sem mostrar na tela enquanto você digita) e os ids dos items, separados por vírgula. Também gera as senhas do banco, se ainda não existirem.

Não cole essas informações em chats, issues ou prints. Se você usa uma IA para instalar, rode o script você mesmo; o prompt de [INSTALAR-COM-IA.md](../INSTALAR-COM-IA.md) já pede isso.

### 5. Teste

```bash
docker compose build
docker compose run --rm sync check
```

O esperado:

```text
✔ Credenciais da Pluggy OK

Item 1a2b3c4d…
  conector: MeuPluggy | status: UPDATED/SUCCESS
  atualizado com o banco: 2026-01-15T14:00:00.000Z | consentimento expira: 2027-01-10T12:00:00.000Z
  - BANK/CHECKING_ACCOUNT: Conta Corrente (final 1234)
  - CREDIT/CREDIT_CARD: Cartão Exemplo (final 5678)
```

Os ids aparecem cortados e as contas, só com os 4 últimos dígitos.

Depois, `docker compose up -d` sobe tudo. O primeiro sync busca os últimos 12 meses.

## Quando algo não bate

| Sintoma no `check` | O que fazer |
|--------------------|-------------|
| credenciais recusadas | Confira o Client ID e o Client Secret. Gerou um secret novo? O antigo parou de funcionar. Apague a linha no `.env` e rode `./scripts/configurar.sh` de novo. |
| `HTTP 404` num item | O itemId está errado ou é de outra aplicação. Copie de novo em **Demo → Itens Conectados**. |
| item sem contas | O item não é do conector MeuPluggy, ou o banco ainda não terminou a primeira atualização. Confira o conector na linha do item. |
| status diferente de `UPDATED` | A Pluggy está atualizando ou o banco recusou. Espere alguns minutos; se continuar, abra o Meu Pluggy e veja a conexão daquele banco. |
| falta um banco | Ele não foi conectado no Meu Pluggy, ou não virou item. Conecte no Meu Pluggy e clique em **Conectar Conta** no Demo de novo. |

## Bom saber

- **Frequência:** o Meu Pluggy atualiza cada banco uma vez a cada 24 horas, e os items não podem ser atualizados manualmente pela API. O sync só traz o que o Meu Pluggy já buscou. Para buscar na hora, atualize a conexão no site do Meu Pluggy e clique em **Sincronizar** no app.
- **Autorização da aplicação:** o login do Meu Pluggy no Demo autoriza a sua aplicação por **um ano**. O sync avisa quando faltam 30 dias; a data aparece no `docker compose run --rm sync status` e na ferramenta `contas` do MCP.
  - Ao vencer, as leituras voltam vazias e o item passa a dar erro de autorização. O app não apaga nada quando a resposta vem vazia.
  - Para renovar, repita o passo 3 (**Demo → Conectar Conta → MeuPluggy**). Não dá para renovar pela API.
  - A renovação pode gerar **itemIds novos**. Troque-os em `PLUGGY_ITEM_IDS`; o app religa as contas sozinho e o histórico continua.
- **Consentimento com cada banco:** é separado da autorização da aplicação e segue as regras do Open Finance. Renove pelo Meu Pluggy quando o banco pedir.
- **Histórico:** a Pluggy devolve no máximo 12 meses. O que for mais antigo existe só no seu banco de dados, e por isso o [backup](backup.md) importa.
- **Testar sem dados reais:** o conector **Sandbox** da Pluggy tem dados de teste (as credenciais estão no guia de sandbox da Pluggy). É útil para quem quer contribuir sem usar as próprias contas. Uma conexão MeuPluggy é sempre com dados reais.
- **Saindo:** apagar a sua conta no Meu Pluggy encerra a autorização na hora. Apague também a aplicação no Dashboard, se não for mais usar.
- **Suporte do Meu Pluggy:** meu-suporte@pluggy.ai, a partir do e-mail da sua conta.
