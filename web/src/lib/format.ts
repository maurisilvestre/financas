// Formatação em pt-BR. Valores de dinheiro chegam da API como texto ("1255.90"): aqui só
// viram número para exibir. Somas e médias são feitas no banco, nunca no front.

type Num = string | number | null | undefined;

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const TZ = 'America/Sao_Paulo';

export function toNumber(v: Num): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function brl(v: Num): string {
  const n = toNumber(v);
  return n === null ? '—' : BRL.format(n);
}

function decimal(n: number, maxDigits: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: maxDigits }).format(n);
}

/** Soma valores da API ("1255.90") em centavos inteiros e devolve no mesmo formato ("1488.20"). */
export function somaReais(valores: Num[]): string {
  const centavos = valores.reduce<number>((acc, v) => acc + Math.round((toNumber(v) ?? 0) * 100), 0);
  const abs = Math.abs(centavos);
  return `${centavos < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Valor digitado pelo usuário: "4.000", "1.299,90", "R$ 350,5", "89.90". Só positivos, até 2
 * casas; o resto é null. Ponto sem vírgula é milhar quando vem em grupos de 3 ("4.000").
 */
export function lerReais(texto: string): number | null {
  let s = texto.replace(/R\$/i, '').replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

/** Quanto `parte` é de `todo`, de 0 a 100 com uma casa (para barras de progresso). */
export function percentual(parte: Num, todo: Num): number {
  const p = toNumber(parte) ?? 0;
  const t = toNumber(todo) ?? 0;
  if (t <= 0) return 0;
  return Math.round(Math.min(Math.max(p / t, 0), 1) * 1000) / 10;
}

/** Rótulo curto para eixos: "R$ 950", "R$ 12,3 mil", "R$ 1,25 mi". */
export function brlCompacto(v: number): string {
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}R$ ${decimal(abs / 1_000_000, 2)} mi`;
  if (abs >= 1_000) return `${sign}R$ ${decimal(abs / 1_000, 1)} mil`;
  return `${sign}R$ ${Math.round(abs)}`;
}

/** Variação percentual de `atual` em relação a `base`; null quando não há base. */
export function deltaPct(atual: Num, base: Num): number | null {
  const a = toNumber(atual);
  const b = toNumber(base);
  if (a === null || b === null || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

export function fmtDelta(p: number): string {
  if (p > 300) return '>+300%';
  const r = Math.round(p);
  if (r === 0) return '0%';
  return r > 0 ? `+${r}%` : `−${Math.abs(r)}%`;
}

function parseMes(mes: string): [number, number] {
  const [y, m] = mes.split('-').map(Number) as [number, number];
  return [y, m];
}

export function mesCurto(mes: string): string {
  const [y, m] = parseMes(mes);
  return `${MESES_CURTOS[m - 1]}/${String(y).slice(2)}`;
}

export function mesLongo(mes: string): string {
  const [y, m] = parseMes(mes);
  return `${MESES_LONGOS[m - 1]} de ${y}`;
}

export function shiftMes(mes: string, delta: number): string {
  const [y, m] = parseMes(mes);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function ultimoDia(mes: string): string {
  const [y, m] = parseMes(mes);
  return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** "2026-11-05" → "05/11". */
export function dataCurta(data: string): string {
  return `${data.slice(8, 10)}/${data.slice(5, 7)}`;
}

/** "2026-11-05" → "05/11/2026". */
export function dataLonga(data: string): string {
  return `${data.slice(8, 10)}/${data.slice(5, 7)}/${data.slice(0, 4)}`;
}

function partsInTz(now: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** Mês corrente (AAAA-MM) no fuso de Brasília. */
export function mesAtual(now = new Date()): string {
  const p = partsInTz(now);
  return `${p.year}-${p.month}`;
}

export function hoje(now = new Date()): string {
  const p = partsInTz(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Encurta nomes longos de conta: "Banco Exemplo S.A. - Instituição de Pagamento (...)" → "Banco Exemplo". */
export function contaCurta(nome: string): string {
  const s = (nome.split(' - ')[0] ?? nome).replace(/\s+S\.?\s?A\.?$/i, '').trim();
  return s || nome;
}

/**
 * Sugere o trecho para uma regra "contém" a partir de uma descrição de banco:
 * tira prefixos ("Pagamento efetuado|"), complementos (" - DOCTO: 123"), o que vem depois
 * de "*" (adquirente*loja), números e parcelas, e fica com até 3 palavras.
 */
export function sugerirPadrao(descricao: string): string {
  let s = descricao.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (s.includes('|')) s = s.slice(s.lastIndexOf('|') + 1);
  s = s.split(' - ')[0] ?? s;
  if (s.includes('*')) {
    const parts = s.split('*').map((p) => p.trim());
    s = parts.find((p) => (p.match(/\p{L}/gu) ?? []).length >= 3) ?? parts[0] ?? s;
  }
  s = s.replace(/\d+\s*\/\s*\d+/g, ' ').replace(/\d+/g, ' ');
  return s.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
}
