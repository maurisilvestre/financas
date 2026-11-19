// Consultas da camada de leitura e as duas escritas do usuário, usadas pelo MCP e pela API.
//
// Leitura: só as views (e categorias/regras), com o papel fin_readonly. Nada de SQL livre:
// assim ninguém alcança o raw da Pluggy (CPFs, números de conta).
// Escrita: só transaction_overrides e category_rules, com o papel fin_mcp (migration 0005).
// Os resultados usam chaves em português: vão direto para o modelo (MCP) e para o front.
import type { Db } from './db.ts';
import { UserError } from './errors.ts';
import type { Args, ObjectSchema, PropSchema } from './mcp/schema.ts';
import { dateInTimezone, shiftMonth } from './normalize.ts';
import { resumirAPagar, type ItemBruto } from './apagar.ts';
import { projetar, reais, centavos } from './previsao.ts';

export interface Pools {
  read: Db;
  write: Db;
}

const MONTH: PropSchema = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'mês no formato AAAA-MM' };
const DATE: PropSchema = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$', description: 'data no formato AAAA-MM-DD' };
const noArgs: ObjectSchema = { type: 'object', properties: {}, additionalProperties: false };
const ORIGEM: PropSchema = {
  type: 'string', enum: ['cartao', 'conta'],
  description: 'cartao = só cartões de crédito; conta = só contas (débito, Pix, boletos). Sem ele, tudo.',
};

/** Filtro de origem sobre v_transactions (cartão de crédito × conta), com o parâmetro $n. */
const origemFiltro = (n: number) => `($${n}::text IS NULL OR (account_subtype = 'CREDIT_CARD') = ($${n}::text = 'cartao'))`;

/** Parâmetros de cada consulta. O MCP anuncia estes schemas e a API valida com eles. */
export const SCHEMAS = {
  resumoMensal: {
    type: 'object',
    properties: { meses: { type: 'integer', minimum: 1, maximum: 36, default: 12, description: 'Quantos meses, contando o atual' } },
    additionalProperties: false,
  },
  gastosPorCategoria: {
    type: 'object',
    properties: {
      de: { ...MONTH, description: 'Mês inicial (AAAA-MM). Padrão: 5 meses antes de "ate".' },
      ate: { ...MONTH, description: 'Mês final (AAAA-MM). Padrão: o mês atual.' },
      fluxo: { type: 'string', enum: ['expense', 'income'], default: 'expense', description: 'expense = gastos, income = receitas' },
      origem: ORIGEM,
      por_mes: { type: 'boolean', default: false, description: 'Incluir o detalhe mês a mês' },
    },
    additionalProperties: false,
  },
  buscarTransacoes: {
    type: 'object',
    properties: {
      texto: { type: 'string', minLength: 2, maxLength: 100, description: 'Trecho da descrição (não diferencia maiúsculas nem acentos)' },
      categoria: { type: 'string', maxLength: 60, description: 'Nome exato da categoria (ver categorias)' },
      sem_categoria: { type: 'boolean', default: false, description: 'Só as que estão sem categoria (fora transferências)' },
      conta: { type: 'string', maxLength: 80, description: 'Trecho do nome da conta' },
      origem: ORIGEM,
      fluxo: { type: 'string', enum: ['expense', 'income', 'transfer'] },
      de: { ...DATE, description: 'Data inicial (AAAA-MM-DD)' },
      ate: { ...DATE, description: 'Data final (AAAA-MM-DD). Padrão: hoje.' },
      valor_min: { type: 'number', minimum: 0, description: 'Valor absoluto mínimo' },
      valor_max: { type: 'number', minimum: 0, description: 'Valor absoluto máximo' },
      incluir_ignoradas: { type: 'boolean', default: false, description: 'Incluir as que o usuário tirou dos relatórios' },
      limite: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      offset: { type: 'integer', minimum: 0, maximum: 100_000, default: 0, description: 'Pular as N primeiras (paginação)' },
    },
    additionalProperties: false,
  },
  gastosRecorrentes: {
    type: 'object',
    properties: {
      meses: { type: 'integer', minimum: 2, maximum: 24, default: 6, description: 'Janela, em meses, contando o atual' },
      minimo_meses: { type: 'integer', minimum: 2, maximum: 24, default: 3, description: 'Em quantos meses distintos precisa aparecer' },
    },
    additionalProperties: false,
  },
  compromissosFuturos: noArgs,
  contas: noArgs,
  faturas: {
    type: 'object',
    properties: { meses: { type: 'integer', minimum: 1, maximum: 24, default: 6, description: 'Quantos meses para trás' } },
    additionalProperties: false,
  },
  categorias: noArgs,
  definirCategoria: {
    type: 'object',
    properties: {
      transacao_id: { type: 'integer', minimum: 1, description: 'id da transação (vem de buscar_transacoes)' },
      categoria: { type: 'string', minLength: 2, maxLength: 60, description: 'Nome da categoria (ver categorias)' },
      nota: { type: 'string', maxLength: 500, description: 'Opcional. Sem nota, mantém a que já existir.' },
    },
    required: ['transacao_id', 'categoria'],
    additionalProperties: false,
  },
  criarRegra: {
    type: 'object',
    properties: {
      categoria: { type: 'string', minLength: 2, maxLength: 60, description: 'Nome da categoria (ver categorias)' },
      padrao: { type: 'string', minLength: 3, maxLength: 200, description: 'Trecho da descrição, em minúsculas e sem acento' },
      prioridade: { type: 'integer', minimum: 1, maximum: 1000, default: 50, description: 'Menor vence. As regras iniciais usam de 10 a 70.' },
    },
    required: ['categoria', 'padrao'],
    additionalProperties: false,
  },
  // Só a API (o MCP fica com as duas escritas combinadas: categoria e regra).
  visaoDoMes: {
    type: 'object',
    properties: {
      mes: { ...MONTH, description: 'Mês (AAAA-MM). Padrão: o atual.' },
      origem: { ...ORIGEM, description: 'Filtra só as categorias: cartao ou conta.' },
    },
    additionalProperties: false,
  },
  previaRegra: {
    type: 'object',
    properties: { padrao: { type: 'string', minLength: 3, maxLength: 200, description: 'Trecho da descrição' } },
    required: ['padrao'],
    additionalProperties: false,
  },
  ignorarTransacao: {
    type: 'object',
    properties: {
      transacao_id: { type: 'integer', minimum: 1 },
      ignorar: { type: 'boolean', default: true, description: 'true tira dos relatórios; false devolve' },
    },
    required: ['transacao_id'],
    additionalProperties: false,
  },
  sugestoes: noArgs,
  aplicarSugestao: {
    type: 'object',
    properties: {
      chave: { type: 'string', minLength: 1, maxLength: 300, description: 'Chave do estabelecimento (vem de sugestoes)' },
      categoria: { type: 'string', minLength: 2, maxLength: 60, description: 'Categoria a aplicar (a sugerida ou outra)' },
    },
    required: ['chave', 'categoria'],
    additionalProperties: false,
  },
  recusarSugestao: {
    type: 'object',
    properties: { chave: { type: 'string', minLength: 1, maxLength: 300 } },
    required: ['chave'],
    additionalProperties: false,
  },
  aplicarConfiaveis: {
    type: 'object',
    properties: { minimo: { type: 'number', minimum: 0.5, maximum: 1, default: 0.85, description: 'Confiança mínima (0 a 1)' } },
    additionalProperties: false,
  },
  meta: noArgs,
  definirMeta: {
    type: 'object',
    properties: { meta_cartao_avista: { type: 'number', minimum: 0, maximum: 1_000_000, description: 'Meta mensal, em reais, das compras à vista no cartão' } },
    required: ['meta_cartao_avista'],
    additionalProperties: false,
  },
  acompanhamentoMeta: {
    type: 'object',
    properties: { mes: { ...MONTH, description: 'Mês (AAAA-MM). Padrão: o atual.' } },
    additionalProperties: false,
  },
  parcelamentosNovos: {
    type: 'object',
    properties: { dias: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'Compras parceladas dos últimos N dias' } },
    additionalProperties: false,
  },
  previsao: {
    type: 'object',
    properties: {
      cenario: { type: 'string', enum: ['media', 'meta'], default: 'media', description: 'media = cartão à vista pela média dos últimos 6 meses (padrão); meta = pela meta do cartão' },
      reserva: { type: 'number', minimum: 0, maximum: 10_000_000, default: 0, description: 'Dinheiro guardado que o usuário aceita usar, em reais (padrão: 0)' },
      margem: { type: 'number', minimum: 0, maximum: 1_000_000, default: 1000, description: 'Saldo mínimo, em reais, para a compra caber com folga (padrão: 1000)' },
      meses: { type: 'integer', minimum: 3, maximum: 48, default: 12, description: 'Meses de previsão, contando o atual (padrão: 12; até 48, 4 anos). O veredito, o "dá para gastar" e o aporte máximo olham o horizonte todo.' },
      valor: { type: 'number', minimum: 0.01, maximum: 10_000_000, description: 'Simular uma compra: valor total em reais' },
      parcelas: { type: 'integer', minimum: 1, maximum: 48, default: 1, description: 'Simular uma compra: número de parcelas (1 = à vista)' },
      mes: { ...MONTH, description: 'Simular uma compra: mês da compra ou da 1ª parcela (AAAA-MM). Padrão: o atual.' },
      descricao: { type: 'string', minLength: 1, maxLength: 120, description: 'Simular uma compra: o que é' },
    },
    additionalProperties: false,
  },
  planejarGasto: {
    type: 'object',
    properties: {
      descricao: { type: 'string', minLength: 1, maxLength: 120, description: 'O que vai ser comprado ou pago' },
      motivo: { type: 'string', maxLength: 500, description: 'Por que precisa (opcional)' },
      valor: { type: 'number', minimum: 0.01, maximum: 10_000_000, description: 'Valor total em reais' },
      parcelas: { type: 'integer', minimum: 1, maximum: 48, default: 1, description: '1 = à vista' },
      mes: { ...MONTH, description: 'Mês do pagamento (ou da 1ª parcela), AAAA-MM' },
    },
    required: ['descricao', 'valor', 'mes'],
    additionalProperties: false,
  },
  atualizarPlanejado: {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1, description: 'id do gasto planejado (vem de previsao)' },
      status: { type: 'string', enum: ['planejado', 'realizado', 'cancelado'], description: 'realizado = a transação de verdade já chegou; cancelado = desistiu' },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  },
  excluirDaPrevisao: {
    type: 'object',
    properties: {
      padrao: { type: 'string', minLength: 3, maxLength: 80, description: 'Trecho da descrição (ex.: uma assinatura cancelada). Use este ou categoria.' },
      categoria: { type: 'string', minLength: 2, maxLength: 60, description: 'Categoria inteira (ex.: um curso que terminou). Use esta ou padrao.' },
      motivo: { type: 'string', minLength: 1, maxLength: 200, description: 'Por que não vai se repetir' },
    },
    required: ['motivo'],
    additionalProperties: false,
  },
  removerExclusao: {
    type: 'object',
    properties: { id: { type: 'integer', minimum: 1, description: 'id da exclusão (vem de previsao, em fora_da_media)' } },
    required: ['id'],
    additionalProperties: false,
  },
  criarObjetivo: {
    type: 'object',
    properties: {
      nome: { type: 'string', minLength: 1, maxLength: 80, description: 'O objetivo (ex.: Reserva de emergência, Quitar uma dívida, Viagem)' },
      motivo: { type: 'string', maxLength: 500, description: 'Por que (opcional)' },
      valor: { type: 'number', minimum: 0.01, maximum: 10_000_000, description: 'Quanto precisa juntar no total, em reais' },
      ja_guardado: { type: 'number', minimum: 0, maximum: 10_000_000, default: 0, description: 'Quanto já está guardado para ele, em reais' },
      por_mes: { type: 'number', minimum: 0.01, maximum: 1_000_000, description: 'Quanto guardar por mês, em reais' },
      inicio: { ...MONTH, description: 'Primeiro mês de aporte (AAAA-MM). Padrão: o atual.' },
    },
    required: ['nome', 'valor', 'por_mes'],
    additionalProperties: false,
  },
  atualizarObjetivo: {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1, description: 'id do objetivo (vem de previsao, em objetivos)' },
      valor: { type: 'number', minimum: 0.01, maximum: 10_000_000, description: 'Novo valor total do objetivo' },
      ja_guardado: { type: 'number', minimum: 0, maximum: 10_000_000, description: 'Quanto já está guardado (atualize quando guardar)' },
      por_mes: { type: 'number', minimum: 0.01, maximum: 1_000_000, description: 'Novo aporte mensal' },
      inicio: { ...MONTH, description: 'Novo primeiro mês de aporte (adiar = mês mais à frente)' },
      status: { type: 'string', enum: ['ativo', 'concluido', 'cancelado'], description: 'concluido = juntou; cancelado = desistiu. Os dois tiram o objetivo da previsão.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  aPagar: { type: 'object', properties: {}, additionalProperties: false },
  statusSync: { type: 'object', properties: {}, additionalProperties: false },
  pedirSync: { type: 'object', properties: {}, additionalProperties: false },
  criarContaFixa: {
    type: 'object',
    properties: {
      nome: { type: 'string', minLength: 1, maxLength: 80, description: 'A conta (ex.: Luz, Água, Internet)' },
      padrao: { type: 'string', minLength: 3, maxLength: 80, description: 'Trecho da descrição do pagamento ("contém", sem acento), que reconhece a conta em qualquer banco (ex.: energia, internet)' },
      dia: { type: 'integer', minimum: 1, maximum: 31, description: 'Dia do mês em que costuma sair' },
      valor: { type: 'number', minimum: 0.01, maximum: 1_000_000, description: 'Valor esperado, em reais. Sem ele, vale o que saiu no mês anterior.' },
      conta_id: { type: 'integer', minimum: 1, description: 'Conta corrente de onde sai (id de contas)' },
      debito_automatico: { type: 'boolean', default: false, description: 'Débito automático: passado o vencimento, conta como paga' },
    },
    required: ['nome', 'padrao', 'dia'],
    additionalProperties: false,
  },
  atualizarContaFixa: {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1, description: 'id da conta fixa (vem de a_pagar, em contas_fixas)' },
      padrao: { type: 'string', minLength: 3, maxLength: 80, description: 'Novo trecho da descrição' },
      dia: { type: 'integer', minimum: 1, maximum: 31, description: 'Novo dia do mês' },
      valor: { type: 'number', minimum: 0.01, maximum: 1_000_000, description: 'Novo valor esperado' },
      conta_id: { type: 'integer', minimum: 1, description: 'Nova conta de onde sai' },
      pago_ate: { ...DATE, description: '"Já paguei": vencimentos até esta data contam como pagos (para quando o pagamento não é reconhecido pela descrição)' },
      status: { type: 'string', enum: ['ativa', 'encerrada'], description: 'encerrada = a conta acabou; sai do a pagar' },
      debito_automatico: { type: 'boolean', description: 'Liga ou desliga o débito automático' },
    },
    required: ['id'],
    additionalProperties: false,
  },
} satisfies Record<string, ObjectSchema>;

