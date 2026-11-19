// Escalas dos gráficos em SVG.

const PASSOS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Teto "redondo" acima do maior valor (para o eixo não terminar em 83.710,71). */
export function escalaMax(valores: number[]): number {
  const max = Math.max(0, ...valores);
  if (max <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(max));
  for (const passo of PASSOS) {
    if (passo * base >= max) return passo * base;
  }
  return 10 * base;
}

/** Área útil de um gráfico, em coordenadas do SVG (y0 no topo, y1 na base). */
export interface Area {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const r1 = (n: number) => String(Math.round(n * 10) / 10);

/**
 * Caminho SVG do acumulado dia a dia: valores[i] é o acumulado no dia i+1. O eixo x vai do
 * dia 1 ao último dia do mês (a linha para no último valor); o eixo y, de 0 a `max`.
 */
export function caminhoAcumulado(valores: number[], totalDias: number, max: number, area: Area): string {
  const passo = (area.x1 - area.x0) / Math.max(totalDias - 1, 1);
  return valores
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${r1(area.x0 + i * passo)},${r1(area.y1 - (Math.max(v, 0) / max) * (area.y1 - area.y0))}`)
    .join(' ');
}

/** Faixa "redonda" para séries que podem ser negativas (ex.: saldo); o zero fica sempre dentro. */
export function escalaFaixa(valores: number[]): { min: number; max: number } {
  const maior = Math.max(0, ...valores);
  const menor = Math.min(0, ...valores);
  if (maior === 0 && menor === 0) return { min: 0, max: 1 };
  return { min: menor < 0 ? -escalaMax([-menor]) : 0, max: maior > 0 ? escalaMax([maior]) : 0 };
}

/**
 * Marcas do eixo de uma faixa com negativos: o zero, os extremos e as metades. Um lado pequeno
 * demais em relação à faixa perde os rótulos, para não se sobreporem ao zero.
 */
export function marcasFaixa(min: number, max: number): number[] {
  const faixa = max - min || 1;
  const out = new Set<number>([0]);
  if (max > 0) {
    out.add(max);
    if (max / faixa >= 0.3) out.add(max / 2);
  }
  if (min < 0) {
    if (-min / faixa >= 0.08) out.add(min);
    if (-min / faixa >= 0.3) out.add(min / 2);
  }
  return [...out].sort((a, b) => a - b);
}

/** Caminho SVG de uma série com `valores.length` pontos igualmente espaçados; y de `min` (base) a `max` (topo). */
export function caminhoLinha(valores: number[], min: number, max: number, area: Area): string {
  const passo = (area.x1 - area.x0) / Math.max(valores.length - 1, 1);
  const altura = max - min || 1;
  return valores
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${r1(area.x0 + i * passo)},${r1(area.y1 - ((v - min) / altura) * (area.y1 - area.y0))}`)
    .join(' ');
}

// Passos dos rótulos de mês: todos dividem o ano, para cair sempre nos mesmos meses (jan, abr, jul, out...).
const PASSOS_MESES = [1, 2, 3, 4, 6, 12];

/**
 * Índices dos meses (AAAA-MM) que ganham rótulo no eixo: o menor passo que não passa de `max`
 * rótulos, alinhado ao calendário (de 3 em 3: jan, abr, jul e out).
 */
export function rotulosMeses(meses: string[], max: number): number[] {
  const comPasso = (passo: number) => meses.flatMap((m, i) => ((Number(m.slice(5, 7)) - 1) % passo === 0 ? [i] : []));
  for (const passo of PASSOS_MESES) {
    const r = comPasso(passo);
    if (r.length <= max) return r;
  }
  return comPasso(12);
}

/**
 * Largura do SVG, em unidades do viewBox. Em tela larga, a de sempre (`padrao`): o gráfico
 * escala junto com o texto. Em tela estreita (celular), a do próprio espaço, em pixels: assim o
 * texto do eixo fica no tamanho do CSS em vez de encolher junto com o desenho.
 */
export function larguraGrafico(espaco: number, padrao = 680, estreita = 480, minima = 240): number {
  if (!(espaco > 0) || espaco >= estreita) return padrao;
  return Math.max(minima, Math.round(espaco));
}

/** Índices de `n` itens que ganham rótulo num eixo de `largura`, um a cada `porRotulo` de espaço no máximo. */
export function rotulosEspacados(n: number, largura: number, porRotulo = 40): number[] {
  if (n <= 0) return [];
  const passo = Math.max(1, Math.ceil((n * porRotulo) / Math.max(largura, 1)));
  return Array.from({ length: n }, (_, i) => i).filter((i) => i % passo === 0);
}

/** Marcas do eixo, de 0 a `max`, em `n` intervalos iguais. */
export function marcas(max: number, n = 4): number[] {
  return Array.from({ length: n + 1 }, (_, i) => (max * i) / n);
}
