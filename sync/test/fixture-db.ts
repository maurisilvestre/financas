// Banco de teste populado por um sync de verdade (Pluggy simulada), com os papéis como no
// compose: fin_app (dono), fin_readonly (leitura) e fin_mcp (escrita da camada do usuário).
// Usado pelos testes do MCP e da API. Requer TEST_PG_URL (Postgres descartável).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { createPool, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { dateInTimezone, shiftMonth } from '../src/normalize.ts';
import type { PluggyTransaction } from '../src/pluggy.ts';
import { runSync } from '../src/sync.ts';
import { newMockState, startMockPluggy } from './mock-pluggy.ts';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

export const today = dateInTimezone(new Date());
/** Mês (AAAA-MM) `back` meses antes do atual. */
export const mon = (back: number) => shiftMonth(today, -back).slice(0, 7);
const at = (date: string) => `${date}T00:00:00.000Z`;
const daysFromToday = (n: number) => dateInTimezone(new Date(Date.now() + n * 86_400_000));

/**
 * Dados:
 *  conta corrente: salário 8000 (meses 1 e 2), plano de saúde 1200 (meses 1 a 3), LOJA DO ZE 80 (mês 1, sem categoria)
 *  cartão: Netflix 55,90 (meses 1 a 3), ACADEMIA SMART FIT 129,90 (mês 1, sem categoria),
 *          GELADEIRA ELETROLAR 02/10 400 (ontem, parcelada, sem categoria)
 *  investimentos: CDB ativo de 1.500,50 (posição de anteontem) e um resgatado (saldo 0)
 */
function seedTransactions(chk: string, card: string): { checking: PluggyTransaction[]; card: PluggyTransaction[] } {
  let n = 0;
  const tx = (accountId: string, over: Partial<PluggyTransaction>): PluggyTransaction => ({
    id: randomUUID(), accountId, date: at(daysFromToday(-1)), description: `Transação ${++n}`, amount: -10,
    currencyCode: 'BRL', status: 'POSTED', type: 'DEBIT', providerId: null, ...over,
  });
  return {
    checking: [
      ...[1, 2].map((k) => tx(chk, { description: 'SALARIO EMPRESA X', amount: 8000, type: 'CREDIT', operationType: 'FOLHA_PAGAMENTO', date: at(`${mon(k)}-05`) })),
      ...[1, 2, 3].map((k) => tx(chk, { description: 'Pagamento efetuado|CLINICA VIDA', amount: -1200, date: at(`${mon(k)}-08`) })),
      tx(chk, { description: 'LOJA DO ZE', amount: -80, date: at(`${mon(1)}-20`) }),
    ],
    card: [
      ...[1, 2, 3].map((k) => tx(card, { description: 'NETFLIX.COM', amount: 55.9, date: at(`${mon(k)}-10`) })),
      tx(card, { description: 'ACADEMIA SMART FIT', amount: 129.9, date: at(`${mon(1)}-15`) }),
      tx(card, { description: 'GELADEIRA ELETROLAR 02/10', amount: 400, date: at(daysFromToday(-1)), creditCardMetadata: { installmentNumber: 2, totalInstallments: 10 } }),
    ],
  };
}

export interface SeededDb {
  app: Db;
  read: Db;
  write: Db;
  urlFor: (user: string) => string;
  close: () => Promise<void>;
}

export async function createSeededDb(prefix: string): Promise<SeededDb> {
  const adminUrl = process.env.TEST_PG_URL!;
  const dbName = `${prefix}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const role of ['fin_app', 'fin_readonly', 'fin_mcp']) {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (exists.rowCount === 0) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'test'`);
  }
  await admin.query('ALTER ROLE fin_readonly SET default_transaction_read_only = on');
  await admin.query(`CREATE DATABASE ${dbName} OWNER fin_app`);
  await admin.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO fin_app, fin_readonly, fin_mcp`);

  const urlFor = (user: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = process.env.TEST_ROLE_PASSWORD ?? 'test';
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  const app = createPool(urlFor('fin_app'));
  await migrate(app, MIGRATIONS);

  const ITEM = randomUUID();
  const CHK = randomUUID();
  const CARD = randomUUID();
  const seed = seedTransactions(CHK, CARD);
  const state = newMockState();
  state.pageSize = 50;
  state.items.set(ITEM, {
    id: ITEM, connector: { id: 200, name: 'MeuPluggy' }, status: 'UPDATED', executionStatus: 'SUCCESS',
    lastUpdatedAt: new Date().toISOString(), consentExpiresAt: new Date(Date.now() + 300 * 86_400_000).toISOString(),
  });
  state.accounts.set(ITEM, [
    { id: CHK, itemId: ITEM, type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta Corrente', number: '1234/56789-0', balance: 2500.5, currencyCode: 'BRL' },
    { id: CARD, itemId: ITEM, type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Cartão', marketingName: 'CARTAO TESTE', number: 'xxxx4321', balance: 640, currencyCode: 'BRL' },
  ]);
  state.transactions.set(CHK, seed.checking);
  state.transactions.set(CARD, seed.card);
  state.bills.set(CARD, []);
  // Guardado: um CDB ativo (posição de anteontem) e um resgatado, que não conta.
  const cdb = { itemId: ITEM, type: 'FIXED_INCOME', subtype: 'CDB', name: 'CDB - BANCO X', currencyCode: 'BRL', date: at(daysFromToday(-2)) };
  state.investments.set(ITEM, [
    { ...cdb, id: randomUUID(), balance: 1500.5, status: 'ACTIVE' },
    { ...cdb, id: randomUUID(), balance: 0, status: 'TOTAL_WITHDRAWAL' },
  ]);
  const mock = await startMockPluggy(state);
  try {
    const result = await runSync(app, loadConfig({
      PLUGGY_BASE_URL: mock.url, PLUGGY_CLIENT_ID: state.clientId, PLUGGY_CLIENT_SECRET: state.clientSecret, PLUGGY_ITEM_IDS: ITEM,
    }), { trigger: 'manual' });
    assert.equal(result.status, 'success');
  } finally {
    await mock.close();
  }

  const read = createPool(urlFor('fin_readonly'));
  const write = createPool(urlFor('fin_mcp'));
  return {
    app, read, write, urlFor,
    close: async () => {
      for (const pool of [read, write, app]) await pool.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await admin.end();
    },
  };
}
