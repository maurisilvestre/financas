// Cliente mínimo da API da Pluggy (sem SDK, para manter a árvore de dependências pequena).
// Referência: https://docs.pluggy.ai — autenticação, /items, /accounts, /v2/transactions, /bills, /investments.
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './log.ts';

export interface PluggyItem {
  id: string;
  connector?: { id?: number; name?: string } | null;
  status?: string;
  executionStatus?: string;
  lastUpdatedAt?: string | null;
  consentExpiresAt?: string | null;
  [key: string]: unknown;
}

export interface PluggyAccount {
  id: string;
  itemId: string;
  type: 'BANK' | 'CREDIT' | string;
  subtype: string;
  name: string;
  marketingName?: string | null;
  number?: string | null;
  balance?: number | null;
  currencyCode?: string | null;
  creditData?: {
    creditLimit?: number | null;
    availableCreditLimit?: number | null;
    balanceCloseDate?: string | null;
    balanceDueDate?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface PluggyTransaction {
  id: string;
  accountId: string;
  date: string;
  description: string;
  descriptionRaw?: string | null;
  amount: number;
  amountInAccountCurrency?: number | null;
  currencyCode?: string | null;
  category?: string | null;
  providerCode?: string | null;
  providerId?: string | null;
  status: 'PENDING' | 'POSTED' | string;
  type: 'DEBIT' | 'CREDIT' | string;
  operationType?: string | null;
  creditCardMetadata?: {
    installmentNumber?: number | null;
    totalInstallments?: number | null;
    totalAmount?: number | null;
    purchaseDate?: string | null;
    /** Instante da compra (o mesmo em todas as parcelas). */
    transactionDateTime?: string | null;
    cardNumber?: string | null;
    billId?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface PluggyBill {
  id: string;
  dueDate: string;
  totalAmount: number;
  totalAmountCurrencyCode?: string | null;
  minimumPaymentAmount?: number | null;
  allowsInstallments?: boolean | null;
  financeCharges?: Array<{ amount?: number | null }> | null;
  payments?: Array<{ amount?: number | null }> | null;
  [key: string]: unknown;
}

export interface PluggyInvestment {
  id: string;
  itemId?: string;
  type?: string | null;
  subtype?: string | null;
  name?: string | null;
  balance?: number | null;
  currencyCode?: string | null;
  /** Data da posição do saldo. */
  date?: string | null;
  /** ACTIVE, PENDING ou TOTAL_WITHDRAWAL (resgatado). */
  status?: string | null;
  [key: string]: unknown;
}

interface PageResponse<T> {
  page?: number;
  total?: number;
  totalPages?: number;
  results: T[];
}

interface CursorResponse<T> {
  results: T[];
  next: string | null;
}

export class PluggyError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'PluggyError';
    this.status = status;
    this.code = code;
  }
}

export interface PluggyClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  maxRetries?: number;
}

const API_KEY_TTL_MS = 110 * 60 * 1000; // a API key vale 2 h; renovamos antes.
const MAX_PAGES = 1_000; // trava contra paginação infinita

export class PluggyClient {
  readonly #opts: Required<PluggyClientOptions>;
  #apiKey: string | null = null;
  #apiKeyExpiresAt = 0;

  constructor(opts: PluggyClientOptions) {
    this.#opts = { maxRetries: 4, ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
  }

