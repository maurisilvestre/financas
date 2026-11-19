# O app web

Abra **http://127.0.0.1:8737**. O serviço `web` sobe junto com o resto (`docker compose up -d`) e responde só na sua máquina. Ele também funciona no celular; para abrir de outro aparelho, veja [servidor.md](servidor.md).

## Telas

### Visão geral

Entrou, saiu e sobrou no mês, comparado com a média dos 3 meses anteriores. O mês em andamento não é comparado com a média, porque ainda está pela metade; nele, no lugar do "Sobrou", aparece quanto vai faltar ou sobrar até o próximo salário (da tela A pagar).

- **Cartão × conta:** quanto saiu nos cartões de crédito e quanto na conta, cada cartão separado.
- **Últimos 12 meses:** cartão × conta ou entrou × saiu. Clique num mês para abri-lo.
- **Para onde foi o dinheiro:** gastos por categoria (cartões, conta ou tudo), com um traço na média.
- **Parcelas** dos próximos meses.
- **Meta do cartão à vista:** quanto você quer gastar por mês no cartão sem parcelar. Mostra o gasto até hoje, o ritmo ideal, a projeção para o fim do mês, quanto ainda dá para gastar por dia e o acumulado dia a dia comparado com o mês anterior.

### A pagar

Do último salário ao próximo: o saldo das contas correntes contra o que ainda sai delas.

- **Faturas:** a fechada conta como paga quando o pagamento chega no cartão ou quando sai da conta corrente do mesmo banco o valor exato dela, perto do vencimento (débito automático). A aberta que vence antes do salário entra pelo que já foi gasto nela.
- **Contas fixas:** você cadastra na própria tela o nome, o dia, um trecho da descrição do pagamento ("contém", reconhece em qualquer banco), o valor (opcional; sem ele vale o do mês anterior) e a conta de onde sai.
- **Situações:** paga, a pagar, atrasada e "a confirmar", quando venceu mas a Pluggy ainda não trouxe os dados do banco desse dia.
- **Débito automático:** passado o vencimento, a conta conta como paga, e o valor sai do saldo mostrado até o banco mostrar o débito. Se o banco mostrar o dia sem o débito, volta a "atrasada".
- **Já paguei:** para o pagamento que não foi reconhecido (um Pix sem descrição, por exemplo).
- **Por conta:** quanto sai, se sobra ou falta e em que dia o dinheiro acaba.

O próximo salário é estimado como um mês depois do último crédito do tipo salário que o banco informou.

### Transações

Busca e filtros por período, categoria, cartão ou conta, conta específica e tipo. Os filtros ficam na URL, então dá para salvar o link. Em cada linha você troca a categoria, cria uma regra a partir da transação (com prévia de quantas ela pega) ou tira a transação dos relatórios ("Ignorar", com desfazer).

### Sugestões

Categorias sugeridas pela IA, uma linha por estabelecimento. Você aplica (pode trocar a categoria antes), cria uma regra ou recusa. As de confiança alta dá para aplicar de uma vez. Veja [ia.md](ia.md).

### Recorrentes

Assinaturas, mensalidades e contas fixas, com o custo por mês e por ano. São os candidatos a corte.

### Parcelas

Quanto falta pagar, quanto pesa em cada mês e cada parcelamento em aberto. Compras parceladas dos últimos 30 dias aparecem num alerta.

### Posso comprar?

O limite do cartão não diz se uma compra cabe. A previsão projeta os próximos meses (de 1 a 4 anos) com o que costuma entrar e sair, e diz se a compra cabe, quando cabe e quanto cortar para caber.

**Como a previsão é feita** (meses completos, sem o atual):

- **Entradas e cartão à vista:** média dos últimos 6 meses.
- **Contas pagas na conta** (débito, Pix, boletos): média dos últimos 3 meses, para pegar o valor atual das contas fixas.
- **Parcelas:** exatas, mês a mês.
- **Gastos planejados:** o que você já decidiu e ainda não aconteceu, até marcar como realizado ou cancelado.
- **Objetivos:** cada um tem um valor, quanto já está guardado e quanto guardar por mês a partir de quando. Só se guarda o que sobra: a sobra do mês primeiro cobre o saldo negativo dos meses anteriores, e o que passar disso vai para os objetivos, até o aporte planejado. Se não sobra, o objetivo atrasa.
- **Fora da média:** o que você excluir (uma categoria inteira ou um trecho da descrição, como uma assinatura cancelada) e gastos ou entradas de R$ 2.000 ou mais que aconteceram uma vez só na janela.

**O saldo começa em zero no mês atual.** O guardado (seus investimentos, como a Pluggy informa) aparece à parte: quanto há hoje, como ele evolui com a sobra de cada mês, o ponto mais baixo, se acaba e a partir de quando fica tranquilo.

**O veredito:**

- **cabe:** o saldo de nenhum mês seguinte fica abaixo da margem de R$ 1.000, e a compra não tira nada dos objetivos;
- **no limite:** o saldo fica entre zero e a margem;
- **não cabe:** o saldo fica negativo, ou a compra tiraria do que iria para os objetivos. A tela diz a partir de quando cabe e quanto cortar por mês para caber no mês pedido.

As parcelas ficam fora da meta do cartão à vista, mas entram na previsão mês a mês. O cenário "Cartão pela meta" troca a média do cartão à vista pela sua meta.

## Sincronizar

O botão no topo pede um sync ao serviço `sync`, que confere os pedidos a cada 10 segundos. No fim, o app diz o que chegou; sem nada novo, mostra quando a Pluggy atualizou cada banco.

## Desenvolver o front

Vue 3 + Vite, em `web/`, com recarga automática. A API continua sendo o serviço `web` do compose:

```bash
cd web && npm ci
npm run dev        # http://127.0.0.1:5173 (repassa /api para 127.0.0.1:8737)
npm test           # funções puras (formatação, rotas, gráficos)
```

Depois de mudar o front ou a API: `docker compose up -d --build`.
