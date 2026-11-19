// Rotas por hash (#/transacoes?categoria=Saúde): sem vue-router, sem servidor para reescrever URL.

export const PAGES = ['visao', 'apagar', 'transacoes', 'sugestoes', 'recorrentes', 'parcelas', 'previsao'] as const;
export type Page = (typeof PAGES)[number];
export type Query = Record<string, string>;

export interface Route {
  page: Page;
  query: Query;
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const path = q >= 0 ? h.slice(0, q) : h;
  if (!(PAGES as readonly string[]).includes(path)) return { page: 'visao', query: {} };
  return { page: path as Page, query: Object.fromEntries(new URLSearchParams(q >= 0 ? h.slice(q + 1) : '')) };
}

export function buildHash(page: Page, query: Record<string, string | undefined> = {}): string {
  const entries = Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '');
  const qs = new URLSearchParams(entries).toString();
  return `#/${page}${qs ? `?${qs}` : ''}`;
}
