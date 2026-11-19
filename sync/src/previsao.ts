// Previsão mês a mês e veredito de uma compra ("guardião do compra ou não compra").
//
// Recebe a base de cada mês (entradas, gastos fixos da conta, cartão à vista, parcelas, gastos
// planejados e o aporte planejado dos objetivos, já calculados no banco) e projeta a sobra, quanto
// vai de fato para os objetivos, o saldo acumulado, quanto dá para gastar à vista sem que o saldo
// fique negativo depois e quanto ainda dá para guardar por mês. Contas em centavos inteiros (bigint).
//
// Objetivos: só se guarda o que sobra. A sobra do mês primeiro cobre o saldo negativo dos meses
// anteriores; o que passar disso vai para os objetivos, até o planejado; o resto fica no saldo.
// Se não sobra, não guarda, e o objetivo atrasa. Uma compra que tiraria dos objetivos não cabe.
//
// Guardado (opcional): o que está nos investimentos hoje. Não entra no saldo nem no veredito (o
// saldo começa na reserva); serve para ver por quanto tempo ele cobre os meses negativos: o guardado
// de cada mês é o de hoje mais a sobra acumulada (o que falta sai dele; o que sobra volta).
import { UserError } from './errors.ts';

export interface MesBase {
  mes: string;
  entradas: string;
  gastos_conta: string;
  cartao_avista: string;
  parcelas: string;
  planejados: string;
  /** Quanto os objetivos pedem neste mês (reserva, viagem...). Só vai para eles o que sobrar. */
  guardar_planejado: string;
}

export interface CompraSimulada {
  valor: string;
  parcelas: number;
  mes: string;
}

export interface OpcoesProjecao {
  /** Dinheiro guardado que pode ser usado (entra no saldo do 1º mês). */
  reserva: string;
  /** Saldo mínimo para a compra "caber" com folga; abaixo dele é "no limite". */
  margem: string;
  /**
   * Quantos meses devolver (padrão: todos). Os meses a mais servem só para as parcelas de uma
   * compra que passam do horizonte exibido entrarem no veredito e no "a partir de".
   */
  exibir?: number;
  compra?: CompraSimulada;
  /** O que está guardado hoje (investimentos): só para projetar o guardado, fora do veredito. */
  guardado?: string;
}

export type Veredito = 'cabe' | 'no_limite' | 'nao_cabe';

export interface MesProjetado extends MesBase {
  /** O que fica do mês antes de guardar: entradas − conta − cartão à vista − parcelas − planejados. */
  sobra: string;
  /** Quanto vai de fato para os objetivos: o planejado, se sobrar; senão, o que sobrar, ou nada. */
  guardar: string;
  /** Dinheiro livre acumulado, depois de guardar. */
  saldo: string;
  capacidade_avista: string;
  /** Quanto dá para guardar por mês, a partir deste, sem o saldo de nenhum mês exibido ficar abaixo da margem. */
  aporte_maximo: string;
  /** Só com compra simulada. */
  compra?: string;
  sobra_com_compra?: string;
  guardar_com_compra?: string;
  saldo_com_compra?: string;
  /** Só com guardado informado: o guardado de hoje mais a sobra acumulada até este mês. */
  guardado?: string;
  guardado_com_compra?: string;
}

/** Até onde o guardado chega no horizonte exibido. */
export interface ResumoGuardado {
  inicial: string;
  menor: string;
  mes_menor: string;
  /** 1º mês em que o guardado fica negativo (não dá para cobrir o que falta); null se nunca. */
  acaba_em: string | null;
  /** 1º mês a partir do qual a sobra não fica mais negativa no horizonte; null se não chega. */
  tranquilo_em: string | null;
}

export interface ResultadoCompra {
  valor: string;
  parcelas: number;
  mes: string;
  veredito: Veredito;
  menor_saldo: string;
  mes_menor_saldo: string;
  a_partir_de: string | null;
  corte_mensal: string | null;
  /** Quanto a compra tiraria do que iria para os objetivos (somando todos os meses). */
  tira_dos_objetivos: string;
  /** Só com guardado informado: até onde ele chega com a compra. */
  guardado?: Omit<ResumoGuardado, 'inicial' | 'tranquilo_em'>;
}

export interface Projecao {
  meses: MesProjetado[];
  compra: ResultadoCompra | undefined;
  guardado?: ResumoGuardado;
}

