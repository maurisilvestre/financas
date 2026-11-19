// "A pagar até o próximo salário" (função pura, sem banco): o que já foi pago, o que falta pagar,
// o que atrasou e se o saldo de cada conta cobre. As faturas e as contas fixas chegam prontas de
// queries.ts (aPagar); aqui só se decide a situação e se somam os valores, em centavos.
import { centavos, reais } from './previsao.ts';

/** a_confirmar: venceu, mas o banco ainda não mandou dados desse dia em diante (pode ter saído e ainda não chegou). */
export type Situacao = 'paga' | 'a_pagar' | 'atrasada' | 'a_confirmar';

export interface ItemBruto {
  /** fatura = fechada (valor exato); fatura_aberta = estimativa do que já foi gasto no ciclo. */
  tipo: 'fatura' | 'fatura_aberta' | 'conta_fixa';
  id: number | null;
  descricao: string;
  /** Conta de onde sai o pagamento (null: não informada; entra só no total). */
  conta_id: number | null;
  vencimento: string;
  /** Total da fatura, a estimativa da aberta ou o esperado da conta fixa (null: sem valor conhecido). */
  valor: string | null;
  /** Quanto já saiu para este vencimento (pagamento que está nos dados do banco). */
  pago: string;
  pago_em: string | null;
  /** O usuário marcou "já paguei" (o pagamento não foi reconhecido pela descrição). */
  pago_manual: boolean;
  /** Quando o usuário marcou (ISO); se foi depois da última atualização do banco, o saldo ainda não mostra. */
  marcado_em?: string | null;
  /** Conta fixa em débito automático: passado o vencimento, conta como paga. */
  debito_automatico?: boolean;
}

export interface Item {
  tipo: ItemBruto['tipo'];
  id: number | null;
  descricao: string;
  conta_id: number | null;
  vencimento: string;
  /** Paga: o que saiu; senão, o que falta pagar. */
  valor: string | null;
  situacao: Situacao;
  pago_em: string | null;
  estimado: boolean;
  /** Paga por débito automático, presumida: o vencimento passou, mas o banco ainda não mostrou. */
  presumida: boolean;
  /** Paga, mas o saldo do banco (da última atualização) ainda não mostra: sai do saldo. */
  fora_do_saldo: boolean;
}

export interface ContaSaldo {
  id: number;
  conta: string;
  saldo: string;
  /** Até que dia o banco mandou dados (a última atualização da Pluggy); o saldo também é desse momento. */
  dados_ate?: string | null;
  /** O instante dessa atualização (ISO). */
  atualizado_em?: string | null;
}

export interface Entrada {
  hoje: string;
  /** Data do último salário: o que foi pago antes dela é do ciclo anterior e sai da lista. */
  inicio_ciclo: string;
  /** Não pago que venceu antes disto sai da lista (atraso velho demais para ser deste ciclo). */
  limite_atraso: string;
  contas: ContaSaldo[];
  itens: ItemBruto[];
}

const cent = (v: string | null) => (v === null ? 0n : centavos(v));

