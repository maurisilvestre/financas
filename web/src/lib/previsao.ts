// Ajuda a explicar a tabela da previsão.
import { toNumber } from './format.ts';

interface MesSaldo {
  mes: string;
  sobra: string;
  saldo: string;
}

export interface ExemploBuraco {
  mes: string;
  sobra: string;
  /** Tamanho do buraco antes e depois da sobra do mês, sem o sinal (para o texto). */
  antes: string;
  depois: string;
}

const semSinal = (v: string) => v.replace(/^-/, '');

/** Trecho da tabela: do índice `de` até antes de `ate`. */
export interface Pagina {
  de: number;
  ate: number;
}

/** A tabela da previsão em páginas de `tamanho` meses (um ano, por padrão). */
export function paginar(total: number, tamanho = 12): Pagina[] {
  return Array.from({ length: Math.ceil(total / tamanho) }, (_, p) => ({ de: p * tamanho, ate: Math.min(total, (p + 1) * tamanho) }));
}

/** Página em que fica o mês; 0 se ele não estiver na previsão. */
export function paginaDoMes(meses: { mes: string }[], mes: string, tamanho = 12): number {
  const i = meses.findIndex((m) => m.mes === mes);
  return i < 0 ? 0 : Math.floor(i / tamanho);
}

/**
 * O 1º mês em que sobra dinheiro, mas o saldo acumulado continua negativo, porque a sobra vai
 * para o que faltou nos meses anteriores. Serve de exemplo na legenda; null se não houver.
 */
export function primeiroBuraco(meses: MesSaldo[]): ExemploBuraco | null {
  for (let i = 1; i < meses.length; i++) {
    const m = meses[i]!;
    if ((toNumber(m.sobra) ?? 0) > 0 && (toNumber(m.saldo) ?? 0) < 0) {
      return { mes: m.mes, sobra: m.sobra, antes: semSinal(meses[i - 1]!.saldo), depois: semSinal(m.saldo) };
    }
  }
  return null;
}
