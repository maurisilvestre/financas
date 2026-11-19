// Cliente da API local. Escritas vão como JSON: o navegador manda a Origin, que a API confere.
import type {
  AcompanhamentoMeta, Categoria, Compromissos, Conta, FiltrosTransacoes, Origem, PreviaRegra, Recorrentes, ResultadoCategoria,
  APagar, ParcelamentoNovo, Previsao, StatusSync, ResultadoRegra, Resumo, Sugestoes, Transacoes, Visao,
} from './types.ts';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

async function request<T>(method: 'GET' | 'POST', path: string, params?: Params, body?: unknown): Promise<T> {
  let url = path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '' && v !== false) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. O serviço "web" está no ar?', 0);
  }
  const data = (await res.json().catch(() => null)) as { erro?: string } | null;
  if (!res.ok) throw new ApiError(data?.erro ?? `Erro ${res.status}`, res.status);
  return data as T;
}

const get = <T>(path: string, params?: Params) => request<T>('GET', path, params);
const post = <T>(path: string, body: unknown) => request<T>('POST', path, undefined, body);

export const api = {
  visao: (mes?: string, origem?: Origem) => get<Visao>('/api/visao', { mes, origem }),
  resumo: (meses = 12) => get<Resumo>('/api/resumo', { meses }),
  transacoes: (filtros: FiltrosTransacoes) => get<Transacoes>('/api/transacoes', { ...filtros }),
  recorrentes: (meses: number, minimoMeses: number) => get<Recorrentes>('/api/recorrentes', { meses, minimo_meses: minimoMeses }),
  compromissos: () => get<Compromissos>('/api/compromissos'),
  contas: () => get<{ contas: Conta[] }>('/api/contas'),
  categorias: () => get<{ categorias: Categoria[] }>('/api/categorias'),
  previaRegra: (padrao: string) => get<PreviaRegra>('/api/regras/previa', { padrao }),
  definirCategoria: (id: number, categoria: string) => post<ResultadoCategoria>(`/api/transacoes/${id}/categoria`, { categoria }),
  ignorar: (id: number, ignorar: boolean) => post<{ ok: true }>(`/api/transacoes/${id}/ignorar`, { ignorar }),
  criarRegra: (categoria: string, padrao: string) => post<ResultadoRegra>('/api/regras', { categoria, padrao }),
  meta: () => get<{ meta_cartao_avista: string | null }>('/api/meta'),
  definirMeta: (valor: number) => post<{ ok: true; meta_cartao_avista: string }>('/api/meta', { meta_cartao_avista: valor }),
  acompanhamento: (mes?: string) => get<AcompanhamentoMeta>('/api/meta/acompanhamento', { mes }),
  parcelamentosNovos: (dias = 30) => get<{ dias: number; novos: ParcelamentoNovo[] }>('/api/parcelamentos/novos', { dias }),
  sugestoes: () => get<Sugestoes>('/api/sugestoes'),
  aplicarSugestao: (chave: string, categoria: string) => post<{ ok: true; aplicadas: number }>('/api/sugestoes/aplicar', { chave, categoria }),
  recusarSugestao: (chave: string) => post<{ ok: true }>('/api/sugestoes/recusar', { chave }),
  aplicarConfiaveis: (minimo: number) => post<{ ok: true; grupos: number; transacoes: number }>('/api/sugestoes/aplicar-confiaveis', { minimo }),
  previsao: (p: { cenario?: 'media' | 'meta'; meses?: number; valor?: number; parcelas?: number; mes?: string; descricao?: string }) =>
    get<Previsao>('/api/previsao', p),
  statusSync: () => get<StatusSync>('/api/sync'),
  pedirSync: () => post<{ ok: true; pedido: boolean; motivo?: 'ja_pedido' | 'rodando' | 'recente' }>('/api/sync', {}),
  aPagar: () => get<APagar>('/api/a-pagar'),
  criarContaFixa: (c: { nome: string; padrao: string; dia: number; valor?: number; conta_id?: number; debito_automatico?: boolean }) =>
    post<{ ok: true; id: number }>('/api/contas-fixas', c),
  atualizarContaFixa: (id: number, c: { padrao?: string; dia?: number; valor?: number; conta_id?: number; pago_ate?: string; status?: 'ativa' | 'encerrada'; debito_automatico?: boolean }) =>
    post<{ ok: true }>(`/api/contas-fixas/${id}`, c),
  planejarGasto: (g: { descricao: string; motivo?: string; valor: number; parcelas: number; mes: string }) =>
    post<{ ok: true; id: number }>('/api/planejados', g),
  atualizarPlanejado: (id: number, status: 'realizado' | 'cancelado') => post<{ ok: true }>(`/api/planejados/${id}/status`, { status }),
  excluirDaPrevisao: (e: { padrao?: string; categoria?: string; motivo: string }) => post<{ ok: true; id: number }>('/api/previsao/exclusoes', e),
  removerExclusao: (id: number) => post<{ ok: true }>(`/api/previsao/exclusoes/${id}/remover`, {}),
  criarObjetivo: (o: { nome: string; motivo?: string; valor: number; ja_guardado?: number; por_mes: number; inicio: string }) =>
    post<{ ok: true; id: number }>('/api/objetivos', o),
  atualizarObjetivo: (id: number, mudanca: { valor?: number; ja_guardado?: number; por_mes?: number; inicio?: string; status?: 'concluido' | 'cancelado' }) =>
    post<{ ok: true }>(`/api/objetivos/${id}`, mudanca),
};