const today = () => dateInTimezone(new Date());
const currentMonth = () => today().slice(0, 7);

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return ty * 12 + tm - (fy * 12 + fm) + 1;
}

async function findCategory(read: Db, name: string): Promise<{ id: string; name: string }> {
  const { rows } = await read.query<{ id: string; name: string }>(
    'SELECT id, name FROM fin.categories WHERE fin.norm_text(name) = fin.norm_text($1)', [name]);
  if (rows[0]) return rows[0];
  const all = await read.query<{ name: string }>('SELECT name FROM fin.categories ORDER BY sort_order, name');
  throw new UserError(`Categoria "${name}" não existe. Use uma destas: ${all.rows.map((r) => r.name).join(', ')}.`);
}

/** Por mês: gastos (e quanto foi no cartão e na conta), receitas, saldo e quantas sem categoria. */
export async function resumoMensal(read: Db, { meses }: Args) {
  const { rows } = await read.query(
    `SELECT to_char(month, 'YYYY-MM') AS mes,
            coalesce(sum(-signed_amount) FILTER (WHERE flow = 'expense'), 0)::numeric(14,2) AS gastos,
            coalesce(sum(-signed_amount) FILTER (WHERE flow = 'expense' AND account_subtype = 'CREDIT_CARD'), 0)::numeric(14,2) AS gastos_cartao,
            coalesce(sum(-signed_amount) FILTER (WHERE flow = 'expense' AND account_subtype <> 'CREDIT_CARD'), 0)::numeric(14,2) AS gastos_conta,
            coalesce(sum(signed_amount) FILTER (WHERE flow = 'income'), 0)::numeric(14,2) AS receitas,
            (coalesce(sum(signed_amount) FILTER (WHERE flow = 'income'), 0)
              - coalesce(sum(-signed_amount) FILTER (WHERE flow = 'expense'), 0))::numeric(14,2) AS saldo,
            (count(*) FILTER (WHERE category_id IS NULL AND flow <> 'transfer'))::int AS sem_categoria,
            month = date_trunc('month', current_date)::date AS em_andamento
     FROM fin.v_transactions
     WHERE NOT ignored AND month <= date_trunc('month', current_date)::date
     GROUP BY month
     ORDER BY month DESC
     LIMIT $1`, [meses]);
  return { meses: rows };
}

export async function gastosPorCategoria(read: Db, args: Args) {
  const ate = (args.ate as string | undefined) ?? currentMonth();
  const de = (args.de as string | undefined) ?? shiftMonth(`${ate}-01`, -5).slice(0, 7);
  if (de > ate) throw new UserError('"de" deve ser um mês igual ou anterior a "ate".');
  const meses = monthsBetween(de, ate);
  // Mesma conta de v_monthly_by_category, mas sobre v_transactions para poder filtrar a origem.
  const base = `
    WITH base AS (
      SELECT month, coalesce(category, 'Sem categoria') AS category,
             CASE WHEN flow = 'expense' THEN -signed_amount ELSE signed_amount END AS valor
      FROM fin.v_transactions
      WHERE NOT ignored AND flow = $3
        AND local_date >= $1::date AND local_date < ($2::date + interval '1 month')
        AND ${origemFiltro(4)}
    )`;
  const params = [`${de}-01`, `${ate}-01`, args.fluxo, args.origem ?? null];
  const { rows: categorias } = await read.query(
    `${base}
     SELECT category AS categoria, sum(valor)::numeric(14,2) AS total, count(*)::int AS transacoes,
            round(sum(valor) / $5::int, 2)::numeric(14,2) AS media_mensal
     FROM base
     GROUP BY category
     ORDER BY sum(valor) DESC`, [...params, meses]);
  const result: Record<string, unknown> = { de, ate, fluxo: args.fluxo, origem: args.origem ?? 'todas', meses, categorias };
  if (args.por_mes) {
    const { rows } = await read.query(
      `${base}
       SELECT to_char(month, 'YYYY-MM') AS mes, category AS categoria, sum(valor)::numeric(14,2) AS total, count(*)::int AS transacoes
       FROM base
       GROUP BY month, category
       ORDER BY month, sum(valor) DESC`, params);
    result.por_mes = rows;
  }
  return result;
}