  async #authenticate(): Promise<string> {
    if (this.#apiKey && Date.now() < this.#apiKeyExpiresAt) return this.#apiKey;
    const body = await this.#send<{ apiKey?: string }>('POST', '/auth', {
      clientId: this.#opts.clientId,
      clientSecret: this.#opts.clientSecret,
    }, false);
    if (!body.apiKey) throw new PluggyError('Resposta de /auth sem apiKey', 500);
    this.#apiKey = body.apiKey;
    this.#apiKeyExpiresAt = Date.now() + API_KEY_TTL_MS;
    return this.#apiKey;
  }

  async #send<T>(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown, auth = true): Promise<T> {
    let refreshedKey = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (auth) headers['x-api-key'] = await this.#authenticate();

      let res: Response;
      try {
        res = await fetch(`${this.#opts.baseUrl}${pathAndQuery}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.#opts.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.#opts.maxRetries) {
          await this.#backoff(attempt, null, `falha de rede em ${method} ${redact(pathAndQuery)}`);
          continue;
        }
        throw err;
      }

      if (res.ok) return (await res.json()) as T;

      const text = await res.text();
      let code: string | undefined;
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { codeDescription?: string; message?: string };
        code = parsed.codeDescription;
        message = parsed.message ?? message;
      } catch {
        /* corpo não-JSON */
      }

      if (res.status === 401 && auth && !refreshedKey) {
        // API key expirou antes do previsto: renova uma vez.
        this.#apiKey = null;
        refreshedKey = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.#opts.maxRetries) {
        await this.#backoff(attempt, res.headers.get('retry-after'), `HTTP ${res.status} em ${method} ${redact(pathAndQuery)}`);
        continue;
      }
      throw new PluggyError(`Pluggy ${method} ${redact(pathAndQuery)} → HTTP ${res.status}: ${message}`, res.status, code);
    }
  }

  async #backoff(attempt: number, retryAfter: string | null, reason: string): Promise<void> {
    const fromHeader = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
    const delay = Math.min(fromHeader ?? 1000 * 2 ** attempt + Math.floor(Math.random() * 500), 60_000);
    log.warn(`${reason}; nova tentativa em ${delay} ms`, { attempt: attempt + 1 });
    await sleep(delay);
  }

  async checkCredentials(): Promise<void> {
    this.#apiKey = null;
    await this.#authenticate();
  }

  getItem(itemId: string): Promise<PluggyItem> {
    return this.#send<PluggyItem>('GET', `/items/${encodeURIComponent(itemId)}`);
  }

  async listAccounts(itemId: string): Promise<PluggyAccount[]> {
    return this.#allPages<PluggyAccount>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
  }

  async listInvestments(itemId: string): Promise<PluggyInvestment[]> {
    return this.#allPages<PluggyInvestment>(`/investments?itemId=${encodeURIComponent(itemId)}`);
  }

  async listBills(accountId: string): Promise<PluggyBill[]> {
    return this.#allPages<PluggyBill>(`/bills?accountId=${encodeURIComponent(accountId)}`);
  }

  // GET /v2/transactions: paginação por cursor. O "next" já vem pronto e é opaco.
  async *listTransactions(accountId: string, opts: { dateFrom?: string } = {}): AsyncGenerator<PluggyTransaction[]> {
    const params = new URLSearchParams({ accountId });
    if (opts.dateFrom) params.set('dateFrom', opts.dateFrom);
    let next: string | null = `?${params.toString()}`;
    for (let page = 0; next; page++) {
      if (page >= MAX_PAGES) throw new PluggyError('Paginação de transações excedeu o limite', 500);
      if (!next.startsWith('?')) throw new PluggyError(`Cursor inesperado da Pluggy: ${next.slice(0, 40)}`, 500);
      const body: CursorResponse<PluggyTransaction> = await this.#send('GET', `/v2/transactions${next}`);
      yield body.results ?? [];
      next = body.next ?? null;
    }
  }

  async #allPages<T>(pathAndQuery: string): Promise<T[]> {
    const out: T[] = [];
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.#send<PageResponse<T>>('GET', page === 1 ? pathAndQuery : `${pathAndQuery}${sep}page=${page}`);
      out.push(...(body.results ?? []));
      const totalPages = body.totalPages ?? 1;
      if (page >= totalPages || (body.results ?? []).length === 0) break;
    }
    return out;
  }
}

// Esconde ids e cursores dos logs.
function redact(pathAndQuery: string): string {
  return pathAndQuery
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => `${id.slice(0, 8)}…`)
    .replace(/after=[^&]+/, 'after=…');
}