function classificar(b: ItemBruto, hoje: string, conta: ContaSaldo | undefined): Item {
  const dadosAte = conta?.dados_ate ?? null;
  const atualizadoEm = conta?.atualizado_em ?? null;
  const comum = {
    tipo: b.tipo, id: b.id, descricao: b.descricao, conta_id: b.conta_id, vencimento: b.vencimento, pago_em: b.pago_em,
    estimado: false, presumida: false, fora_do_saldo: false,
  };
  const pago = cent(b.pago);
  // O banco ainda não mandou dados do dia do vencimento em diante (ou não se sabe).
  const semDadosDoDia = dadosAte === null || b.vencimento >= dadosAte;
  // Não pago: a pagar; já vencido, atrasado, a não ser que o banco ainda não tenha mandado os dados do vencimento.
  const vencida = (): Situacao => (b.vencimento >= hoje ? 'a_pagar' : dadosAte !== null && b.vencimento >= dadosAte ? 'a_confirmar' : 'atrasada');
  if (b.tipo === 'fatura_aberta') return { ...comum, valor: b.valor, situacao: 'a_pagar', estimado: true };
  if (b.tipo === 'fatura') {
    const falta = cent(b.valor) - pago;
    if (falta <= 0n) return { ...comum, valor: b.valor, situacao: 'paga' };
    return { ...comum, valor: reais(falta), situacao: vencida() };
  }
  if (pago > 0n) return { ...comum, valor: reais(pago), situacao: 'paga' };
  if (b.pago_manual) {
    // Fora do saldo só se foi marcado depois da última atualização do banco e venceu do dia dela em
    // diante. Se o banco já tinha os dados do vencimento, o pagamento provavelmente está lá com
    // outra descrição (um Pix sem nome), e o saldo já o mostra.
    const depois = !!b.marcado_em && atualizadoEm !== null && Date.parse(b.marcado_em) > Date.parse(atualizadoEm);
    return { ...comum, valor: b.valor, situacao: 'paga', fora_do_saldo: depois && semDadosDoDia };
  }
  // Débito automático com o vencimento passado: pago, a não ser que o banco já tenha mandado os dados
  // daquele dia e o débito não estava lá (aí falhou: atrasada).
  if (b.debito_automatico && b.vencimento <= hoje && semDadosDoDia) {
    return { ...comum, valor: b.valor, situacao: 'paga', presumida: true, fora_do_saldo: true };
  }
  return { ...comum, valor: b.valor, situacao: vencida() };
}

export function resumirAPagar(e: Entrada) {
  const porId = new Map(e.contas.map((c) => [c.id, c]));
  const itens = e.itens
    .map((b) => classificar(b, e.hoje, b.conta_id === null ? undefined : porId.get(b.conta_id)))
    // O que foi pago antes do salário é do ciclo anterior, a não ser que ainda falte sair do saldo.
    .filter((i) => (i.situacao === 'paga' && !i.fora_do_saldo ? i.vencimento >= e.inicio_ciclo : i.vencimento >= e.limite_atraso))
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.descricao.localeCompare(b.descricao, 'pt-BR'));
  const abertos = itens.filter((i) => i.situacao !== 'paga');
  const jaSaiu = itens.filter((i) => i.fora_do_saldo);
  const soma = (xs: Item[]) => xs.reduce((s, i) => s + cent(i.valor), 0n);

  const contas = e.contas.map((c) => {
    const banco = centavos(c.saldo);
    const saiu = soma(jaSaiu.filter((i) => i.conta_id === c.id));
    const saldo = banco - saiu;
    const daConta = abertos.filter((i) => i.conta_id === c.id);
    // Em que dia o dinheiro da conta acaba, pagando tudo na ordem dos vencimentos.
    let resta = saldo;
    let acaba: { data: string; descricao: string } | null = null;
    for (const i of daConta) {
      resta -= cent(i.valor);
      if (resta < 0n && !acaba) acaba = { data: i.vencimento, descricao: i.descricao };
    }
    const sai = soma(daConta);
    return {
      id: c.id, conta: c.conta, saldo_banco: reais(banco), ja_saiu: reais(saiu), saldo: reais(saldo),
      a_pagar: reais(sai), sobra: reais(saldo - sai), acaba_em: acaba, dados_ate: c.dados_ate ?? null,
    };
  });

  const banco = e.contas.reduce((s, c) => s + centavos(c.saldo), 0n);
  const saiu = soma(jaSaiu);
  const aPagar = soma(abertos);
  return {
    itens, contas, saldo_banco: reais(banco), ja_saiu: reais(saiu), saldo: reais(banco - saiu),
    a_pagar: reais(aPagar), sobra: reais(banco - saiu - aPagar),
  };
}
