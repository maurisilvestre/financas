// Formato das respostas da API (sync/src/queries.ts). Dinheiro vem como texto ("1255.90").

export type Dinheiro = string;
export type Fluxo = 'expense' | 'income' | 'transfer';
/** cartao = cartões de crédito; conta = contas (débito, Pix, boletos). */
export type Origem = 'cartao' | 'conta';

export interface GastoComMedia {
  gastos: Dinheiro;
  media_3m: Dinheiro | null;
}

export interface ResumoMes {
  mes: string;
  gastos: Dinheiro;
  receitas: Dinheiro;
  saldo: Dinheiro;
  sem_categoria: number;
}

export interface CategoriaMes {
  categoria: string;
  cor: string;
  total: Dinheiro;
  media_3m: Dinheiro | null;
}

export interface Visao {
  mes: string;
  em_andamento: boolean;
  resumo: ResumoMes;
  anterior: ResumoMes | null;
  media_3m: { meses: number; gastos: Dinheiro; receitas: Dinheiro } | null;
  origem: Origem | 'todas';
  categorias: CategoriaMes[];
  por_origem: { cartao: GastoComMedia; conta: GastoComMedia };
  cartoes: Array<GastoComMedia & { conta: string }>;
  parcelas_proximos_meses: Array<{ mes: string; comprometido: Dinheiro }>;
}

export interface Resumo {
  meses: Array<ResumoMes & { gastos_cartao: Dinheiro; gastos_conta: Dinheiro; em_andamento: boolean }>;
}

export interface Transacao {
  id: number;
  data: string;
  conta: string;
  descricao: string;
  valor: Dinheiro;
  categoria: string | null;
  origem_categoria: 'manual' | 'rule' | null;
  fluxo: Fluxo;
  parcela: string | null;
  status: 'PENDING' | 'POSTED';
  nota: string | null;
  ignorada: boolean;
}

export interface Transacoes {
  encontradas: number;
  soma: Dinheiro;
  mostrando: number;
  transacoes: Transacao[];
}

export interface FiltrosTransacoes {
  texto?: string;
  categoria?: string;
  sem_categoria?: boolean;
  conta?: string;
  origem?: Origem;
  fluxo?: Fluxo;
  de?: string;
  ate?: string;
  limite?: number;
  offset?: number;
}

export interface Recorrente {
  descricao: string;
  conta: string;
  categoria: string | null;
  meses: number;
  vezes: number;
  valor_medio: Dinheiro;
  media_mensal: Dinheiro;
  ultima: string;
}

export interface Recorrentes {
  periodo_meses: number;
  recorrentes: Recorrente[];
}

export interface Parcelamento {
  compra: string;
  conta: string;
  parcelas_total: number;
  parcelas_restantes: number;
  valor_parcela: Dinheiro;
  restante: Dinheiro;
  ultima_parcela: string;
}

export interface Compromissos {
  por_mes: Array<{ mes: string; conta: string; comprometido: Dinheiro; parcelas: number; projetadas: number }>;
  parcelamentos: Parcelamento[];
}

export interface Categoria {
  nome: string;
  tipo: Fluxo;
  cor: string | null;
  regras: Array<{ id: number; tipo: string; padrao: string; prioridade: number }>;
}

export interface Conta {
  nome: string;
  tipo: string;
  subtipo: string;
  final: string | null;
  saldo: Dinheiro | null;
  limite: Dinheiro | null;
  limite_disponivel: Dinheiro | null;
  vencimento_fatura: string | null;
  consentimento_expira_em: string | null;
  consentimento_expirando: boolean;
  atualizado_com_banco_em: string | null;
}

export interface PreviaRegra {
  padrao: string;
  casam: number;
  exemplos: Array<{ descricao: string; categoria: string | null; n: number }>;
}

export interface ResultadoRegra {
  ok: true;
  regra: { id: number; categoria: string; tipo: string; padrao: string; prioridade: number };
  casam: number;
  ja_nessa_categoria_antes: number;
  nessa_categoria_agora: number;
  observacao?: string;
}

export interface ResultadoCategoria {
  ok: true;
  transacao: { id: number; categoria: string; origem_categoria: 'manual' | 'rule' | null; nota: string | null };
}

