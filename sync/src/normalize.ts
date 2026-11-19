// Funções puras de normalização dos dados da Pluggy. Testadas em test/normalize.test.ts.
import type { PluggyAccount, PluggyTransaction } from './pluggy.ts';

export const TIMEZONE = 'America/Sao_Paulo';

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = dateFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFmtCache.set(tz, fmt);
  }
  return fmt;
}

/** Data (YYYY-MM-DD) de um instante, no fuso informado. */
export function dateInTimezone(instant: Date, tz = TIMEZONE): string {
  return dateFormatter(tz).format(instant);
}

/**
 * Converte o campo `date` da Pluggy (ISO em UTC) para a data local.
 *
 * A Pluggy manda datas em UTC e pede para converter para GMT-3. Mas muitos bancos só
 * informam o dia, que chega como meia-noite UTC ("2026-11-05T00:00:00.000Z"); converter
 * isso para GMT-3 jogaria a transação para o dia anterior. Então:
 *   - horário exatamente 00:00:00.000 UTC → é uma data sem hora: usa o dia como veio;
 *   - qualquer outro horário → converte para o fuso de Brasília.
 * VALIDAR com dados reais: se as datas do seu banco vierem deslocadas, é aqui.
 */
export function toLocalDate(iso: string, tz = TIMEZONE): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) throw new Error(`Data inválida da Pluggy: ${iso}`);
  if (instant.getUTCHours() === 0 && instant.getUTCMinutes() === 0 && instant.getUTCSeconds() === 0 && instant.getUTCMilliseconds() === 0) {
    return instant.toISOString().slice(0, 10);
  }
  return dateInTimezone(instant, tz);
}

export function toLocalDateOrNull(iso: string | null | undefined, tz = TIMEZONE): string | null {
  return iso ? toLocalDate(iso, tz) : null;
}

const timeFmtCache = new Map<string, Intl.DateTimeFormat>();
function isMidnightIn(instant: Date, tz: string): boolean {
  let fmt = timeFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    timeFmtCache.set(tz, fmt);
  }
  return instant.getUTCMilliseconds() === 0 && fmt.format(instant) === '00:00:00';
}

/**
 * Instante exato da transação, quando o banco informa o horário. É a âncora de religação
 * quando falta providerId (o Meu Pluggy não manda). No cartão vem de transactionDateTime,
 * o instante da compra, que é o mesmo em todas as parcelas. Por isso a religação também
 * compara o número da parcela.
 * Data sem hora (meia-noite em Brasília, como a Pluggy manda, ou meia-noite UTC) → null.
 * A migration 0004 aplica a mesma regra em SQL para preencher as linhas antigas.
 */
export function preciseInstant(tx: Pick<PluggyTransaction, 'date' | 'creditCardMetadata'>, tz = TIMEZONE): string | null {
  const iso = tx.creditCardMetadata?.transactionDateTime ?? tx.date;
  if (typeof iso !== 'string') return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  if (isMidnightIn(instant, tz) || isMidnightIn(instant, 'UTC')) return null;
  return instant.toISOString();
}

/** Número → string com 2 casas, arredondando metade para longe de zero. */
export function money(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  // toFixed(6) absorve o erro de ponto flutuante (1.005 * 100 = 100.49999999999999).
  const cents = Math.sign(n) * Math.round(Number((Math.abs(n) * 100).toFixed(6)));
  return (cents / 100 + 0).toFixed(2); // + 0 evita "-0.00"
}

/** Texto em minúsculas, sem acentos e com espaços colapsados (igual a fin.norm_text no banco). */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Remove o sufixo de parcela da descrição: "LOJA X 02/06", "Loja X - Parcela 2/6", "LOJA X (2 DE 6)". */
export function stripInstallmentSuffix(description: string): string {
  const stripped = description
    .replace(/\s*[-–—(]?\s*(?:parc(?:ela)?\.?\s*)?\d{1,2}\s*(?:\/|\bde\b)\s*\d{1,2}\s*\)?\s*$/i, '')
    .trim();
  return stripped.length > 0 ? stripped : description.trim();
}

/**
 * Identidade estável de uma conta entre reconexões (reconectar cria um item novo, e a
 * conta ganha um id novo na Pluggy). Usa subtipo + número; cartão usa os 4 últimos dígitos.
 */
export function accountFingerprint(acc: Pick<PluggyAccount, 'subtype' | 'number' | 'name'>): string {
  const digits = (acc.number ?? '').replace(/\D/g, '');
  if (digits.length > 0) {
    const num = acc.subtype === 'CREDIT_CARD' ? digits.slice(-4) : digits;
    return `${acc.subtype}|n:${num}`;
  }
  return `${acc.subtype}|name:${normalizeText(acc.name)}`;
}

