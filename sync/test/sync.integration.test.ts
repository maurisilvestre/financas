// Teste de integração: Postgres de verdade + API da Pluggy simulada, várias rodadas de sync.
//
// Requer um Postgres descartável e a variável TEST_PG_URL com um superusuário, por exemplo:
//   docker run --rm -d --name fin-test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:18-alpine
//   TEST_PG_URL=postgres://postgres@127.0.0.1:55432/postgres npm test
// O teste cria um banco temporário, os papéis fin_app/fin_readonly (se não existirem) e apaga o banco no fim.
// Não rode contra o banco do docker-compose.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig, type Config } from '../src/config.ts';
import { createPool, tryAdvisoryLock, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { dateInTimezone, shiftMonth } from '../src/normalize.ts';
import type { PluggyAccount, PluggyTransaction } from '../src/pluggy.ts';
import { runSync, type SyncResult } from '../src/sync.ts';
import { newMockState, startMockPluggy, type MockState } from './mock-pluggy.ts';

const ADMIN_URL = process.env.TEST_PG_URL;
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ITEM_A = randomUUID();
const ITEM_B = randomUUID(); // "reconexão" do mesmo banco
const ACC_CHK = randomUUID();
const ACC_CARD = randomUUID();
const ACC_CHK_B = randomUUID();
const ACC_CARD_B = randomUUID();

const today = dateInTimezone(new Date());
const thisMonth = today.slice(0, 7);
const prevMonth = shiftMonth(today, -1).slice(0, 7);
const nextMonth = shiftMonth(today, 1).slice(0, 7);
const daysFromToday = (n: number) => dateInTimezone(new Date(Date.now() + n * 86_400_000));
const at = (date: string) => `${date}T00:00:00.000Z`;

function item(id: string): import('../src/pluggy.ts').PluggyItem {
  return {
    id, connector: { id: 200, name: 'MeuPluggy' }, status: 'UPDATED', executionStatus: 'SUCCESS',
    lastUpdatedAt: new Date().toISOString(), consentExpiresAt: new Date(Date.now() + 300 * 86_400_000).toISOString(),
  };
}

function accounts(itemId: string, chkId: string, cardId: string): PluggyAccount[] {
  return [
    { id: chkId, itemId, type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta Corrente', number: '1234/56789-0', balance: 2500.5, currencyCode: 'BRL' },
    {
      id: cardId, itemId, type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Cartão Visa', marketingName: 'CARTAO TESTE',
      number: 'xxxx4321', balance: 640, currencyCode: 'BRL',
      creditData: { creditLimit: 10000, availableCreditLimit: 9360, balanceCloseDate: `${thisMonth}-25`, balanceDueDate: `${nextMonth}-05` },
    },
  ];
}

let n = 0;
function t(accountId: string, over: Partial<PluggyTransaction>): PluggyTransaction {
  return {
    id: randomUUID(), accountId, date: at(daysFromToday(-1)), description: `Transação ${++n}`, amount: -10,
    currencyCode: 'BRL', status: 'POSTED', type: 'DEBIT', providerId: `prov-${n}`, ...over,
  };
}

// Transações da 1ª rodada (ids guardados para mutar depois).
const chk = {
  salary: t(ACC_CHK, { description: 'SALARIO EMPRESA X', amount: 5000, type: 'CREDIT', operationType: 'FOLHA_PAGAMENTO', date: at(daysFromToday(-20)) }),
  ifood: t(ACC_CHK, { description: 'IFOOD *RESTAURANTE', amount: -45.9, date: at(daysFromToday(-10)) }),
  billPayment: t(ACC_CHK, { description: 'PAGAMENTO DE FATURA CARTAO', amount: -1200, date: at(daysFromToday(-5)) }),
  market: t(ACC_CHK, { description: 'SUPERMERCADO EXEMPLO', amount: -300, date: at(daysFromToday(-3)), providerId: null }),
  scheduled: t(ACC_CHK, { description: 'PAGAMENTO AGENDADO VIVO', amount: -89.9, status: 'PENDING', date: at(daysFromToday(5)) }),
};
const installment = (num: number, total: number) => ({ installmentNumber: num, totalInstallments: total });
const card = {
  bakery: t(ACC_CARD, { description: 'PADARIA BOM PAO', amount: 75, date: at(daysFromToday(-8)) }),
  magalu1: t(ACC_CARD, { description: 'MAGALU 01/03', amount: 100, date: at(`${prevMonth}-05`), creditCardMetadata: installment(1, 3) }),
  magalu2: t(ACC_CARD, { description: 'MAGALU 02/03', amount: 100, date: at(`${thisMonth}-05`), creditCardMetadata: installment(2, 3) }),
  payment: t(ACC_CARD, { description: 'Pagamento recebido', amount: -1200, type: 'CREDIT', operationType: 'PAGAMENTO_FATURA', date: at(daysFromToday(-5)) }),
  leroy1: t(ACC_CARD, { description: 'LEROY MERLIN 01/02', amount: 250, date: at(daysFromToday(-2)), creditCardMetadata: installment(1, 2) }),
  leroy2: t(ACC_CARD, { description: 'LEROY MERLIN 02/02', amount: 250, status: 'PENDING', date: at(`${nextMonth}-05`), creditCardMetadata: installment(2, 2) }),
};

// ---------------------------------------------------------------------------

describe('sync (integração)', { skip: ADMIN_URL ? false : 'defina TEST_PG_URL para rodar' }, () => {
  const dbName = `fin_it_${Date.now()}`;
  let admin: pg.Client;
  let db: Db;
  let ro: pg.Client;
  let mock: { url: string; close: () => Promise<void> };
  let state: MockState;
  let config: Config;

  const configFor = (itemIds: string[], secret = state.clientSecret): Config => loadConfig({
    PLUGGY_BASE_URL: mock.url,
    PLUGGY_CLIENT_ID: state.clientId,
    PLUGGY_CLIENT_SECRET: secret,
    PLUGGY_ITEM_IDS: itemIds.join(','),
  });
  const sync = async (cfg = config): Promise<Extract<SyncResult, { runId: number }>> => {
    const result = await runSync(db, cfg, { trigger: 'manual' });
    assert.notEqual(result.status, 'locked');
    return result as Extract<SyncResult, { runId: number }>;
  };
  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> => {
    const { rows } = await db.query<T>(sql, params);
    assert.ok(rows[0], `sem resultado para: ${sql}`);
    return rows[0];
  };
  const txByDesc = (desc: string) => one<{ id: string; pluggy_id: string; deleted_at: Date | null; previous_pluggy_ids: string[]; status: string; signed_amount: string }>(
    'SELECT id, pluggy_id, deleted_at, previous_pluggy_ids, status, signed_amount FROM fin.transactions WHERE description = $1 ORDER BY id LIMIT 1', [desc]);
  const liveCount = async () => Number((await one<{ n: string }>('SELECT count(*) AS n FROM fin.transactions WHERE deleted_at IS NULL')).n);

  before(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const role of ['fin_app', 'fin_readonly']) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'test'`);
    }
    // Igual a db/init/01-roles.sh: o papel de leitura não escreve nem por engano.
    await admin.query('ALTER ROLE fin_readonly SET default_transaction_read_only = on');
    await admin.query(`CREATE DATABASE ${dbName} OWNER fin_app`);
    await admin.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO fin_app, fin_readonly`);

    const base = new URL(ADMIN_URL!);
    const urlFor = (user: string) => {
      const u = new URL(base);
      u.username = user;
      u.password = process.env.TEST_ROLE_PASSWORD ?? 'test';
      u.pathname = `/${dbName}`;
      return u.toString();
    };
    db = createPool(urlFor('fin_app'));
    await migrate(db, MIGRATIONS);
    ro = new pg.Client({ connectionString: urlFor('fin_readonly') });
    await ro.connect();

    state = newMockState();
    state.items.set(ITEM_A, item(ITEM_A));
    state.accounts.set(ITEM_A, accounts(ITEM_A, ACC_CHK, ACC_CARD));
    state.transactions.set(ACC_CHK, Object.values(chk));
    state.transactions.set(ACC_CARD, Object.values(card));
    state.bills.set(ACC_CARD, [{
      id: randomUUID(), dueDate: at(`${thisMonth}-05`), totalAmount: 1200, minimumPaymentAmount: 180,
      allowsInstallments: true, financeCharges: [{ amount: 7.01 }], payments: [{ amount: 1200 }],
    }]);
    mock = await startMockPluggy(state);
    config = configFor([ITEM_A]);
  });

  after(async () => {
    await ro?.end().catch(() => {});
    await db?.end().catch(() => {});
    await mock?.close().catch(() => {});
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });

  test('1ª rodada: importa contas, transações, faturas e agrupa parcelas', async () => {
    const r = await sync();
    assert.equal(r.status, 'success', JSON.stringify(r.stats));
    assert.equal(r.stats.accounts.length, 2);
    assert.equal(await liveCount(), 11);
    assert.ok(state.requests.filter((x) => x === 'GET /v2/transactions').length >= 4, 'deveria paginar por cursor');

    const acc = await one<{ n: string }>('SELECT count(*) AS n FROM fin.accounts');
    assert.equal(acc.n, '2');
    const bills = await one<{ total_amount: string; finance_charges_total: string }>('SELECT total_amount, finance_charges_total FROM fin.credit_card_bills');
    assert.deepEqual(bills, { total_amount: '1200.00', finance_charges_total: '7.01' });
    const snap = await one<{ n: string }>('SELECT count(*) AS n FROM fin.account_balance_snapshots');
    assert.equal(snap.n, '2');

    // Sinais: compra no cartão vira saída; pagamento recebido no cartão vira entrada.
    assert.equal((await txByDesc('PADARIA BOM PAO')).signed_amount, '-75.00');
    assert.equal((await txByDesc('Pagamento recebido')).signed_amount, '1200.00');
    assert.equal((await txByDesc('IFOOD *RESTAURANTE')).signed_amount, '-45.90');

    // Parcelas: 2 grupos; MAGALU tem a 3ª projetada no mês seguinte à 2ª.
    const groups = await db.query('SELECT description, total_installments FROM fin.installment_groups ORDER BY description');
    assert.deepEqual(groups.rows, [
      { description: 'LEROY MERLIN', total_installments: 2 },
      { description: 'MAGALU', total_installments: 3 },
    ]);
    const projected = await db.query<{ installment_number: number; month: string; amount: string }>(
      "SELECT installment_number, month, amount FROM fin.v_installment_plan WHERE source = 'projetada'");
    assert.deepEqual(projected.rows, [{ installment_number: 3, month: `${nextMonth}-01`, amount: '100.00' }]);
  });

  test('categorias por regra e fluxo (transferências fora dos gastos)', async () => {
    const cats = await db.query<{ description: string; category: string | null; flow: string }>(
      'SELECT description, category, flow FROM fin.v_transactions ORDER BY description');
    const byDesc = Object.fromEntries(cats.rows.map((r) => [r.description, `${r.category}/${r.flow}`]));
    assert.equal(byDesc['IFOOD *RESTAURANTE'], 'Alimentação fora/expense');
    assert.equal(byDesc['PAGAMENTO DE FATURA CARTAO'], 'Pagamento de fatura/transfer');
    assert.equal(byDesc['Pagamento recebido'], 'Pagamento de fatura/transfer');
    assert.equal(byDesc['SALARIO EMPRESA X'], 'Salário/income');
    assert.equal(byDesc['SUPERMERCADO EXEMPLO'], 'Mercado/expense');
    assert.equal(byDesc['LEROY MERLIN 01/02'], 'Casa e reforma/expense');
    assert.equal(byDesc['MAGALU 02/03'], 'Compras/expense');
    assert.equal(byDesc['PAGAMENTO AGENDADO VIVO'], 'Moradia/expense');

    // O pagamento da fatura (−1200 na conta, +1200 no cartão) não entra em gastos nem receitas.
    const { rows } = await db.query<{ month: string; expenses: string; income: string }>('SELECT month, expenses, income FROM fin.v_monthly_summary');
    const total = rows.reduce((acc, r) => ({ e: acc.e + Number(r.expenses), i: acc.i + Number(r.income) }), { e: 0, i: 0 });
    assert.equal(total.i, 5000);
    assert.equal(Math.round(total.e * 100) / 100, 45.9 + 300 + 89.9 + 75 + 100 + 100 + 250 + 250);
  });

  test('2ª rodada: atualiza, religa ids recriados, mantém overrides e marca sumidos', async () => {
    // Override manual na padaria antes do re-sync.
    const bakery = await txByDesc('PADARIA BOM PAO');
    await db.query(
      "INSERT INTO fin.transaction_overrides (transaction_id, category_id, note) SELECT $1, id, 'café com a equipe' FROM fin.categories WHERE name = 'Lazer'",
      [bakery.id]);

    const ifoodBefore = await txByDesc('IFOOD *RESTAURANTE');
    chk.scheduled.status = 'POSTED'; // a. PENDING → POSTED, mesmo id
    const ifoodNew = { ...chk.ifood, id: randomUUID(), amount: -46.9 }; // b. recriada, mesmo providerId
    const bakeryNew = { ...card.bakery, id: randomUUID() }; // c. recriada, com override
    const uber = t(ACC_CHK, { description: 'UBER *TRIP', amount: -23.5 }); // f. nova
    const magalu3 = t(ACC_CARD, { description: 'MAGALU 03/03', amount: 100, status: 'PENDING', date: at(`${nextMonth}-05`), creditCardMetadata: installment(3, 3) }); // e.
    state.transactions.set(ACC_CHK, [chk.salary, ifoodNew, chk.billPayment, chk.scheduled, uber]); // d. market sumiu
    state.transactions.set(ACC_CARD, [bakeryNew, card.magalu1, card.magalu2, card.payment, card.leroy1, card.leroy2, magalu3]);

    const r = await sync();
    assert.equal(r.status, 'success', JSON.stringify(r.stats));
    const [chkStats, cardStats] = r.stats.accounts;
    assert.equal(chkStats!.relinked, 1);
    assert.equal(chkStats!.softDeleted, 1);
    assert.equal(chkStats!.inserted, 1);
    assert.equal(cardStats!.relinked, 1);
    assert.equal(cardStats!.inserted, 1);

    assert.equal((await txByDesc('PAGAMENTO AGENDADO VIVO')).status, 'POSTED');
    const ifoodAfter = await txByDesc('IFOOD *RESTAURANTE');
    assert.equal(ifoodAfter.id, ifoodBefore.id, 'mesma linha interna');
    assert.equal(ifoodAfter.pluggy_id, ifoodNew.id);
    assert.deepEqual(ifoodAfter.previous_pluggy_ids, [chk.ifood.id]);
    assert.equal(ifoodAfter.signed_amount, '-46.90');
    assert.ok((await txByDesc('SUPERMERCADO EXEMPLO')).deleted_at, 'deveria estar marcada como apagada');

    const bakeryView = await one<{ id: string; category: string; category_source: string; note: string }>(
      "SELECT id, category, category_source, note FROM fin.v_transactions WHERE description = 'PADARIA BOM PAO'");
    assert.equal(bakeryView.id, bakery.id);
    assert.deepEqual({ c: bakeryView.category, s: bakeryView.category_source, n: bakeryView.note }, { c: 'Lazer', s: 'manual', n: 'café com a equipe' });

    const magalu = await one<{ n: string; projected: string }>(
      `SELECT count(*) FILTER (WHERE source = 'lancada') AS n, count(*) FILTER (WHERE source = 'projetada') AS projected
       FROM fin.v_installment_plan WHERE description = 'MAGALU'`);
    assert.deepEqual(magalu, { n: '3', projected: '0' });
    assert.equal((await one<{ n: string }>('SELECT count(*) AS n FROM fin.installment_groups')).n, '2');
  });

  test('3ª rodada: transação sumida volta com id novo e sem providerId → religada pelos atributos', async () => {
    const before = await txByDesc('SUPERMERCADO EXEMPLO');
    const back = { ...chk.market, id: randomUUID() };
    state.transactions.set(ACC_CHK, [...state.transactions.get(ACC_CHK)!, back]);
    const r = await sync();
    assert.equal(r.status, 'success');
    const after = await txByDesc('SUPERMERCADO EXEMPLO');
    assert.equal(after.id, before.id);
    assert.equal(after.deleted_at, null);
    assert.equal(await liveCount(), 13);
  });

  test('rodada idempotente: nada muda quando a Pluggy devolve o mesmo', async () => {
    const r = await sync();
    for (const a of r.stats.accounts) {
      assert.deepEqual([a.inserted, a.relinked, a.softDeleted], [0, 0, 0], a.account);
    }
    assert.equal(await liveCount(), 13);
  });

  test('resposta vazia da API não apaga nada', async () => {
    const saved = state.transactions.get(ACC_CHK)!;
    state.transactions.set(ACC_CHK, []);
    const r = await sync();
    const chkStats = r.stats.accounts.find((a) => a.account === 'Conta Corrente')!;
    assert.equal(chkStats.softDeleted, 0);
    assert.equal(chkStats.softDeleteSkipped, true);
    assert.ok(r.stats.warnings.some((w) => w.includes('Parece falha da API')));
    assert.equal(await liveCount(), 13);
    state.transactions.set(ACC_CHK, saved);
  });

  test('investimentos: importa o saldo; o que some ganha deleted_at; lista vazia ou erro não apagam', async () => {
    const cdb = (over: Record<string, unknown>) => ({
      id: randomUUID(), itemId: ITEM_A, type: 'FIXED_INCOME', subtype: 'CDB', name: 'CDB - BANCO X', number: '123456',
      balance: 1500.5, currencyCode: 'BRL', date: at(daysFromToday(-2)), status: 'ACTIVE', ...over,
    });
    const ativo = cdb({});
    const resgatado = cdb({ balance: 0, status: 'TOTAL_WITHDRAWAL' });
    const outro = cdb({ balance: 300 });
    state.investments.set(ITEM_A, [ativo, resgatado, outro]);
    let r = await sync();
    assert.equal(r.status, 'success', JSON.stringify(r.stats));
    const guardado = async () => (await one<{ total: string | null; n: string }>(
      `SELECT sum(balance)::numeric(14,2)::text AS total, count(*) AS n FROM fin.v_investments WHERE status IS DISTINCT FROM 'TOTAL_WITHDRAWAL'`));
    assert.deepEqual(await guardado(), { total: '1800.50', n: '2' });
    const v = await one<{ owner: string; balance_date: string }>(
      `SELECT owner, to_char(balance_date, 'YYYY-MM-DD') AS balance_date FROM fin.v_investments WHERE balance = 1500.5`);
    assert.deepEqual(v, { owner: 'Conta Corrente', balance_date: daysFromToday(-2) }, 'dono: a conta corrente do mesmo item');

    // Resgatou o "outro": some da Pluggy e ganha deleted_at; o saldo do ativo muda.
    state.investments.set(ITEM_A, [{ ...ativo, balance: 1200 }, resgatado]);
    r = await sync();
    assert.deepEqual(await guardado(), { total: '1200.00', n: '1' });
    assert.equal((await one<{ n: string }>('SELECT count(*) AS n FROM fin.investments WHERE deleted_at IS NOT NULL')).n, '1');

    // Lista vazia (provável falha da API) não apaga nada; erro nos investimentos não derruba o sync.
    state.investments.set(ITEM_A, []);
    r = await sync();
    assert.deepEqual(await guardado(), { total: '1200.00', n: '1' });
    state.investmentsStatus = 403;
    r = await sync();
    assert.equal(r.status, 'success');
    assert.ok(r.stats.warnings.some((w) => w.includes('Investimentos')), JSON.stringify(r.stats.warnings));
    assert.deepEqual(await guardado(), { total: '1200.00', n: '1' });
    state.investmentsStatus = undefined;
    // O papel de leitura vê a view, sem o raw.
    const ro1 = await ro.query('SELECT * FROM fin.v_investments LIMIT 1');
    assert.equal('raw' in ro1.rows[0], false);
  });

  test('reconexão (item novo, ids novos): reaproveita contas e transações, sem duplicar', async () => {
    const accBefore = await db.query('SELECT id, fingerprint FROM fin.accounts ORDER BY id');
    const remap = (list: PluggyTransaction[], accountId: string) => list.map((x) => ({ ...x, id: randomUUID(), accountId }));
    state.items.set(ITEM_B, item(ITEM_B));
    state.accounts.set(ITEM_B, accounts(ITEM_B, ACC_CHK_B, ACC_CARD_B));
    state.transactions.set(ACC_CHK_B, remap(state.transactions.get(ACC_CHK)!, ACC_CHK_B));
    state.transactions.set(ACC_CARD_B, remap(state.transactions.get(ACC_CARD)!, ACC_CARD_B));

    const r = await sync(configFor([ITEM_B]));
    assert.equal(r.status, 'success', JSON.stringify(r.stats));
    for (const a of r.stats.accounts) assert.equal(a.inserted, 0, `${a.account} não deveria inserir`);
    assert.equal(await liveCount(), 13);
    const accAfter = await db.query('SELECT id, fingerprint, pluggy_id, previous_pluggy_ids FROM fin.accounts ORDER BY id');
    assert.deepEqual(accAfter.rows.map((x) => [x.id, x.fingerprint]), accBefore.rows.map((x) => [x.id, x.fingerprint]));
    assert.deepEqual(accAfter.rows.map((x) => x.pluggy_id), [ACC_CHK_B, ACC_CARD_B]);
    assert.deepEqual(accAfter.rows.map((x) => x.previous_pluggy_ids), [[ACC_CHK], [ACC_CARD]]);
    const bakery = await one<{ category: string }>("SELECT category FROM fin.v_transactions WHERE description = 'PADARIA BOM PAO'");
    assert.equal(bakery.category, 'Lazer', 'override sobrevive à reconexão');
  });

  test('item antigo e novo listados juntos: avisa e não duplica', async () => {
    const r = await sync(configFor([ITEM_B, ITEM_A]));
    assert.ok(r.stats.warnings.some((w) => w.includes('aparece em mais de um item')));
    assert.equal(await liveCount(), 13);
  });

  test('429 da API: tenta de novo e conclui', async () => {
    state.fail429Times = 2;
    const r = await sync(configFor([ITEM_B]));
    assert.equal(r.status, 'success');
  });

  test('item inexistente: registra erro e segue com os outros (partial)', async () => {
    const r = await sync(configFor([randomUUID(), ITEM_B]));
    assert.equal(r.status, 'partial');
    assert.ok(r.stats.errors[0]?.includes('item não encontrado'));
  });

  test('credenciais erradas: erro claro', async () => {
    const r = await sync(configFor([ITEM_B], 'errada'));
    assert.equal(r.status, 'error');
    assert.match(r.stats.errors[0] ?? '', /Credenciais da Pluggy recusadas/);
  });

  test('não roda dois syncs ao mesmo tempo', async () => {
    const release = await tryAdvisoryLock(db, 734_002);
    assert.ok(release);
    const r = await runSync(db, config, { trigger: 'manual' });
    assert.equal(r.status, 'locked');
    await release();
  });

  test('papel somente leitura: lê as views e não escreve nem com READ WRITE explícito', async () => {
    const { rows } = await ro.query('SELECT count(*)::int AS n FROM fin.v_transactions');
    assert.equal(rows[0].n, 13);
    await assert.rejects(ro.query("INSERT INTO fin.categories (name, kind) VALUES ('x', 'expense')"), /read-only transaction/);
    await ro.query('BEGIN READ WRITE');
    await assert.rejects(ro.query("INSERT INTO fin.categories (name, kind) VALUES ('x', 'expense')"), /permission denied/);
    await ro.query('ROLLBACK');
    await assert.rejects(ro.query('CREATE TEMP TABLE x (a int)'), /permission denied|read-only/);
  });

  // -------------------------------------------------------------------------
  // Sem providerId (o Meu Pluggy não manda). Daqui em diante as contas estão no ITEM_B.
  // -------------------------------------------------------------------------
  const syncB = () => sync(configFor([ITEM_B]));
  const statsOf = (r: Extract<SyncResult, { runId: number }>, account: string) => {
    const s = r.stats.accounts.find((a) => a.account === account);
    assert.ok(s, `sem estatísticas para ${account}`);
    return s;
  };
  const instant = (daysBack: number, time: string) => `${daysFromToday(-daysBack)}T${time}Z`;
  const cardTx = (over: Partial<PluggyTransaction>, when: string) =>
    t(ACC_CARD_B, { providerId: null, date: when, ...over, creditCardMetadata: { transactionDateTime: when, ...over.creditCardMetadata } });
  const addTo = (accountId: string, ...list: PluggyTransaction[]) =>
    state.transactions.set(accountId, [...state.transactions.get(accountId)!, ...list]);
  const replaceIn = (accountId: string, from: PluggyTransaction, to: PluggyTransaction) =>
    state.transactions.set(accountId, state.transactions.get(accountId)!.map((x) => (x.id === from.id ? to : x)));
  const removeFrom = (accountId: string, gone: PluggyTransaction) =>
    state.transactions.set(accountId, state.transactions.get(accountId)!.filter((x) => x.id !== gone.id));
  const setOverride = (txId: string, category: string, note: string | null = null) => db.query(
    'INSERT INTO fin.transaction_overrides (transaction_id, category_id, note) SELECT $1, id, $3 FROM fin.categories WHERE name = $2',
    [txId, category, note]);

  test('sem providerId: recriada com outra descrição → religada pelo instante exato, override mantido', async () => {
    const original = cardTx({ description: 'UBER *TRIP PENDENTE', amount: 23.5 }, instant(4, '15:42:10.001'));
    addTo(ACC_CARD_B, original);
    await syncB();
    const before = await txByDesc('UBER *TRIP PENDENTE');
    await setOverride(before.id, 'Viagem');

    replaceIn(ACC_CARD_B, original, { ...original, id: randomUUID(), description: 'UBER *UBER TRIP HELP.U' });
    const s = statsOf(await syncB(), 'CARTAO TESTE');
    assert.deepEqual({ relinked: s.relinked, inserted: s.inserted, softDeleted: s.softDeleted }, { relinked: 1, inserted: 0, softDeleted: 0 });
    const after = await one<{ id: string; category: string }>("SELECT id, category FROM fin.v_transactions WHERE description = 'UBER *UBER TRIP HELP.U'");
    assert.deepEqual(after, { id: before.id, category: 'Viagem' });
  });

  test('sem providerId: recriada com outro valor → religada pelo instante exato', async () => {
    const original = cardTx({ description: 'STEAM PURCHASE', amount: 50 }, instant(3, '22:05:31.001'));
    addTo(ACC_CARD_B, original);
    await syncB();
    const before = await txByDesc('STEAM PURCHASE');

    replaceIn(ACC_CARD_B, original, { ...original, id: randomUUID(), amount: 52.37 });
    const s = statsOf(await syncB(), 'CARTAO TESTE');
    assert.deepEqual({ relinked: s.relinked, inserted: s.inserted }, { relinked: 1, inserted: 0 });
    const after = await txByDesc('STEAM PURCHASE');
    assert.deepEqual({ id: after.id, amount: after.signed_amount }, { id: before.id, amount: '-52.37' });
  });

  test('sem providerId: parcelas da mesma compra (mesmo instante) religam cada uma na sua', async () => {
    const when = instant(6, '13:00:54.001');
    const p1 = cardTx({ description: 'NETSHOES 01/03', amount: 100, date: at(daysFromToday(-6)), creditCardMetadata: installment(1, 3) }, when);
    const p2 = cardTx({ description: 'NETSHOES 02/03', amount: 100, date: at(`${nextMonth}-06`), status: 'PENDING', creditCardMetadata: installment(2, 3) }, when);
    addTo(ACC_CARD_B, p1, p2);
    await syncB();
    const ids = async () => (await db.query<{ id: string; installment_number: number }>(
      "SELECT id, installment_number FROM fin.transactions WHERE description ILIKE 'netshoes%' AND deleted_at IS NULL ORDER BY installment_number")).rows;
    const before = await ids();

    replaceIn(ACC_CARD_B, p1, { ...p1, id: randomUUID(), description: 'NETSHOES*LOJA 01/03' });
    replaceIn(ACC_CARD_B, p2, { ...p2, id: randomUUID(), description: 'NETSHOES*LOJA 02/03' });
    const s = statsOf(await syncB(), 'CARTAO TESTE');
    assert.deepEqual({ relinked: s.relinked, inserted: s.inserted }, { relinked: 2, inserted: 0 });
    assert.deepEqual(await ids(), before);
  });

  test('débito automático da fatura na conta ("GASTOS CARTAO DE CREDITO") não conta como gasto', async () => {
    addTo(ACC_CHK_B, t(ACC_CHK_B, { description: 'GASTOS CARTAO DE CREDITO - DOCTO: 3990222', amount: -917.29, providerId: null }));
    await syncB();
    const row = await one<{ category: string; flow: string }>(
      "SELECT category, flow FROM fin.v_transactions WHERE description LIKE 'GASTOS CARTAO DE CREDITO%'");
    assert.deepEqual(row, { category: 'Pagamento de fatura', flow: 'transfer' });
  });

  test('parcelamento que parou de vir (ex.: antecipado) não é projetado em meses que já passaram', async () => {
    const threeMonthsAgo = shiftMonth(today, -3).slice(0, 7);
    addTo(ACC_CARD_B, t(ACC_CARD_B, { description: 'OTICA VISTA 05/12', amount: 80, providerId: null, date: at(`${threeMonthsAgo}-10`), creditCardMetadata: installment(5, 12) }));
    await syncB();
    const plan = await one<{ lancadas: string; projetadas: string }>(
      `SELECT count(*) FILTER (WHERE source = 'lancada') AS lancadas, count(*) FILTER (WHERE source = 'projetada') AS projetadas
       FROM fin.v_installment_plan WHERE description = 'OTICA VISTA'`);
    assert.deepEqual(plan, { lancadas: '1', projetadas: '0' });
    // Parcelamento em dia continua projetado (NETSHOES: 3ª parcela no mês seguinte à 2ª).
    const netshoes = await one<{ n: string }>("SELECT count(*) AS n FROM fin.v_installment_plan WHERE description = 'NETSHOES' AND source = 'projetada'");
    assert.equal(netshoes.n, '1');
  });

  test('transação com categoria sua que some da Pluggy: avisa e aparece em v_lost_overrides', async () => {
    const gift = t(ACC_CARD_B, { description: 'PRESENTE LOJA X', amount: 199.9, providerId: null, date: at(daysFromToday(-2)) });
    addTo(ACC_CARD_B, gift);
    await syncB();
    await setOverride((await txByDesc('PRESENTE LOJA X')).id, 'Lazer', 'aniversário da Ana');

    removeFrom(ACC_CARD_B, gift);
    const r = await syncB();
    assert.equal(statsOf(r, 'CARTAO TESTE').softDeleted, 1);
    assert.ok(r.stats.warnings.some((w) => w.includes('categoria ou nota sua')), JSON.stringify(r.stats.warnings));
    const lost = await one<{ description: string; category: string; note: string }>(
      'SELECT description, category, note FROM fin.v_lost_overrides');
    assert.deepEqual(lost, { description: 'PRESENTE LOJA X', category: 'Lazer', note: 'aniversário da Ana' });
  });

  test('sync_runs registra cada execução', async () => {
    const { rows } = await db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM fin.sync_runs GROUP BY status ORDER BY status');
    const map = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    assert.equal(map.running ?? 0, 0);
    assert.ok((map.success ?? 0) >= 7);
    assert.equal(map.error, 1);
  });
});