export async function buscarTransacoes(read: Db, args: Args) {
  const filter = `
     WHERE ($10::boolean OR NOT ignored)
       AND ($1::text IS NULL OR position(fin.norm_text($1) IN fin.norm_text(description || ' ' || bank_description)) > 0)
       AND ($2::text IS NULL OR fin.norm_text(category) = fin.norm_text($2))
       AND (NOT $3::boolean OR (category_id IS NULL AND flow <> 'transfer'))
       AND ($4::text IS NULL OR position(fin.norm_text($4) IN fin.norm_text(account)) > 0)
       AND ($5::text IS NULL OR flow = $5)
       AND ($6::date IS NULL OR local_date >= $6::date)
       AND local_date <= $7::date
       AND ($8::numeric IS NULL OR abs(signed_amount) >= $8::numeric)
       AND ($9::numeric IS NULL OR abs(signed_amount) <= $9::numeric)
       AND ${origemFiltro(11)}`;
  const params = [args.texto ?? null, args.categoria ?? null, args.sem_categoria, args.conta ?? null, args.fluxo ?? null,
    args.de ?? null, args.ate ?? today(), args.valor_min ?? null, args.valor_max ?? null, args.incluir_ignoradas,
    args.origem ?? null];

  const totals = await read.query<{ encontradas: number; soma: string }>(
    `SELECT count(*)::int AS encontradas, coalesce(sum(signed_amount), 0)::numeric(14,2) AS soma
     FROM fin.v_transactions ${filter}`, params);
  const { rows: transacoes } = await read.query(
    `SELECT id::int AS id, local_date AS data, account AS conta, description AS descricao, signed_amount AS valor,
            category AS categoria, category_source AS origem_categoria, flow AS fluxo,
            CASE WHEN installment_number IS NOT NULL THEN installment_number || '/' || total_installments END AS parcela,
            status, note AS nota, ignored AS ignorada
     FROM fin.v_transactions ${filter}
     ORDER BY local_date DESC, id DESC
     LIMIT $12 OFFSET $13`, [...params, args.limite, args.offset]);
  return { ...totals.rows[0]!, mostrando: transacoes.length, transacoes };
}

export async function gastosRecorrentes(read: Db, { meses, minimo_meses }: Args) {
  const { rows } = await read.query(
    `WITH base AS (
       SELECT account, description, category, signed_amount, local_date, month,
              trim(regexp_replace(fin.norm_text(bank_description), '[0-9]+', '', 'g')) AS chave
       FROM fin.v_transactions
       WHERE flow = 'expense' AND NOT ignored AND total_installments IS NULL
         AND month >= (date_trunc('month', current_date) - make_interval(months => $1::int - 1))::date
         AND local_date <= current_date
     )
     SELECT min(description) AS descricao, account AS conta, min(category) AS categoria,
            count(DISTINCT month)::int AS meses, count(*)::int AS vezes,
            round(avg(-signed_amount), 2) AS valor_medio,
            round(sum(-signed_amount) / $1::int, 2) AS media_mensal,
            max(local_date) AS ultima
     FROM base
     GROUP BY chave, account
     HAVING count(DISTINCT month) >= $2::int
     ORDER BY sum(-signed_amount) DESC
     LIMIT 100`, [meses, minimo_meses]);
  return { periodo_meses: meses, recorrentes: rows };
}

export async function compromissosFuturos(read: Db) {
  const porMes = await read.query(
    `SELECT to_char(month, 'YYYY-MM') AS mes, account AS conta, committed::numeric(14,2) AS comprometido,
            installments::int AS parcelas, projected_installments::int AS projetadas
     FROM fin.v_future_commitments
     ORDER BY month, account`);
  const parcelamentos = await read.query(
    `SELECT p.description AS compra, a.name AS conta, max(p.total_installments)::int AS parcelas_total,
            (count(*) FILTER (WHERE p.month >= date_trunc('month', current_date)))::int AS parcelas_restantes,
            max(p.amount)::numeric(14,2) AS valor_parcela,
            coalesce(sum(p.amount) FILTER (WHERE p.month >= date_trunc('month', current_date)), 0)::numeric(14,2) AS restante,
            to_char(max(p.month), 'YYYY-MM') AS ultima_parcela
     FROM fin.v_installment_plan p
     JOIN fin.v_accounts a ON a.id = p.account_id
     GROUP BY p.group_id, p.description, a.name
     HAVING count(*) FILTER (WHERE p.month >= date_trunc('month', current_date)) > 0
     ORDER BY restante DESC`);
  return { por_mes: porMes.rows, parcelamentos: parcelamentos.rows };
}

export async function contas(read: Db) {
  const { rows } = await read.query(
    `SELECT name AS nome, type AS tipo, subtype AS subtipo, nullif(number_last4, '') AS final, balance AS saldo,
            credit_limit AS limite, available_credit_limit AS limite_disponivel, balance_due_date AS vencimento_fatura,
            (consent_expires_at AT TIME ZONE 'America/Sao_Paulo')::date AS consentimento_expira_em,
            consent_expiring AS consentimento_expirando, bank_data_updated_at AS atualizado_com_banco_em
     FROM fin.v_accounts
     WHERE NOT coalesce(is_hidden, false)
     ORDER BY type, name`);
  return { contas: rows };
}

export async function faturas(read: Db, { meses }: Args) {
  const { rows } = await read.query(
    `SELECT account AS conta, due_date AS vencimento, total_amount AS total, minimum_payment_amount AS pagamento_minimo,
            finance_charges_total AS encargos, payments_total AS pagamentos
     FROM fin.v_bills
     WHERE due_date >= (date_trunc('month', current_date) - make_interval(months => $1::int))::date
     ORDER BY due_date DESC, account`, [meses]);
  return { faturas: rows };
}

export async function categorias(read: Db) {
  const { rows } = await read.query(
    `SELECT c.name AS nome, c.kind AS tipo, c.color AS cor,
            coalesce(json_agg(json_build_object('id', r.id, 'tipo', r.match_type, 'padrao', r.pattern, 'prioridade', r.priority)
                              ORDER BY r.priority, r.id) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS regras
     FROM fin.categories c
     LEFT JOIN fin.category_rules r ON r.category_id = c.id AND r.enabled
     GROUP BY c.id, c.name, c.kind, c.color, c.sort_order
     ORDER BY c.sort_order, c.name`);
  return { categorias: rows };
}

/**
 * Visão de um mês: resumo, mês anterior, média dos até 3 meses anteriores que têm dados,
 * gastos por categoria (com a média de cada uma) e quanto já está comprometido com parcelas
 * nos próximos 3 meses (a partir de hoje). Todas as contas de dinheiro ficam no banco.
 */
export async function visaoDoMes(read: Db, args: Args) {
  const mes = (args.mes as string | undefined) ?? currentMonth();
  const first = `${mes}-01`;
  const anteriorMes = shiftMonth(first, -1).slice(0, 7);

  const { rows: meses } = await read.query<{ mes: string; gastos: string; receitas: string; saldo: string; sem_categoria: number }>(
    `SELECT to_char(month, 'YYYY-MM') AS mes, expenses::numeric(14,2) AS gastos, income::numeric(14,2) AS receitas,
            net::numeric(14,2) AS saldo, uncategorized::int AS sem_categoria
     FROM fin.v_monthly_summary
     WHERE month IN ($1::date, ($1::date - interval '1 month')::date)`, [first]);
  const vazio = { mes, gastos: '0.00', receitas: '0.00', saldo: '0.00', sem_categoria: 0 };

  const media = (await read.query<{ meses: number; gastos: string | null; receitas: string | null }>(
    `SELECT count(*)::int AS meses, round(avg(expenses), 2)::numeric(14,2) AS gastos, round(avg(income), 2)::numeric(14,2) AS receitas
     FROM fin.v_monthly_summary
     WHERE month BETWEEN ($1::date - interval '3 months')::date AND ($1::date - interval '1 month')::date`, [first])).rows[0]!;

  // Gastos do mês e dos 3 anteriores, linha a linha (o filtro em local_date usa o índice).
  const base = `
    WITH base AS (
      SELECT month, account, account_subtype = 'CREDIT_CARD' AS cartao, category_id,
             coalesce(category, 'Sem categoria') AS category, -signed_amount AS valor
      FROM fin.v_transactions
      WHERE flow = 'expense' AND NOT ignored
        AND local_date >= ($1::date - interval '3 months') AND local_date < ($1::date + interval '1 month')
    )`;
  // Total do mês e média dos meses anteriores com dados ($2 = quantos).
  const totais = `
    coalesce(sum(valor) FILTER (WHERE month = $1::date), 0)::numeric(14,2) AS gastos,
    (CASE WHEN $2::int > 0 THEN round(coalesce(sum(valor) FILTER (WHERE month < $1::date), 0) / $2::int, 2) END)::numeric(14,2) AS media_3m`;

  const { rows: categorias } = await read.query(
    `${base}
     SELECT b.category AS categoria, coalesce(c.color, '#928374') AS cor,
            coalesce(sum(b.valor) FILTER (WHERE b.month = $1::date), 0)::numeric(14,2) AS total,
            (CASE WHEN $2::int > 0 THEN round(coalesce(sum(b.valor) FILTER (WHERE b.month < $1::date), 0) / $2::int, 2) END)::numeric(14,2) AS media_3m
     FROM base b
     LEFT JOIN fin.categories c ON c.id = b.category_id
     WHERE $3::text IS NULL OR b.cartao = ($3::text = 'cartao')
     GROUP BY b.category, c.color
     ORDER BY total DESC, media_3m DESC NULLS LAST`, [first, media.meses, args.origem ?? null]);

  const { rows: origens } = await read.query<{ cartao: boolean; gastos: string; media_3m: string | null }>(
    `${base} SELECT cartao, ${totais} FROM base GROUP BY cartao`, [first, media.meses]);
  const lado = (cartao: boolean) => {
    const r = origens.find((o) => o.cartao === cartao);
    return { gastos: r?.gastos ?? '0.00', media_3m: r ? r.media_3m : media.meses > 0 ? '0.00' : null };
  };

  const { rows: cartoes } = await read.query(
    `${base} SELECT account AS conta, ${totais} FROM base WHERE cartao GROUP BY account ORDER BY gastos DESC, conta`,
    [first, media.meses]);

  const { rows: parcelas } = await read.query(
    `SELECT to_char(m, 'YYYY-MM') AS mes, coalesce(sum(f.committed), 0)::numeric(14,2) AS comprometido
     FROM generate_series(date_trunc('month', current_date), date_trunc('month', current_date) + interval '2 months', interval '1 month') AS m
     LEFT JOIN fin.v_future_commitments f ON f.month = m::date
     GROUP BY m
     ORDER BY m`);

  return {
    mes,
    em_andamento: mes === currentMonth(),
    resumo: meses.find((m) => m.mes === mes) ?? vazio,
    anterior: meses.find((m) => m.mes === anteriorMes) ?? null,
    media_3m: media.meses > 0 ? { meses: media.meses, gastos: media.gastos, receitas: media.receitas } : null,
    origem: args.origem ?? 'todas',
    categorias,
    por_origem: { cartao: lado(true), conta: lado(false) },
    cartoes,
    parcelas_proximos_meses: parcelas,
  };
}