export interface NormalizedTransaction {
  pluggy_id: string;
  provider_id: string | null;
  provider_code: string | null;
  occurred_at: string;
  /** Instante exato (com hora); null quando o banco só informa o dia. Ver preciseInstant. */
  precise_at: string | null;
  local_date: string;
  description: string;
  description_raw: string | null;
  amount: string;
  signed_amount: string;
  currency_code: string;
  amount_in_account_currency: string | null;
  type: 'DEBIT' | 'CREDIT';
  status: 'PENDING' | 'POSTED';
  operation_type: string | null;
  pluggy_category: string | null;
  installment_number: number | null;
  total_installments: number | null;
  purchase_date: string | null;
  bill_pluggy_id: string | null;
  card_number: string | null;
  raw: PluggyTransaction;
  /** O sinal de amount não bate com o esperado para type + tipo de conta. */
  sign_mismatch: boolean;
}

/**
 * Normaliza uma transação.
 *
 * signed_amount segue uma convenção única para todas as contas: entrada positiva, saída
 * negativa. É derivado de `type` (DEBIT = saída, CREDIT = entrada), porque o sinal de
 * `amount` muda conforme o tipo de conta: no cartão a Pluggy manda compra positiva e
 * pagamento negativo; na conta corrente, saída negativa.
 */
export function normalizeTransaction(tx: PluggyTransaction, accountType: string, tz = TIMEZONE): NormalizedTransaction {
  const type = tx.type === 'CREDIT' ? 'CREDIT' : tx.type === 'DEBIT' ? 'DEBIT' : null;
  if (!type) throw new Error(`Transação ${tx.id} com type desconhecido: ${tx.type}`);
  const status = tx.status === 'PENDING' ? 'PENDING' : 'POSTED';

  const amount = money(tx.amount);
  if (amount === null) throw new Error(`Transação ${tx.id} sem amount numérico`);
  const abs = Math.abs(Number(amount));
  const signed = money(type === 'DEBIT' ? -abs : abs)!;

  const n = Number(amount);
  const isCreditAccount = accountType === 'CREDIT';
  const expectedPositive = isCreditAccount ? type === 'DEBIT' : type === 'CREDIT';
  const signMismatch = n !== 0 && (n > 0) !== expectedPositive;

  const meta = tx.creditCardMetadata ?? null;
  const total = meta?.totalInstallments ?? null;
  const number = meta?.installmentNumber ?? null;
  const isInstallment = total !== null && number !== null && Number.isInteger(total) && Number.isInteger(number)
    && total > 1 && number >= 1 && number <= total;

  return {
    pluggy_id: tx.id,
    provider_id: tx.providerId ?? null,
    provider_code: tx.providerCode ?? null,
    occurred_at: new Date(tx.date).toISOString(),
    precise_at: preciseInstant(tx, tz),
    local_date: toLocalDate(tx.date, tz),
    description: (tx.description ?? '').trim() || '(sem descrição)',
    description_raw: tx.descriptionRaw ?? null,
    amount,
    signed_amount: signed,
    currency_code: tx.currencyCode ?? 'BRL',
    amount_in_account_currency: money(tx.amountInAccountCurrency ?? null),
    type,
    status,
    operation_type: tx.operationType ?? null,
    pluggy_category: tx.category ?? null,
    installment_number: isInstallment ? number : null,
    total_installments: isInstallment ? total : null,
    purchase_date: isInstallment ? toLocalDateOrNull(meta?.purchaseDate, tz) : null,
    bill_pluggy_id: meta?.billId ?? null,
    card_number: meta?.cardNumber ?? null,
    raw: tx,
    sign_mismatch: signMismatch,
  };
}

/** Primeiro dia do mês de uma data YYYY-MM-DD, deslocado em `deltaMonths`. */
export function shiftMonth(date: string, deltaMonths: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + deltaMonths;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** Chave de busca de um grupo de parcelas: descrição sem o "2/6", normalizada, + nº de parcelas. */
export function installmentMatchKey(description: string, totalInstallments: number): string {
  return `${normalizeText(stripInstallmentSuffix(description))}|${totalInstallments}`;
}

/** Mês estimado da 1ª parcela: mês da parcela atual menos (n − 1). */
export function installmentAnchorMonth(localDate: string, installmentNumber: number): string {
  return shiftMonth(localDate, -(installmentNumber - 1));
}

/** Data de hoje − N dias, no fuso local, como YYYY-MM-DD. */
export function daysAgo(days: number, now = new Date(), tz = TIMEZONE): string {
  return dateInTimezone(new Date(now.getTime() - days * 86_400_000), tz);
}