/** Série de um gráfico de barras por mês. `classe` dá a cor: barra-<classe> e ponto-<classe>. */
export interface Serie {
  campo: string;
  rotulo: string;
  classe: string;
}

/** Sugestão de categoria feita pela IA para um estabelecimento (todas as transações dele sem categoria). */
export interface Sugestao {
  chave: string;
  exemplo: string;
  categoria: string;
  cor: string | null;
  confianca: string;
  motivo: string | null;
  transacoes: number;
  total: Dinheiro;
  ultima: string;
  /** Pode entrar no "aplicar todas": gasto em saída ou receita em entrada (nunca movimentação). */
  em_lote: boolean;
}

export interface Sugestoes {
  total_grupos: number;
  total_transacoes: number;
  grupos: Sugestao[];
}

/** Acompanhamento da meta do cartão à vista (compras sem parcela), dia a dia. */
export interface AcompanhamentoMeta {
  mes: string;
  em_andamento: boolean;
  meta: Dinheiro | null;
  dias_no_mes: number;
  dia_atual: number;
  gasto: Dinheiro;
  ritmo_ideal: Dinheiro | null;
  projecao: Dinheiro;
  status: 'sem_meta' | 'dentro' | 'acima' | 'estourou';
  por_dia: Array<{ dia: number; gasto: Dinheiro; acumulado: Dinheiro }>;
  mes_anterior: { mes: string; total: Dinheiro; por_dia: Array<{ dia: number; acumulado: Dinheiro }> };
}

/** Compra parcelada recente (alerta: confira se estava planejada). */
export interface ParcelamentoNovo {
  grupo: number;
  compra: string;
  conta: string;
  parcelas: number;
  valor_parcela: Dinheiro;
  total: Dinheiro;
  data_compra: string;
  /** false = o banco não informou a data; é o mês estimado da 1ª parcela. */
  data_exata: boolean;
}

// --- previsão (guardião do compra ou não compra) ---

export type Veredito = 'cabe' | 'no_limite' | 'nao_cabe';

export interface MesPrevisao {
  mes: string;
  entradas: string;
  gastos_conta: string;
  cartao_avista: string;
  parcelas: string;
  planejados: string;
  /** Quanto os objetivos pedem no mês (o aporte planejado). */
  guardar_planejado: string;
  /** O que fica do mês antes de guardar. */
  sobra: string;
  /** Quanto vai de fato para os objetivos: só o que sobra, até o planejado. */
  guardar: string;
  /** Dinheiro livre acumulado, depois de guardar. */
  saldo: string;
  capacidade_avista: string;
  /** Quanto ainda dá para guardar por mês a partir deste, sem o saldo ficar abaixo da margem. */
  aporte_maximo: string;
  compra?: string;
  sobra_com_compra?: string;
  guardar_com_compra?: string;
  saldo_com_compra?: string;
  /** O guardado de hoje mais a sobra acumulada até este mês (só se a Pluggy trouxe investimentos). */
  guardado?: string;
  guardado_com_compra?: string;
}

export interface Guardado {
  /** Saldo dos investimentos não resgatados, por dono. */
  total: string;
  /** Posição mais antiga. */
  data: string | null;
  contas: Array<{ conta: string; saldo: string; data: string | null }>;
  inicial: string;
  menor: string;
  mes_menor: string;
  /** 1º mês em que o guardado não cobre mais o que falta. */
  acaba_em: string | null;
  /** A partir de quando a sobra não fica mais negativa no horizonte. */
  tranquilo_em: string | null;
}

export interface ResultadoCompra {
  descricao: string | null;
  valor: string;
  parcelas: number;
  mes: string;
  veredito: Veredito;
  menor_saldo: string;
  mes_menor_saldo: string;
  a_partir_de: string | null;
  corte_mensal: string | null;
  /** Quanto a compra tiraria do que iria para os objetivos. */
  tira_dos_objetivos: string;
  /** A compra equivale a quantos meses de aporte de cada objetivo. */
  equivale: Array<{ id: number; nome: string; meses: number }>;
  /** Até onde o guardado chega com a compra. */
  guardado?: { menor: string; mes_menor: string; acaba_em: string | null };
}

export interface GastoPlanejado {
  id: number;
  descricao: string;
  motivo: string | null;
  valor: string;
  parcelas: number;
  valor_parcela: string;
  mes: string;
  status: string;
}