/** Quantas transações uma regra "contém" pegaria, com as descrições mais comuns. Não grava nada. */
export async function previaRegra(read: Db, { padrao }: Args) {
  const { rows } = await read.query<{ descricao: string; categoria: string | null; n: number; _total: number }>(
    `SELECT description AS descricao, category AS categoria, count(*)::int AS n, (sum(count(*)) OVER ())::int AS _total
     FROM fin.v_transactions
     WHERE position(fin.norm_text($1) IN fin.norm_text(bank_description)) > 0
     GROUP BY description, category
     ORDER BY n DESC, description
     LIMIT 8`, [padrao]);
  return { padrao, casam: rows[0]?._total ?? 0, exemplos: rows.map(({ _total: _t, ...row }) => row) };
}

// --- sugestões da IA (sync/src/classify.ts grava; aqui o usuário aplica ou recusa) ------------

// Pode ir no "aplicar todas" só gasto em saída de dinheiro ou receita em entrada. Movimentação
// (fatura, investimento, transferência) tira o valor dos relatórios, e uma descrição maliciosa
// poderia induzir a IA a esconder gastos assim: essas, e as que contradizem o sinal, só uma a uma.
const EM_LOTE = "((c.kind = 'expense' AND v.total < 0) OR (c.kind = 'income' AND v.total > 0))";

/** Estabelecimentos com sugestão de categoria e transações ainda sem categoria; maior valor primeiro. */
export async function sugestoes(read: Db) {
  const { rows } = await read.query<{ transacoes: number }>(
    `SELECT v.key AS chave, v.example AS exemplo, v.category AS categoria, v.color AS cor, v.confidence AS confianca,
            v.reason AS motivo, v.transactions AS transacoes, v.total::numeric(14,2) AS total, v.last_date AS ultima,
            ${EM_LOTE} AS em_lote
     FROM fin.v_suggestions v
     JOIN fin.categories c ON c.id = v.category_id
     ORDER BY abs(v.total) DESC, v.key`);
  return {
    total_grupos: rows.length,
    total_transacoes: rows.reduce((acc, r) => acc + r.transacoes, 0),
    grupos: rows,
  };
}

async function existeSugestao(read: Db, chave: string): Promise<void> {
  const { rowCount } = await read.query('SELECT 1 FROM fin.category_suggestions WHERE key = $1', [chave]);
  if (!rowCount) throw new UserError('Sugestão não encontrada.', 404);
}

/** Categoriza (override) as transações sem categoria do estabelecimento e marca a sugestão como aplicada. */
async function aplicarChave({ read, write }: Pools, chave: string, categoryId: string): Promise<number> {
  const { rows } = await read.query<{ id: string }>(
    `SELECT id FROM fin.v_transactions
     WHERE category_id IS NULL AND NOT ignored AND fin.suggestion_key(bank_description) = $1`, [chave]);
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await write.query(
      `INSERT INTO fin.transaction_overrides (transaction_id, category_id)
       SELECT unnest($1::bigint[]), $2
       ON CONFLICT (transaction_id) DO UPDATE SET category_id = EXCLUDED.category_id, updated_at = now()`,
      [ids, categoryId]);
  }
  await write.query("UPDATE fin.category_suggestions SET status = 'applied', decided_at = now() WHERE key = $1", [chave]);
  return ids.length;
}

export async function aplicarSugestao(pools: Pools, { chave, categoria }: Args) {
  await existeSugestao(pools.read, chave as string);
  const cat = await findCategory(pools.read, categoria as string);
  return { ok: true, aplicadas: await aplicarChave(pools, chave as string, cat.id) };
}

export async function recusarSugestao({ read, write }: Pools, { chave }: Args) {
  await existeSugestao(read, chave as string);
  await write.query("UPDATE fin.category_suggestions SET status = 'rejected', decided_at = now() WHERE key = $1", [chave]);
  return { ok: true };
}

/** Aplica de uma vez as sugestões com confiança a partir de `minimo` que podem ir em lote (EM_LOTE). */
export async function aplicarConfiaveis(pools: Pools, { minimo }: Args) {
  const { rows } = await pools.read.query<{ key: string; category_id: string }>(
    `SELECT v.key, v.category_id
     FROM fin.v_suggestions v
     JOIN fin.categories c ON c.id = v.category_id
     WHERE v.confidence >= $1 AND ${EM_LOTE}
     ORDER BY v.key`, [minimo]);
  let transacoes = 0;
  for (const g of rows) transacoes += await aplicarChave(pools, g.key, g.category_id);
  return { ok: true, grupos: rows.length, transacoes };
}

// --- meta do cartão à vista e alerta de parcelamentos ----------------------------------------

const META_KEY = 'meta_cartao_avista';
const CONTEXTO_KEY = 'contexto_mcp';

/** Contexto que o usuário escreveu sobre a casa e as contas (vai no fim das instruções do MCP) ou null. */
export async function contextoMcp(read: Db): Promise<string | null> {
  const { rows } = await read.query<{ v: string }>("SELECT value #>> '{}' AS v FROM fin.user_settings WHERE key = $1", [CONTEXTO_KEY]);
  return rows[0]?.v ?? null;
}

/** Meta mensal das compras à vista no cartão (texto com 2 casas) ou null. */
export async function meta(read: Db) {
  const { rows } = await read.query<{ v: string }>("SELECT value #>> '{}' AS v FROM fin.user_settings WHERE key = $1", [META_KEY]);
  return { meta_cartao_avista: rows[0]?.v ?? null };
}

