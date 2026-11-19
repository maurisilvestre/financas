// Servidor HTTP que imita as partes da API da Pluggy usadas pelo sync.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PluggyAccount, PluggyBill, PluggyInvestment, PluggyItem, PluggyTransaction } from '../src/pluggy.ts';

export interface MockState {
  clientId: string;
  clientSecret: string;
  items: Map<string, PluggyItem>;
  accounts: Map<string, PluggyAccount[]>; // por itemId
  transactions: Map<string, PluggyTransaction[]>; // por accountId
  bills: Map<string, PluggyBill[]>; // por accountId
  investments: Map<string, PluggyInvestment[]>; // por itemId
  /** Se definido, /investments responde com este status de erro. */
  investmentsStatus?: number;
  pageSize: number;
  fail429Times: number;
  requests: string[];
}

export function newMockState(): MockState {
  return {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    items: new Map(),
    accounts: new Map(),
    transactions: new Map(),
    bills: new Map(),
    investments: new Map(),
    pageSize: 3, // pequeno de propósito, para exercitar a paginação por cursor
    fail429Times: 0,
    requests: [],
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

export async function startMockPluggy(state: MockState): Promise<{ url: string; close: () => Promise<void> }> {
  const keys = new Set<string>();
  let keyCounter = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    state.requests.push(`${req.method} ${url.pathname}`);

    if (req.method === 'POST' && url.pathname === '/auth') {
      const body = (await readBody(req)) as { clientId?: string; clientSecret?: string } | undefined;
      if (body?.clientId !== state.clientId || body?.clientSecret !== state.clientSecret) {
        return send(res, 401, { message: 'Unauthorized', codeDescription: 'CLIENT_KEYS_UNAUTHORIZED' });
      }
      const key = `key-${++keyCounter}`;
      keys.add(key);
      return send(res, 200, { apiKey: key });
    }

    if (!keys.has(String(req.headers['x-api-key'] ?? ''))) return send(res, 401, { message: 'Invalid API key' });

    if (state.fail429Times > 0) {
      state.fail429Times--;
      return send(res, 429, { message: 'Too many requests' }, { 'retry-after': '0' });
    }

    const itemMatch = /^\/items\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && itemMatch) {
      const item = state.items.get(itemMatch[1]!);
      return item ? send(res, 200, item) : send(res, 404, { message: 'Item not found' });
    }

    if (req.method === 'GET' && url.pathname === '/accounts') {
      const results = state.accounts.get(url.searchParams.get('itemId') ?? '') ?? [];
      return send(res, 200, { page: 1, total: results.length, totalPages: 1, results });
    }

    if (req.method === 'GET' && url.pathname === '/bills') {
      const results = state.bills.get(url.searchParams.get('accountId') ?? '') ?? [];
      return send(res, 200, { page: 1, total: results.length, totalPages: 1, results });
    }

    if (req.method === 'GET' && url.pathname === '/investments') {
      if (state.investmentsStatus) return send(res, state.investmentsStatus, { message: 'Produto não habilitado' });
      const results = state.investments.get(url.searchParams.get('itemId') ?? '') ?? [];
      return send(res, 200, { page: 1, total: results.length, totalPages: 1, results });
    }

    if (req.method === 'GET' && url.pathname === '/v2/transactions') {
      const accountId = url.searchParams.get('accountId') ?? '';
      const dateFrom = url.searchParams.get('dateFrom');
      const all = (state.transactions.get(accountId) ?? [])
        .filter((t) => !dateFrom || t.date.slice(0, 10) >= dateFrom)
        .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)));
      const after = url.searchParams.get('after');
      const offset = after ? Number(Buffer.from(after, 'base64').toString('utf8')) : 0;
      const results = all.slice(offset, offset + state.pageSize);
      const nextOffset = offset + state.pageSize;
      let next: string | null = null;
      if (nextOffset < all.length) {
        const params = new URLSearchParams({ accountId });
        if (dateFrom) params.set('dateFrom', dateFrom);
        params.set('after', Buffer.from(String(nextOffset)).toString('base64'));
        next = `?${params.toString()}`;
      }
      return send(res, 200, { results, next });
    }

    send(res, 404, { message: `Rota não simulada: ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
