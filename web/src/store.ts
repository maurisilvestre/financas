// Estado compartilhado: rota (hash), categorias, avisos e um contador que as páginas
// observam para recarregar depois de uma escrita.
import { reactive, ref } from 'vue';
import { api } from './api.ts';
import { buildHash, type Page, parseHash, type Route } from './lib/route.ts';
import type { Categoria, ParcelamentoNovo } from './types.ts';

export const route = reactive<Route>(parseHash(location.hash));
window.addEventListener('hashchange', () => Object.assign(route, parseHash(location.hash)));

export const link = (page: Page, query: Record<string, string | undefined> = {}) => buildHash(page, query);

export function go(page: Page, query: Record<string, string | undefined> = {}): void {
  const hash = buildHash(page, query);
  if (location.hash !== hash) location.hash = hash;
}

// --- categorias ----------------------------------------------------------

export const categorias = ref<Categoria[]>([]);
let carregandoCategorias: Promise<void> | null = null;

export function carregarCategorias(): Promise<void> {
  carregandoCategorias ??= api.categorias()
    .then((r) => { categorias.value = r.categorias; })
    .catch((err: unknown) => { carregandoCategorias = null; throw err; });
  return carregandoCategorias;
}

const CINZA = '#928374';
export const corDa = (nome: string | null | undefined): string =>
  (nome && categorias.value.find((c) => c.nome === nome)?.cor) || CINZA;

// --- avisos --------------------------------------------------------------

export interface Aviso {
  id: number;
  texto: string;
  tipo: 'ok' | 'erro';
  acao?: { rotulo: string; fazer: () => void };
}

export const avisos = ref<Aviso[]>([]);
let seq = 0;

export function fecharAviso(id: number): void {
  avisos.value = avisos.value.filter((a) => a.id !== id);
}

export function avisar(texto: string, tipo: Aviso['tipo'] = 'ok', acao?: Aviso['acao']): void {
  const id = ++seq;
  avisos.value = [...avisos.value.slice(-3), { id, texto, tipo, acao }];
  // Texto longo fica mais tempo (uns 60 ms por letra), para dar tempo de ler.
  setTimeout(() => fecharAviso(id), Math.max(acao ? 9000 : tipo === 'erro' ? 8000 : 4500, texto.length * 60));
}

// --- recarregar depois de gravar -----------------------------------------

export const versao = ref(0);
export const dadosMudaram = () => { versao.value++; };

// --- sugestões da IA pendentes (contador na navegação e aviso na visão geral) ---

export const sugestoesPendentes = ref<{ grupos: number; transacoes: number }>({ grupos: 0, transacoes: 0 });

export async function atualizarSugestoesPendentes(): Promise<void> {
  try {
    const r = await api.sugestoes();
    sugestoesPendentes.value = { grupos: r.total_grupos, transacoes: r.total_transacoes };
  } catch {
    /* o contador é só um atalho; erros aparecem na própria página */
  }
}

// --- parcelamentos novos (alerta: parcelar só o que é da casa e foi planejado) ---

export const parcelamentosNovos = ref<ParcelamentoNovo[]>([]);

export async function atualizarParcelamentosNovos(): Promise<void> {
  try {
    parcelamentosNovos.value = (await api.parcelamentosNovos(30)).novos;
  } catch {
    /* o alerta é um atalho; erros aparecem nas páginas */
  }
}