export async function definirMeta({ write }: Pools, { meta_cartao_avista }: Args) {
  await write.query(
    `INSERT INTO fin.user_settings (key, value) VALUES ($1, to_jsonb(round($2::numeric, 2)::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [META_KEY, meta_cartao_avista]);
  return { ok: true, meta_cartao_avista: (Math.round(Number(meta_cartao_avista) * 100) / 100).toFixed(2) };
}

function diasNoMes(mes: string): number {
  const [y, m] = mes.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Gasto à vista no cartão, acumulado dia a dia (pela data da compra), até `ate`. */
async function acumuladoCartaoAvista(read: Db, mes: string, ate: number) {
  const { rows } = await read.query<{ dia: number; gasto: string; acumulado: string }>(
    `WITH g AS (
       SELECT extract(day FROM local_date)::int AS dia, sum(-signed_amount) AS gasto
       FROM fin.v_transactions
       WHERE NOT ignored AND flow = 'expense' AND account_subtype = 'CREDIT_CARD' AND total_installments IS NULL
         AND local_date >= $1::date AND local_date < ($1::date + interval '1 month') AND local_date <= current_date
       GROUP BY 1
     )
     SELECT d.dia, coalesce(g.gasto, 0)::numeric(14,2) AS gasto,
            (sum(coalesce(g.gasto, 0)) OVER (ORDER BY d.dia))::numeric(14,2) AS acumulado
     FROM generate_series(1, $2::int) AS d(dia)
     LEFT JOIN g ON g.dia = d.dia
     ORDER BY d.dia`, [`${mes}-01`, ate]);
  return rows;
}

/**
 * Acompanhamento da meta num mês: gasto à vista no cartão até hoje (ou o mês inteiro, se
 * fechado), ritmo ideal até hoje (meta × dia ÷ dias do mês), projeção para o fim do mês e
 * status. Inclui o acumulado do mês anterior, para comparar. Contas de dinheiro no banco.
 */
export async function acompanhamentoMeta(read: Db, args: Args) {
  const atual = currentMonth();
  const mes = (args.mes as string | undefined) ?? atual;
  if (mes > atual) throw new UserError('Mês futuro: ainda não há gasto para acompanhar.');
  const dias = diasNoMes(mes);
  const emAndamento = mes === atual;
  const diaAtual = emAndamento ? Number(today().slice(8, 10)) : dias;

  const metaValor = (await meta(read)).meta_cartao_avista;
  const porDia = await acumuladoCartaoAvista(read, mes, diaAtual);
  const gasto = porDia.at(-1)?.acumulado ?? '0.00';

  const { rows: [conta] } = await read.query<{ ritmo: string | null; projecao: string; estourou: boolean; acima: boolean }>(
    `SELECT round($1::numeric * $2 / $3, 2)::numeric(14,2) AS ritmo,
            round($4::numeric / $2 * $3, 2)::numeric(14,2) AS projecao,
            coalesce($4::numeric > $1::numeric, false) AS estourou,
            coalesce($4::numeric > round($1::numeric * $2 / $3, 2), false) AS acima`,
    [metaValor, diaAtual, dias, gasto]);
  const status = metaValor === null ? 'sem_meta'
    : conta!.estourou ? 'estourou'
    : emAndamento && conta!.acima ? 'acima'
    : 'dentro';

  const anterior = shiftMonth(`${mes}-01`, -1).slice(0, 7);
  const porDiaAnterior = await acumuladoCartaoAvista(read, anterior, diasNoMes(anterior));
  return {
    mes,
    em_andamento: emAndamento,
    meta: metaValor,
    dias_no_mes: dias,
    dia_atual: diaAtual,
    gasto,
    ritmo_ideal: conta!.ritmo,
    projecao: emAndamento ? conta!.projecao : gasto,
    status,
    por_dia: porDia,
    mes_anterior: {
      mes: anterior,
      total: porDiaAnterior.at(-1)?.acumulado ?? '0.00',
      por_dia: porDiaAnterior.map(({ dia, acumulado }) => ({ dia, acumulado })),
    },
  };
}

/** Compras parceladas feitas nos últimos `dias` dias (para o alerta: parcelar só o que é da casa e foi planejado). */
export async function parcelamentosNovos(read: Db, { dias }: Args) {
  const { rows } = await read.query(
    `SELECT group_id::int AS grupo, description AS compra, account AS conta, total_installments AS parcelas,
            installment_amount AS valor_parcela, total_amount AS total, purchase_date AS data_compra,
            purchase_date_known AS data_exata
     FROM fin.v_installment_purchases
     WHERE purchase_date >= current_date - $1::int
     ORDER BY purchase_date DESC, group_id DESC`, [dias]);
  return { dias, novos: rows };
}

// --- previsão: o guardião do compra ou não compra ----------------------------------------------

const PREVISAO_MESES_MEDIA = 6;
const PREVISAO_MESES_FIXOS = 3;
/** Gasto único (que não se repete na janela) a partir deste valor fica fora da média. */
const PREVISAO_PONTUAL_MINIMO = 2000;
/** Categorias que não entram em "onde dá para cortar". */
const ESSENCIAIS = ['Moradia', 'Saúde', 'Educação', 'Seguros', 'Impostos, tarifas e juros'];

/**
 * Médias da previsão, sobre os meses completos antes do atual:
 *  - entradas e cartão à vista: média dos últimos 6 meses;
 *  - gastos da conta (débito, Pix, boletos): média dos últimos 3, para pegar o valor atual das
 *    contas fixas (ex.: uma conta que começou há pouco);
 *  - parcelas ficam de fora: entram exatas, pelo plano de parcelas.
 * Ficam fora da média: categorias e trechos excluídos pelo usuário (algo que acabou) e gastos
 * grandes que aconteceram uma vez só na janela (nem a descrição nem um valor parecido, na mesma
 * conta e categoria, se repetem em outro mês).
 */
async function mediasDaPrevisao(read: Db, inicio: string, atual: string, fixosDe: string) {
  const { rows: [r] } = await read.query<{ medias: Record<string, string>; categorias: unknown[]; encerrados: unknown[]; pontuais: unknown[]; cortaveis: unknown[] }>(
    `WITH janela AS (
       SELECT t.local_date, t.month, t.account_id, t.account, t.account_subtype, t.description, t.category_id, t.category,
              t.flow, t.signed_amount, fin.suggestion_key(t.description) AS chave
       FROM fin.v_transactions t
       WHERE NOT t.ignored AND t.flow IN ('income', 'expense') AND t.total_installments IS NULL
         AND t.month >= $1::date AND t.month < $2::date
     ),
     classif AS (
       SELECT j.*, coalesce(ec.id, ep.id) AS exclusao_id,
         CASE
           WHEN ec.id IS NOT NULL THEN 'categoria'
           WHEN ep.id IS NOT NULL THEN 'encerrado'
           WHEN abs(j.signed_amount) >= $3::numeric AND NOT EXISTS (
             SELECT 1 FROM janela o
             WHERE o.month <> j.month AND o.flow = j.flow
               AND (o.chave = j.chave
                    OR (o.account_id = j.account_id AND o.category_id IS NOT DISTINCT FROM j.category_id
                        AND abs(o.signed_amount) BETWEEN abs(j.signed_amount) * 0.9 AND abs(j.signed_amount) * 1.1)))
             THEN 'pontual'
         END AS fora
       FROM janela j
       LEFT JOIN LATERAL (
         SELECT e.id FROM fin.forecast_exclusions e
         WHERE e.active AND e.category_id = j.category_id ORDER BY e.id LIMIT 1) ec ON true
       LEFT JOIN LATERAL (
         SELECT e.id FROM fin.forecast_exclusions e
         WHERE e.active AND e.pattern IS NOT NULL AND position(fin.norm_text(e.pattern) IN fin.norm_text(j.description)) > 0
         ORDER BY e.id LIMIT 1) ep ON true
     )
     SELECT
       (SELECT json_build_object(
          'entradas', coalesce(round(sum(signed_amount) FILTER (WHERE flow = 'income') / $4::numeric, 2), 0)::numeric(14,2)::text,
          'gastos_conta', coalesce(round(sum(-signed_amount) FILTER (WHERE flow = 'expense' AND account_subtype <> 'CREDIT_CARD' AND month >= $5::date) / $6::numeric, 2), 0)::numeric(14,2)::text,
          'cartao_avista', coalesce(round(sum(-signed_amount) FILTER (WHERE flow = 'expense' AND account_subtype = 'CREDIT_CARD') / $4::numeric, 2), 0)::numeric(14,2)::text)
        FROM classif WHERE fora IS NULL) AS medias,
       (SELECT coalesce(json_agg(json_build_object('id', e.id, 'categoria', c.name, 'motivo', e.reason,
                 'total', coalesce((SELECT abs(sum(cl.signed_amount)) FROM classif cl WHERE cl.exclusao_id = e.id AND cl.fora = 'categoria'), 0)::numeric(14,2)::text)
               ORDER BY e.id), '[]')
        FROM fin.forecast_exclusions e JOIN fin.categories c ON c.id = e.category_id WHERE e.active) AS categorias,
       (SELECT coalesce(json_agg(json_build_object('id', e.id, 'padrao', e.pattern, 'motivo', e.reason,
                 'total', coalesce((SELECT abs(sum(cl.signed_amount)) FROM classif cl WHERE cl.exclusao_id = e.id AND cl.fora = 'encerrado'), 0)::numeric(14,2)::text)
               ORDER BY e.id), '[]')
        FROM fin.forecast_exclusions e WHERE e.active AND e.pattern IS NOT NULL) AS encerrados,
       (SELECT coalesce(json_agg(json_build_object('data', p.local_date, 'descricao', p.description, 'conta', p.account,
                 'fluxo', p.flow, 'valor', abs(p.signed_amount)::numeric(14,2)::text) ORDER BY abs(p.signed_amount) DESC), '[]')
        FROM (SELECT * FROM classif WHERE fora = 'pontual' ORDER BY abs(signed_amount) DESC LIMIT 30) p) AS pontuais,
       (SELECT coalesce(json_agg(json_build_object('categoria', k.category, 'media_mensal', k.media::text) ORDER BY k.media DESC), '[]')
        FROM (SELECT category, round(sum(-signed_amount) / $4::numeric, 2)::numeric(14,2) AS media
              FROM classif
              WHERE fora IS NULL AND flow = 'expense' AND category IS NOT NULL AND NOT (category = ANY($7::text[]))
              GROUP BY category HAVING sum(-signed_amount) > 0) k) AS cortaveis`,
    [inicio, atual, PREVISAO_PONTUAL_MINIMO, PREVISAO_MESES_MEDIA, fixosDe, PREVISAO_MESES_FIXOS, ESSENCIAIS]);
  return r!;
}

// Objetivo `g` (fin.goals) a partir do mês $1: o aporte começa no início combinado ou neste mês, o que
// vier depois (o que já foi guardado o usuário informa em saved_amount), e dura até completar o que falta.
const OBJETIVO_INICIO = `greatest(g.start_month, date_trunc('month', $1::date)::date)`;
const OBJETIVO_MESES = `ceil((g.target_amount - g.saved_amount) / g.monthly_amount)::int`;
// Teto do "fica pronto": um aporte minúsculo (R$ 0,01 para milhões) daria bilhões de meses.
const MAX_MESES_OBJETIVO = 1200;

/** Parcelas (exatas, do plano de parcelas), gastos planejados e aportes dos objetivos de cada mês do horizonte. */
async function compromissosDaPrevisao(read: Db, atual: string, meses: number) {
  const { rows } = await read.query<{ mes: string; parcelas: string; planejados: string; guardar: string }>(
    `WITH meses AS (
       SELECT (date_trunc('month', $1::date) + make_interval(months => k))::date AS mes
       FROM generate_series(0, $2::int - 1) AS k
     ),
     plano AS (
       SELECT (p.first_month + make_interval(months => k))::date AS mes,
              CASE WHEN k = 0 THEN p.total_amount - trunc(p.total_amount / p.installments, 2) * (p.installments - 1)
                   ELSE trunc(p.total_amount / p.installments, 2) END AS valor
       FROM fin.planned_expenses p
       CROSS JOIN LATERAL generate_series(0, p.installments - 1) AS k
       WHERE p.status = 'planejado'
     ),
     aporte AS (
       SELECT (${OBJETIVO_INICIO} + make_interval(months => k))::date AS mes,
              least(g.monthly_amount, g.target_amount - g.saved_amount - g.monthly_amount * k) AS valor
       FROM fin.goals g
       -- Só até o fim do horizonte: o aporte começa neste mês ou depois, e o que passa dele não entra.
       CROSS JOIN LATERAL generate_series(0, least(${OBJETIVO_MESES}, $2::int) - 1) AS k
       WHERE g.status = 'ativo' AND g.target_amount > g.saved_amount
     )
     SELECT to_char(m.mes, 'YYYY-MM') AS mes,
            coalesce((SELECT sum(i.amount) FROM fin.v_installment_plan i WHERE i.month = m.mes), 0)::numeric(14,2) AS parcelas,
            coalesce((SELECT sum(pl.valor) FROM plano pl WHERE pl.mes = m.mes), 0)::numeric(14,2) AS planejados,
            coalesce((SELECT sum(a.valor) FROM aporte a WHERE a.mes = m.mes), 0)::numeric(14,2) AS guardar
     FROM meses m
     ORDER BY m.mes`, [atual, meses]);
  return rows;
}

/** Objetivos ativos, com o que falta e o mês em que ficam prontos no ritmo combinado. */
async function objetivosDaPrevisao(read: Db, atual: string) {
  const { rows } = await read.query<{ id: number; nome: string; por_mes: string; falta: string }>(
    `SELECT g.id::int, g.name AS nome, g.reason AS motivo, g.target_amount AS alvo, g.saved_amount AS guardado,
            greatest(g.target_amount - g.saved_amount, 0)::numeric(14,2) AS falta, g.monthly_amount AS por_mes,
            to_char(${OBJETIVO_INICIO}, 'YYYY-MM') AS inicio,
            CASE WHEN g.target_amount > g.saved_amount
                 THEN to_char(${OBJETIVO_INICIO} + make_interval(months => least(${OBJETIVO_MESES}, ${MAX_MESES_OBJETIVO}) - 1), 'YYYY-MM') END AS fica_pronto,
            g.status
     FROM fin.goals g WHERE g.status = 'ativo' ORDER BY g.created_at, g.id`, [atual]);
  return rows;
}

/**
 * O guardado: o saldo dos investimentos (fin.v_investments, vindos da Pluggy) que não foram
 * resgatados, por dono. `data` é a posição mais antiga. null se a Pluggy não trouxe nenhum.
 */
async function guardadoAtual(read: Db) {
  const { rows } = await read.query<{ conta: string; saldo: string; data: string | null }>(
    `SELECT coalesce(owner, 'Sem conta') AS conta, sum(balance)::numeric(14,2) AS saldo, to_char(min(balance_date), 'YYYY-MM-DD') AS data
     FROM fin.v_investments
     WHERE status IS DISTINCT FROM 'TOTAL_WITHDRAWAL' AND balance > 0
     GROUP BY 1 ORDER BY 2 DESC, 1`);
  if (!rows.length) return null;
  const datas = rows.map((r) => r.data).filter((d): d is string => !!d).sort();
  return { total: reais(rows.reduce((t, r) => t + centavos(r.saldo), 0n)), data: datas[0] ?? null, contas: rows };
}

/**
 * Previsão dos próximos meses (contando o atual) e, com `valor`, o veredito de uma compra:
 * cabe, no limite ou não cabe; o menor saldo depois dela; a partir de quando cabe; e quanto
 * cortar por mês, desde já, para caber no mês pedido. O saldo começa na `reserva` (padrão 0):
 * o limite do cartão não conta, só o que entra e o que já se sabe que vai sair.
 */
export async function previsao(read: Db, args: Args) {
  const atual = currentMonth();
  const inicio = shiftMonth(`${atual}-01`, -PREVISAO_MESES_MEDIA).slice(0, 7);
  const fixosDe = shiftMonth(`${atual}-01`, -PREVISAO_MESES_FIXOS).slice(0, 7);
  const cenario = (args.cenario as string | undefined) ?? 'media';
  const horizonte = (args.meses as number | undefined) ?? 12;

  const m = await mediasDaPrevisao(read, `${inicio}-01`, `${atual}-01`, `${fixosDe}-01`);
  const metaValor = (await meta(read)).meta_cartao_avista;
  if (cenario === 'meta' && metaValor === null) {
    throw new UserError('Sem meta do cartão definida: defina a meta ou use o cenário da média.');
  }
  const cartao = cenario === 'meta' ? metaValor! : m.medias.cartao_avista!;
  const parcelasCompra = args.valor === undefined ? 1 : ((args.parcelas as number | undefined) ?? 1);
  // Meses a mais (não exibidos) para as parcelas de uma compra no fim do horizonte entrarem no veredito.
  const compromissos = await compromissosDaPrevisao(read, `${atual}-01`, horizonte + parcelasCompra - 1);
  const objetivos = await objetivosDaPrevisao(read, `${atual}-01`);
  const planejados = await read.query(
    `SELECT id::int, description AS descricao, reason AS motivo, total_amount AS valor, installments AS parcelas,
            trunc(total_amount / installments, 2)::numeric(14,2) AS valor_parcela, to_char(first_month, 'YYYY-MM') AS mes, status
     FROM fin.planned_expenses WHERE status = 'planejado' ORDER BY first_month, id`);

  const reserva = reais(centavos(Number(args.reserva ?? 0)));
  const margem = reais(centavos(Number(args.margem ?? 1000)));
  const compra = args.valor === undefined ? undefined : {
    valor: reais(centavos(Number(args.valor))),
    parcelas: (args.parcelas as number | undefined) ?? 1,
    mes: (args.mes as string | undefined) ?? atual,
  };
  const guardado = await guardadoAtual(read);
  const proj = projetar(compromissos.map((c) => ({
    mes: c.mes, entradas: m.medias.entradas!, gastos_conta: m.medias.gastos_conta!, cartao_avista: cartao,
    parcelas: c.parcelas, planejados: c.planejados, guardar_planejado: c.guardar,
  })), { reserva, margem, compra, exibir: horizonte, ...(guardado ? { guardado: guardado.total } : {}) });
  // A troca: a compra equivale a quantos meses de aporte de cada objetivo.
  const equivale = proj.compra ? objetivos.filter((o) => centavos(o.falta) > 0n).map((o) => {
    const total = centavos(proj.compra!.valor);
    const porMes = centavos(o.por_mes);
    return { id: o.id, nome: o.nome, meses: Number((total + porMes - 1n) / porMes) };
  }) : [];

  return {
    base: { meses_media: PREVISAO_MESES_MEDIA, de: inicio, ate: shiftMonth(`${atual}-01`, -1).slice(0, 7), meses_fixos: PREVISAO_MESES_FIXOS, fixos_de: fixosDe },
    cenario,
    meta: metaValor,
    reserva,
    margem,
    medias: { ...m.medias, cartao_avista: cartao, cartao_avista_media: m.medias.cartao_avista },
    fora_da_media: { categorias: m.categorias, encerrados: m.encerrados, pontuais: m.pontuais },
    planejados: planejados.rows,
    objetivos,
    cortaveis: m.cortaveis,
    meses: proj.meses,
    // O guardado de hoje e até onde ele chega cobrindo os meses negativos (fora do veredito).
    guardado: guardado && proj.guardado ? { total: guardado.total, data: guardado.data, contas: guardado.contas, ...proj.guardado } : null,
    compra: proj.compra ? { descricao: (args.descricao as string | undefined) ?? null, ...proj.compra, equivale } : null,
  };
}

/** Registra uma compra aprovada (ou um gasto sazonal conhecido) para entrar na previsão. */
export async function planejarGasto({ write }: Pools, { descricao, motivo, valor, parcelas, mes }: Args) {
  const { rows } = await write.query<{ id: number }>(
    `INSERT INTO fin.planned_expenses (description, reason, total_amount, installments, first_month)
     VALUES ($1, $2, round($3::numeric, 2), $4, $5::date) RETURNING id::int`,
    [descricao, motivo ?? null, valor, parcelas ?? 1, `${mes}-01`]);
  return { ok: true, id: rows[0]!.id };
}

export async function atualizarPlanejado({ write }: Pools, { id, status }: Args) {
  const { rowCount } = await write.query(
    'UPDATE fin.planned_expenses SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  if (!rowCount) throw new UserError('Gasto planejado não encontrado.', 404);
  return { ok: true, id, status };
}

/** Tira das médias da previsão algo que não vai se repetir: uma categoria ou um trecho da descrição. */
export async function excluirDaPrevisao({ read, write }: Pools, { padrao, categoria, motivo }: Args) {
  if ((padrao === undefined) === (categoria === undefined)) {
    throw new UserError('Informe um trecho da descrição (padrao) ou uma categoria, não os dois.');
  }
  const cat = categoria === undefined ? null : await findCategory(read, categoria as string);
  const { rows } = await write.query<{ id: number }>(
    `INSERT INTO fin.forecast_exclusions (pattern, category_id, reason) VALUES ($1, $2, $3) RETURNING id::int`,
    [padrao === undefined ? null : (padrao as string).trim().toLowerCase(), cat?.id ?? null, motivo]);
  return { ok: true, id: rows[0]!.id, categoria: cat?.name ?? null, padrao: padrao ?? null };
}

export async function removerExclusao({ write }: Pools, { id }: Args) {
  const { rowCount } = await write.query('UPDATE fin.forecast_exclusions SET active = false WHERE id = $1 AND active', [id]);
  if (!rowCount) throw new UserError('Exclusão não encontrada.', 404);
  return { ok: true, id };
}

/** Cria um objetivo: juntar `valor` guardando `por_mes` a partir de `inicio`. */
export async function criarObjetivo({ write }: Pools, { nome, motivo, valor, ja_guardado, por_mes, inicio }: Args) {
  const { rows } = await write.query<{ id: number }>(
    `INSERT INTO fin.goals (name, reason, target_amount, saved_amount, monthly_amount, start_month)
     VALUES ($1, $2, round($3::numeric, 2), round($4::numeric, 2), round($5::numeric, 2), $6::date) RETURNING id::int`,
    [nome, motivo ?? null, valor, ja_guardado ?? 0, por_mes, `${(inicio as string | undefined) ?? currentMonth()}-01`]);
  return { ok: true, id: rows[0]!.id };
}

// Campos que o usuário pode ajustar num objetivo; `?` vira o número do parâmetro.
const CAMPOS_OBJETIVO = {
  valor: 'target_amount = round(?::numeric, 2)',
  ja_guardado: 'saved_amount = round(?::numeric, 2)',
  por_mes: 'monthly_amount = round(?::numeric, 2)',
  inicio: "start_month = (? || '-01')::date",
  status: 'status = ?',
} as const;

/** Ajusta um objetivo: valor, já guardado, aporte, início ou status (o nome fica como foi criado). */
export async function atualizarObjetivo({ write }: Pools, args: Args) {
  const sets: string[] = [];
  const params: unknown[] = [args.id];
  for (const [campo, sql] of Object.entries(CAMPOS_OBJETIVO)) {
    if (args[campo] === undefined) continue;
    params.push(args[campo]);
    sets.push(sql.replace('?', `$${params.length}`));
  }
  if (!sets.length) throw new UserError('Nada para mudar: informe valor, ja_guardado, por_mes, inicio ou status.');
  const { rowCount } = await write.query(`UPDATE fin.goals SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  if (!rowCount) throw new UserError('Objetivo não encontrado.', 404);
  return { ok: true, id: args.id };
}

// --- a pagar até o próximo salário (contas fixas em fin.recurring_bills, migration 0010) ---------

const addDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * O que sai das contas do último salário até o próximo: faturas fechadas (pagas quando o pagamento
 * chega no cartão), a fatura aberta que vence antes do salário (estimativa: o que já foi gasto) e
 * as contas fixas (pagas quando aparece um pagamento com o trecho da descrição, em qualquer conta).
 * Compara com o saldo de cada conta corrente: quanto falta e em que dia o dinheiro acaba.
 */
export async function aPagar(read: Db, _args: Args = {}) {
  const hoje = today();
  // Último salário dos últimos 45 dias; o próximo é um mês depois (o primeiro depois de hoje).
  const sal = (await read.query<{ data: string | null; valor: string | null; proximo: string | null }>(
    `WITH s AS (
       SELECT local_date, signed_amount FROM fin.v_transactions
       WHERE flow = 'income' AND category = 'Salário' AND NOT ignored AND local_date BETWEEN $1::date - 45 AND $1::date
     ), u AS (SELECT max(local_date) AS d FROM s)
     SELECT to_char(u.d, 'YYYY-MM-DD') AS data,
            (SELECT sum(signed_amount) FROM s WHERE s.local_date > u.d - 5)::numeric(14,2) AS valor,
            (SELECT to_char(min((u.d + make_interval(months => k))::date), 'YYYY-MM-DD') FROM generate_series(1, 3) AS k
             WHERE (u.d + make_interval(months => k))::date > $1::date) AS proximo
     FROM u`, [hoje])).rows[0]!;
  const inicioCiclo = sal.data ?? hoje;
  const proximo = sal.proximo ?? addDias(hoje, 30);
  const limiteAtraso = addDias(hoje, -15);
  const desde = inicioCiclo < limiteAtraso ? inicioCiclo : limiteAtraso;

  const contas = (await read.query<{ id: number; conta: string; saldo: string; atualizado_em: string | null }>(
    `SELECT id::int, name AS conta, coalesce(balance, 0)::numeric(14,2) AS saldo, bank_data_updated_at AS atualizado_em
     FROM fin.v_accounts WHERE subtype = 'CHECKING_ACCOUNT' AND NOT coalesce(is_hidden, false)
     ORDER BY balance DESC NULLS LAST, name`)).rows;

  const faturas = (await read.query<ItemBruto>(
    `SELECT 'fatura' AS tipo, id::int, 'Fatura do ' || account AS descricao, payer_account_id::int AS conta_id,
            to_char(due_date, 'YYYY-MM-DD') AS vencimento, total_amount AS valor, paid_amount AS pago,
            to_char(paid_at, 'YYYY-MM-DD') AS pago_em, false AS pago_manual
     FROM fin.v_bill_status WHERE total_amount > 0 AND due_date >= $1::date AND due_date < $2::date`, [desde, proximo])).rows;

  // Fatura aberta que vence antes do salário: um mês depois da última fechada; o valor é o que já
  // foi gasto no cartão e ainda não está numa fatura (sem as parcelas com data futura).
  const abertas = (await read.query<ItemBruto>(
    `WITH ult AS (
       SELECT account_id, max(account) AS account, max(due_date) AS due, max(payer_account_id) AS payer
       FROM fin.v_bill_status GROUP BY account_id
     )
     SELECT 'fatura_aberta' AS tipo, NULL::int AS id, 'Fatura do ' || u.account || ' (aberta)' AS descricao, u.payer::int AS conta_id,
            to_char((u.due + interval '1 month')::date, 'YYYY-MM-DD') AS vencimento, sum(x.amount)::numeric(14,2) AS valor,
            '0.00' AS pago, NULL AS pago_em, false AS pago_manual
     FROM ult u
     JOIN fin.v_unbilled_card x ON x.account_id = u.account_id AND x.local_date > u.due - 25 AND x.local_date <= $3::date
     WHERE (u.due + interval '1 month')::date >= $1::date AND (u.due + interval '1 month')::date < $2::date
     GROUP BY u.account_id, u.account, u.due, u.payer
     HAVING sum(x.amount) > 0`, [desde, proximo, hoje])).rows;

  // Contas fixas: um vencimento por mês (o dia, ou o último dia de um mês mais curto). Cada
  // pagamento com o trecho da descrição, saído de uma conta corrente, vale para o vencimento mais
  // próximo (empate: o seguinte); assim um mês pago com atraso não adianta o mês seguinte. Sem
  // valor fixo, espera-se o que saiu no vencimento anterior.
  const fixas = (await read.query<ItemBruto>(
    `WITH meses AS (
       SELECT generate_series(date_trunc('month', $1::date) - interval '3 months', date_trunc('month', $2::date) + interval '1 month', interval '1 month')::date AS m
     ), o AS (
       SELECT r.id, r.name, r.pattern, r.expected_amount, r.account_id, r.paid_until, r.auto_debit, r.paid_marked_at,
              (meses.m + (least(r.due_day, extract(day FROM meses.m + interval '1 month - 1 day')::int) - 1))::date AS vence
       FROM fin.recurring_bills r CROSS JOIN meses
       WHERE r.status = 'ativa'
     ), t AS (
       SELECT DISTINCT ON (o.id, x.id) o.id, o.vence, -x.signed_amount AS valor, x.local_date
       FROM o JOIN fin.v_transactions x
         ON x.account_subtype <> 'CREDIT_CARD' AND x.signed_amount < 0
        AND x.local_date BETWEEN o.vence - 16 AND o.vence + 16
        AND position(fin.norm_text(o.pattern) IN fin.norm_text(x.bank_description)) > 0
       ORDER BY o.id, x.id, abs(x.local_date - o.vence), o.vence DESC
     ), p AS (
       SELECT id, vence, sum(valor)::numeric(14,2) AS pago, max(local_date) AS pago_em FROM t GROUP BY id, vence
     )
     SELECT 'conta_fixa' AS tipo, o.id::int, o.name AS descricao, o.account_id::int AS conta_id, to_char(o.vence, 'YYYY-MM-DD') AS vencimento,
            coalesce(o.expected_amount, (SELECT p2.pago FROM p p2 WHERE p2.id = o.id AND p2.vence < o.vence ORDER BY p2.vence DESC LIMIT 1)) AS valor,
            coalesce(p.pago, 0)::numeric(14,2) AS pago, to_char(p.pago_em, 'YYYY-MM-DD') AS pago_em,
            (o.paid_until IS NOT NULL AND o.vence <= o.paid_until) AS pago_manual,
            to_char(o.paid_marked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS marcado_em,
            o.auto_debit AS debito_automatico
     FROM o LEFT JOIN p ON p.id = o.id AND p.vence = o.vence
     WHERE o.vence >= $1::date AND o.vence < $2::date`, [desde, proximo])).rows;

  const resumo = resumirAPagar({
    hoje, inicio_ciclo: inicioCiclo, limite_atraso: limiteAtraso,
    contas: contas.map(({ id, conta, saldo, atualizado_em }) => ({
      id, conta, saldo,
      dados_ate: atualizado_em ? dateInTimezone(new Date(atualizado_em)) : null,
      atualizado_em: atualizado_em ? new Date(atualizado_em).toISOString() : null,
    })),
    itens: [...faturas, ...abertas, ...fixas],
  });
  const nomes = new Map((await read.query<{ id: number; name: string }>('SELECT id::int, name FROM fin.v_accounts')).rows.map((a) => [a.id, a.name]));
  const contasFixas = (await read.query(
    `SELECT r.id::int, r.name AS nome, r.pattern AS padrao, r.due_day::int AS dia, r.expected_amount AS valor,
            r.account_id::int AS conta_id, a.name AS conta, to_char(r.paid_until, 'YYYY-MM-DD') AS pago_ate, r.auto_debit AS debito_automatico
     FROM fin.recurring_bills r LEFT JOIN fin.v_accounts a ON a.id = r.account_id
     WHERE r.status = 'ativa' ORDER BY r.due_day, r.name`)).rows;

  const guardado = await guardadoAtual(read);
  return {
    hoje,
    ultimo_salario: sal.data ? { data: sal.data, valor: sal.valor } : null,
    guardado: guardado ? { total: guardado.total, data: guardado.data } : null,
    proximo_salario: proximo,
    // saldo = o do banco (última atualização da Pluggy) menos o que já foi pago depois dela (ja_saiu).
    saldo_banco: resumo.saldo_banco,
    ja_saiu: resumo.ja_saiu,
    saldo: resumo.saldo,
    a_pagar: resumo.a_pagar,
    sobra: resumo.sobra,
    contas: resumo.contas.map((c) => ({ ...c, atualizado_em: contas.find((x) => x.id === c.id)?.atualizado_em ?? null })),
    itens: resumo.itens.map((i) => ({ ...i, conta: i.conta_id === null ? null : nomes.get(i.conta_id) ?? null })),
    contas_fixas: contasFixas,
  };
}

// --- botão "Sincronizar" (migration 0013) ----------------------------------------------------

/**
 * O último sync, se há pedido esperando ou sync rodando e quando a Pluggy atualizou cada banco
 * (o sync só traz o que a Pluggy já buscou). Um sync "rodando" há mais de 10 min caiu no meio.
 */
export async function statusSync(read: Db, _args: Args = {}) {
  const ultimo = (await read.query(
    `SELECT id::int, trigger, status, started_at AS iniciado_em, finished_at AS terminado_em, inserted AS inseridas, warnings AS avisos, error AS erro
     FROM fin.v_sync_runs ORDER BY id DESC LIMIT 1`)).rows[0] ?? null;
  const { rows: [estado] } = await read.query<{ pendente: boolean; rodando: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM fin.sync_requests r
                    WHERE r.requested_at > coalesce((SELECT max(started_at) FROM fin.v_sync_runs), '-infinity'::timestamptz)) AS pendente,
            EXISTS (SELECT 1 FROM fin.v_sync_runs WHERE status = 'running' AND started_at > now() - interval '10 minutes') AS rodando`);
  const bancos = (await read.query(
    `SELECT DISTINCT ON (item_id) name AS conta, bank_data_updated_at AS atualizado_em
     FROM fin.v_accounts WHERE subtype = 'CHECKING_ACCOUNT' ORDER BY item_id, name`)).rows;
  return { ultimo, pedido_pendente: estado!.pendente, rodando: estado!.rodando, bancos };
}

/** Pede um sync ao daemon. Não repete se já há pedido, sync rodando ou um que começou há menos de 30 s. */
export async function pedirSync({ read, write }: Pools, _args: Args = {}) {
  const s = await statusSync(read);
  if (s.pedido_pendente) return { ok: true, pedido: false, motivo: 'ja_pedido' };
  if (s.rodando) return { ok: true, pedido: false, motivo: 'rodando' };
  const recente = await read.query(`SELECT 1 FROM fin.v_sync_runs WHERE started_at > now() - interval '30 seconds'`);
  if (recente.rowCount) return { ok: true, pedido: false, motivo: 'recente' };
  await write.query('INSERT INTO fin.sync_requests DEFAULT VALUES');
  return { ok: true, pedido: true };
}

async function contaCorrente(read: Db, contaId: unknown) {
  if (contaId === undefined) return;
  const r = await read.query(`SELECT 1 FROM fin.v_accounts WHERE id = $1 AND subtype = 'CHECKING_ACCOUNT'`, [contaId]);
  if (!r.rowCount) throw new UserError(`Conta ${contaId} não é uma conta corrente: use o id de uma conta corrente (ver contas).`);
}

/** Cadastra uma conta fixa (o que sai todo mês da conta corrente). */
export async function criarContaFixa({ read, write }: Pools, { nome, padrao, dia, valor, conta_id, debito_automatico }: Args) {
  await contaCorrente(read, conta_id);
  const { rows } = await write.query<{ id: number }>(
    `INSERT INTO fin.recurring_bills (name, pattern, due_day, expected_amount, account_id, auto_debit)
     VALUES ($1, lower(trim($2)), $3, round($4::numeric, 2), $5, $6) RETURNING id::int`,
    [nome, padrao, dia, valor ?? null, conta_id ?? null, debito_automatico ?? false]);
  return { ok: true, id: rows[0]!.id };
}

const CAMPOS_CONTA_FIXA = {
  padrao: 'pattern = lower(trim(?))',
  dia: 'due_day = ?',
  valor: 'expected_amount = round(?::numeric, 2)',
  conta_id: 'account_id = ?',
  pago_ate: 'paid_until = ?::date, paid_marked_at = now()',
  debito_automatico: 'auto_debit = ?',
  status: 'status = ?',
} as const;

/** Ajusta uma conta fixa: trecho, dia, valor, conta, "já paguei" ou encerrar (o nome fica como foi criado). */
export async function atualizarContaFixa({ read, write }: Pools, args: Args) {
  await contaCorrente(read, args.conta_id);
  const sets: string[] = [];
  const params: unknown[] = [args.id];
  for (const [campo, sql] of Object.entries(CAMPOS_CONTA_FIXA)) {
    if (args[campo] === undefined) continue;
    params.push(args[campo]);
    sets.push(sql.replace('?', `$${params.length}`));
  }
  if (!sets.length) throw new UserError('Nada para mudar: informe padrao, dia, valor, conta_id, pago_ate, debito_automatico ou status.');
  const { rowCount } = await write.query(`UPDATE fin.recurring_bills SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  if (!rowCount) throw new UserError('Conta fixa não encontrada.', 404);
  return { ok: true, id: args.id };
}

/** Tira uma transação dos relatórios (ou devolve). Fica em transaction_overrides, como a categoria. */
export async function ignorarTransacao({ read, write }: Pools, { transacao_id, ignorar }: Args) {
  const exists = await read.query('SELECT 1 FROM fin.v_transactions WHERE id = $1', [transacao_id]);
  if (!exists.rowCount) throw new UserError(`Transação ${transacao_id} não encontrada.`, 404);
  await write.query(
    `INSERT INTO fin.transaction_overrides (transaction_id, ignored) VALUES ($1, $2)
     ON CONFLICT (transaction_id) DO UPDATE SET ignored = EXCLUDED.ignored, updated_at = now()`,
    [transacao_id, ignorar]);
  return { ok: true, transacao: { id: transacao_id, ignorada: ignorar } };
}

export async function definirCategoria({ read, write }: Pools, { transacao_id, categoria, nota }: Args) {
  const cat = await findCategory(read, categoria as string);
  const exists = await read.query('SELECT 1 FROM fin.v_transactions WHERE id = $1', [transacao_id]);
  if (!exists.rowCount) throw new UserError(`Transação ${transacao_id} não encontrada. Use o id que vem de buscar_transacoes.`, 404);
  await write.query(
    `INSERT INTO fin.transaction_overrides (transaction_id, category_id, note) VALUES ($1, $2, $3)
     ON CONFLICT (transaction_id) DO UPDATE SET
       category_id = EXCLUDED.category_id,
       note = coalesce(EXCLUDED.note, fin.transaction_overrides.note),
       updated_at = now()`,
    [transacao_id, cat.id, nota ?? null]);
  const { rows } = await read.query(
    `SELECT id::int AS id, local_date AS data, description AS descricao, signed_amount AS valor,
            category AS categoria, category_source AS origem_categoria, note AS nota
     FROM fin.v_transactions WHERE id = $1`, [transacao_id]);
  return { ok: true, transacao: rows[0] };
}

// Só "contém". Regex fica de fora de propósito: a view avalia a regra em toda transação
// a cada consulta, e uma regex cara (que uma descrição de Pix maliciosa poderia induzir
// o modelo a criar) deixaria tudo lento. Regex continua possível por SQL, feita pelo usuário.
export async function criarRegra({ read, write }: Pools, { categoria, padrao, prioridade }: Args) {
  const cat = await findCategory(read, categoria as string);
  const count = async () => (await read.query<{ casam: number; na_categoria: number }>(
    `SELECT count(*)::int AS casam, (count(*) FILTER (WHERE category_id = $2))::int AS na_categoria
     FROM fin.v_transactions
     WHERE position(fin.norm_text($1) IN fin.norm_text(bank_description)) > 0`, [padrao, cat.id])).rows[0]!;

  const before = await count();
  const { rows } = await write.query<{ id: string }>(
    "INSERT INTO fin.category_rules (category_id, match_type, pattern, priority) VALUES ($1, 'contains', $2, $3) RETURNING id",
    [cat.id, padrao, prioridade]);
  const after = await count();
  return {
    ok: true,
    regra: { id: Number(rows[0]!.id), categoria: cat.name, tipo: 'contains', padrao, prioridade },
    casam: after.casam,
    ja_nessa_categoria_antes: before.na_categoria,
    nessa_categoria_agora: after.na_categoria,
    ...(after.na_categoria < after.casam
      ? { observacao: 'Parte das transações que casam ficou em outra categoria: há categoria definida à mão ou uma regra de prioridade menor, que vence.' }
      : {}),
  };
}