export interface Objetivo {
  id: number;
  nome: string;
  motivo: string | null;
  alvo: string;
  guardado: string;
  falta: string;
  por_mes: string;
  inicio: string;
  fica_pronto: string | null;
  status: string;
}

export interface Previsao {
  base: { meses_media: number; de: string; ate: string; meses_fixos: number; fixos_de: string };
  cenario: 'media' | 'meta';
  meta: string | null;
  reserva: string;
  margem: string;
  medias: { entradas: string; gastos_conta: string; cartao_avista: string; cartao_avista_media: string };
  fora_da_media: {
    categorias: Array<{ id: number; categoria: string; motivo: string; total: string }>;
    encerrados: Array<{ id: number; padrao: string; motivo: string; total: string }>;
    pontuais: Array<{ data: string; descricao: string; conta: string; fluxo: string; valor: string }>;
  };
  planejados: GastoPlanejado[];
  objetivos: Objetivo[];
  cortaveis: Array<{ categoria: string; media_mensal: string }>;
  meses: MesPrevisao[];
  guardado: Guardado | null;
  compra: ResultadoCompra | null;
}

export interface ItemAPagar {
  tipo: 'fatura' | 'fatura_aberta' | 'conta_fixa';
  /** Conta fixa: o id dela; fatura fechada: o id da fatura; aberta: null. */
  id: number | null;
  descricao: string;
  conta_id: number | null;
  /** Conta de onde sai. */
  conta: string | null;
  vencimento: string;
  /** Paga: o que saiu; senão, o que falta pagar (null: conta fixa sem valor conhecido). */
  valor: string | null;
  /** a_confirmar: venceu, mas o banco ainda não mandou os dados desse dia. */
  situacao: 'paga' | 'a_pagar' | 'atrasada' | 'a_confirmar';
  pago_em: string | null;
  estimado: boolean;
  /** Paga por débito automático, presumida: venceu, mas o banco ainda não mostrou. */
  presumida: boolean;
  /** Paga, mas o saldo do banco (da última atualização) ainda não mostra: sai do saldo. */
  fora_do_saldo: boolean;
}

export interface ContaAPagar {
  id: number;
  conta: string;
  /** O do banco (última atualização da Pluggy). */
  saldo_banco: string;
  /** Pago depois dessa atualização (o banco ainda não mostra). */
  ja_saiu: string;
  /** saldo_banco − ja_saiu. */
  saldo: string;
  a_pagar: string;
  /** Negativa: o que falta. */
  sobra: string;
  /** O dia em que o dinheiro da conta acaba, pagando na ordem dos vencimentos. */
  acaba_em: { data: string; descricao: string } | null;
  atualizado_em: string | null;
  /** Até que dia o banco mandou dados. */
  dados_ate: string | null;
}

export interface ContaFixa {
  id: number;
  nome: string;
  padrao: string;
  dia: number;
  valor: string | null;
  conta_id: number | null;
  conta: string | null;
  pago_ate: string | null;
  debito_automatico: boolean;
}

export interface APagar {
  hoje: string;
  ultimo_salario: { data: string; valor: string } | null;
  /** Total dos investimentos (o guardado), para ver se cobre o que falta. */
  guardado: { total: string; data: string | null } | null;
  proximo_salario: string;
  saldo_banco: string;
  ja_saiu: string;
  saldo: string;
  a_pagar: string;
  sobra: string;
  contas: ContaAPagar[];
  itens: ItemAPagar[];
  contas_fixas: ContaFixa[];
}

export interface StatusSync {
  ultimo: {
    id: number;
    trigger: string;
    status: 'running' | 'success' | 'partial' | 'error';
    iniciado_em: string;
    terminado_em: string | null;
    /** Movimentações novas que o sync trouxe. */
    inseridas: number;
    avisos: number;
    erro: string | null;
  } | null;
  /** O app pediu e o sync ainda não começou. */
  pedido_pendente: boolean;
  rodando: boolean;
  /** Quando a Pluggy buscou os dados de cada banco pela última vez. */
  bancos: Array<{ conta: string; atualizado_em: string | null }>;
}

export interface Simulacao {
  descricao: string;
  valor: number;
  parcelas: number;
  mes: string;
}