/** O guardado mês a mês (o de hoje mais a sobra acumulada) e até onde ele chega. */
function trajetoGuardado(inicial: bigint, sobras: bigint[], meses: string[]) {
  let acum = inicial;
  const caminho = sobras.map((x) => (acum += x));
  const menor = minimo(caminho);
  const iAcaba = caminho.findIndex((g) => g < 0n);
  let iTranquilo = sobras.length;
  while (iTranquilo > 0 && sobras[iTranquilo - 1]! >= 0n) iTranquilo--;
  return {
    caminho,
    resumo: {
      menor: reais(menor), mes_menor: meses[caminho.indexOf(menor)]!,
      acaba_em: iAcaba < 0 ? null : meses[iAcaba]!,
      tranquilo_em: iTranquilo < sobras.length ? meses[iTranquilo]! : null,
    },
  };
}

/** "1234.5" → 123450n. Aceita sinal e até 2 casas. */
export function centavos(valor: string | number): bigint {
  const s = typeof valor === 'number' ? valor.toFixed(2) : valor.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`valor inválido: ${s}`);
  const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -c : c;
}

/** 123450n → "1234.50". */
export function reais(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

const minimo = (xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const maximo = (a: bigint, b: bigint) => (b > a ? b : a);
const soma = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** Valor de cada parcela, em centavos; a 1ª leva o resto da divisão. */
function dividir(total: bigint, n: number): bigint[] {
  const base = total / BigInt(n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? total - base * BigInt(n - 1) : base));
}

/** Compra começando no mês `inicio`: quanto sai em cada mês do horizonte. */
function desembolso(total: bigint, n: number, inicio: number, meses: number): bigint[] {
  const out = Array.from({ length: meses }, () => 0n);
  dividir(total, n).forEach((v, k) => { if (inicio + k < meses) out[inicio + k] = v; });
  return out;
}

interface Fluxo {
  guardar: bigint[];
  saldo: bigint[];
}

/**
 * Mês a mês: a sobra primeiro cobre o saldo negativo, depois vai para os objetivos até o planejado,
 * e o resto fica no saldo. Se não sobra, não guarda.
 */
function acumular(sobra: bigint[], plano: bigint[], inicial: bigint): Fluxo {
  const guardar: bigint[] = [];
  const saldo: bigint[] = [];
  let acum = inicial;
  sobra.forEach((x, i) => {
    const disponivel = acum + x;
    const g = disponivel <= 0n ? 0n : disponivel < plano[i]! ? disponivel : plano[i]!;
    acum = disponivel - g;
    guardar.push(g);
    saldo.push(acum);
  });
  return { guardar, saldo };
}

/**
 * Maior aporte mensal constante, de `i` até o fim, que mantém o saldo de todo mês na margem ou acima:
 * o menor (saldo[m] − margem) ÷ (meses de aporte até m). Zero se o saldo já está abaixo da margem.
 */
function aporteMaximo(saldo: bigint[], i: number, margem: bigint): bigint {
  let max: bigint | null = null;
  for (let m = i; m < saldo.length; m++) {
    const folga = saldo[m]! - margem;
    if (folga <= 0n) return 0n;
    const cabe = folga / BigInt(m - i + 1);
    if (max === null || cabe < max) max = cabe;
  }
  return max ?? 0n;
}

export function projetar(meses: MesBase[], opts: OpcoesProjecao): Projecao {
  const reserva = centavos(opts.reserva);
  const margem = centavos(opts.margem);
  const exibir = Math.min(opts.exibir ?? meses.length, meses.length);

  const sobra = meses.map((m) => centavos(m.entradas) - centavos(m.gastos_conta) - centavos(m.cartao_avista)
    - centavos(m.parcelas) - centavos(m.planejados));
  const plano = meses.map((m) => centavos(m.guardar_planejado));
  const base = acumular(sobra, plano, reserva);
  const saldo = base.saldo;
  const visivel = saldo.slice(0, exibir);
  // Quanto dá para gastar à vista em cada mês sem o saldo de nenhum mês seguinte ficar negativo.
  const capacidade = visivel.map((_, i) => maximo(0n, minimo(visivel.slice(i))));

  const nomes = meses.slice(0, exibir).map((m) => m.mes);
  const guardadoHoje = opts.guardado === undefined ? null : centavos(opts.guardado);
  const trajeto = guardadoHoje === null ? null : trajetoGuardado(guardadoHoje, sobra.slice(0, exibir), nomes);
  const resumoGuardado = trajeto && guardadoHoje !== null ? { inicial: reais(guardadoHoje), ...trajeto.resumo } : undefined;

  const linhas: MesProjetado[] = meses.slice(0, exibir).map((m, i) => ({
    ...m, sobra: reais(sobra[i]!), guardar: reais(base.guardar[i]!), saldo: reais(saldo[i]!), capacidade_avista: reais(capacidade[i]!),
    aporte_maximo: reais(aporteMaximo(visivel, i, margem)),
    ...(trajeto ? { guardado: reais(trajeto.caminho[i]!) } : {}),
  }));
  if (!opts.compra) return { meses: linhas, compra: undefined, guardado: resumoGuardado };

  const { parcelas: n, mes } = opts.compra;
  const total = centavos(opts.compra.valor);
  const s = meses.findIndex((m) => m.mes === mes);
  if (s < 0 || s >= exibir) throw new UserError(`Mês da compra fora da previsão (de ${meses[0]?.mes} a ${meses[exibir - 1]?.mes}).`);
  // Até onde olhar o saldo de uma compra que começa em `ini`: o horizonte exibido ou a última parcela.
  const fim = (ini: number) => Math.min(meses.length, Math.max(exibir, ini + n));

  // A compra começando em `ini`, com um corte mensal desde o 1º mês: o fluxo, quanto tira dos
  // objetivos e o menor saldo até a última parcela (ou o fim do horizonte exibido).
  const avaliar = (ini: number, corte = 0n) => {
    const comCorte = corte === 0n ? sobra : sobra.map((x) => x + corte);
    const sem = corte === 0n ? base : acumular(comCorte, plano, reserva);
    const gasto = desembolso(total, n, ini, meses.length);
    const com = acumular(comCorte.map((x, i) => x - gasto[i]!), plano, reserva);
    const trecho = com.saldo.slice(ini, fim(ini));
    const menor = minimo(trecho);
    return { com, menor, iMenor: ini + trecho.indexOf(menor), tira: soma(sem.guardar) - soma(com.guardar) };
  };
  const cabe = (a: ReturnType<typeof avaliar>) => a.tira === 0n && a.menor >= margem;

  const compra = desembolso(total, n, s, meses.length);
  const pedido = avaliar(s);
  const veredito: Veredito = pedido.menor < 0n || pedido.tira > 0n ? 'nao_cabe' : pedido.menor < margem ? 'no_limite' : 'cabe';

  // Primeiro mês exibido (a partir do pedido) em que a compra cabe com folga, contando todas as parcelas.
  let aPartirDe: string | null = null;
  for (let ini = s; ini < exibir && ini + n <= meses.length; ini++) {
    if (cabe(avaliar(ini))) {
      aPartirDe = meses[ini]!.mes;
      break;
    }
  }

  // Menor corte mensal constante, desde o 1º mês, que faz a compra caber com folga no mês pedido
  // (sem tirar dos objetivos). Busca binária em centavos; o teto sempre basta.
  let corte: bigint | null = null;
  if (veredito !== 'cabe') {
    let lo = 1n;
    let hi = margem + total + soma(plano) + soma(sobra.map((x) => (x < 0n ? -x : 0n))) + 1n;
    while (!cabe(avaliar(s, hi))) hi *= 2n;
    while (lo < hi) {
      const meio = (lo + hi) / 2n;
      if (cabe(avaliar(s, meio))) hi = meio;
      else lo = meio + 1n;
    }
    corte = lo;
  }

  const comCompra = guardadoHoje === null ? null
    : trajetoGuardado(guardadoHoje, sobra.slice(0, exibir).map((x, i) => x - compra[i]!), nomes);
  return {
    meses: linhas.map((l, i) => ({
      ...l, compra: reais(compra[i]!), sobra_com_compra: reais(sobra[i]! - compra[i]!),
      guardar_com_compra: reais(pedido.com.guardar[i]!), saldo_com_compra: reais(pedido.com.saldo[i]!),
      ...(comCompra ? { guardado_com_compra: reais(comCompra.caminho[i]!) } : {}),
    })),
    compra: {
      valor: reais(total), parcelas: n, mes, veredito,
      menor_saldo: reais(pedido.menor), mes_menor_saldo: meses[pedido.iMenor]!.mes,
      a_partir_de: aPartirDe, corte_mensal: corte === null ? null : reais(corte),
      tira_dos_objetivos: reais(pedido.tira),
      ...(comCompra ? { guardado: { menor: comCompra.resumo.menor, mes_menor: comCompra.resumo.mes_menor, acaba_em: comCompra.resumo.acaba_em } } : {}),
    },
    guardado: resumoGuardado,
  };
}
