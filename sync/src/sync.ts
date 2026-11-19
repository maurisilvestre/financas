// Orquestra uma sincronização: items → contas → transações → parcelas → faturas.
//
// Garantias:
//  * Idempotente: rodar duas vezes seguidas não duplica nada.
//  * Nada é apagado: o que some da Pluggy ganha deleted_at e pode voltar.
//  * Religação: quando a Pluggy apaga e recria uma transação com id novo (ou quando você
//    reconecta o banco e tudo ganha id novo), a linha existente é reaproveitada (providerId
//    do banco ou, sem ele, o instante exato da transação), e suas edições (categoria, nota)
//    continuam valendo. O que não der para religar e tiver edição sua gera aviso.
//  * Cada conta é gravada na sua própria transação: falha numa conta não perde as outras.
import type { Config } from './config.ts';
import { type Db, type DbClient, tryAdvisoryLock, withTransaction } from './db.ts';
import { errorMessage, log, shortId } from './log.ts';
import {
  type NormalizedTransaction,
  accountFingerprint,
  dateInTimezone,
  daysAgo,
  installmentAnchorMonth,
  installmentMatchKey,
  money,
  normalizeTransaction,
  stripInstallmentSuffix,
  toLocalDateOrNull,
} from './normalize.ts';
import { PluggyClient, PluggyError, type PluggyAccount, type PluggyBill, type PluggyInvestment, type PluggyItem } from './pluggy.ts';

const SYNC_LOCK = 734_002;

/** Se mais que isso da janela sumir de uma vez, provavelmente é falha da API: não marca como apagado. */
const MAX_SOFT_DELETE_RATIO = 0.5;
const MIN_ROWS_FOR_RATIO_GUARD = 10;

export interface AccountStats {
  account: string;
  fetched: number;
  inserted: number;
  updated: number;
  relinked: number;
  softDeleted: number;
  softDeleteSkipped: boolean;
  signMismatch: number;
  grouped: number;
  bills: number;
  window: string;
}

export interface SyncStats {
  items: number;
  accounts: AccountStats[];
  /** Investimentos vistos (o guardado). */
  investments: number;
  warnings: string[];
  errors: string[];
}

export interface SyncOptions {
  /** app = botão "Sincronizar" do app. */
  trigger: 'manual' | 'schedule' | 'startup' | 'app';
  /** Força a janela inicial (SYNC_INITIAL_LOOKBACK_DAYS) em todas as contas. */
  full?: boolean;
}

export type SyncResult =
  | { status: 'success' | 'partial' | 'error'; runId: number; stats: SyncStats }
  | { status: 'locked' };

export async function runSync(db: Db, config: Config, opts: SyncOptions): Promise<SyncResult> {
  const release = await tryAdvisoryLock(db, SYNC_LOCK);
  if (!release) {
    log.warn('Outro sync já está em execução; pulando esta rodada');
    return { status: 'locked' };
  }

  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO fin.sync_runs (trigger) VALUES ($1) RETURNING id", [opts.trigger],
  );
  const runId = Number(rows[0]!.id);
  const stats: SyncStats = { items: 0, accounts: [], investments: 0, warnings: [], errors: [] };
  const started = Date.now();
  log.info(`Sync #${runId} iniciado`, { trigger: opts.trigger, items: config.pluggy.itemIds.length, full: !!opts.full });

  let status: 'success' | 'partial' | 'error' = 'error';
  try {
    const client = new PluggyClient({
      baseUrl: config.pluggy.baseUrl,
      clientId: config.pluggy.clientId,
      clientSecret: config.pluggy.clientSecret,
      timeoutMs: config.pluggy.requestTimeoutMs,
    });
    await syncAll(db, client, config, opts, stats);
    const anySuccess = stats.accounts.length > 0;
    status = stats.errors.length === 0 ? 'success' : anySuccess ? 'partial' : 'error';
  } catch (err) {
    stats.errors.push(errorMessage(err));
    status = 'error';
  } finally {
    await db.query(
      'UPDATE fin.sync_runs SET status = $2, finished_at = now(), stats = $3, error = $4 WHERE id = $1',
      [runId, status, JSON.stringify(stats), stats.errors.length ? stats.errors.join('\n') : null],
    ).catch((err) => log.error('Falha ao registrar o fim do sync', { error: errorMessage(err) }));
    await release();
  }

  const summary = stats.accounts.reduce(
    (acc, a) => ({ inserted: acc.inserted + a.inserted, updated: acc.updated + a.updated, relinked: acc.relinked + a.relinked, softDeleted: acc.softDeleted + a.softDeleted }),
    { inserted: 0, updated: 0, relinked: 0, softDeleted: 0 },
  );
  const level = status === 'success' ? 'info' : status === 'partial' ? 'warn' : 'error';
  log[level](`Sync #${runId} terminou: ${status}`, { ms: Date.now() - started, accounts: stats.accounts.length, ...summary, investments: stats.investments, warnings: stats.warnings.length, errors: stats.errors });
  return { status, runId, stats };
}

async function syncAll(db: Db, client: PluggyClient, config: Config, opts: SyncOptions, stats: SyncStats): Promise<void> {
  // Falha de credencial derruba tudo: melhor parar cedo com uma mensagem clara.
  try {
    await client.checkCredentials();
  } catch (err) {
    if (err instanceof PluggyError && err.status === 401) {
      throw new Error('Credenciais da Pluggy recusadas (PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET).');
    }
    throw err;
  }

  const seenAccountIds = new Set<string>();

  for (const itemId of config.pluggy.itemIds) {
    let item: PluggyItem;
    try {
      item = await client.getItem(itemId);
    } catch (err) {
      const hint = err instanceof PluggyError && err.status === 404 ? ' (item não encontrado: confira o id no Dashboard da Pluggy)' : '';
      stats.errors.push(`Item ${shortId(itemId)}: ${errorMessage(err)}${hint}`);
      continue;
    }
    await upsertItem(db, item);
    stats.items++;
    warnAboutItem(item, stats);

    let accounts: PluggyAccount[];
    try {
      accounts = await client.listAccounts(itemId);
    } catch (err) {
      stats.errors.push(`Contas do item ${shortId(itemId)}: ${errorMessage(err)}`);
      continue;
    }

    for (const account of accounts) {
      try {
        const accStats = await syncAccount(db, client, config, opts, item, account, seenAccountIds, stats);
        if (accStats) stats.accounts.push(accStats);
      } catch (err) {
        stats.errors.push(`Conta ${account.name} (${shortId(account.id)}): ${errorMessage(err)}`);
        log.error('Falha ao sincronizar conta', { account: account.name, error: errorMessage(err) });
      }
    }

    // Investimentos (o guardado): falha aqui só avisa; contas e transações já foram.
    try {
      const list = await client.listInvestments(itemId);
      stats.investments += await withTransaction(db, (c) => upsertInvestments(c, itemId, list));
    } catch (err) {
      warn(stats, `Investimentos do item ${shortId(itemId)}: ${errorMessage(err)} (o guardado fica como estava).`);
    }
  }

  // Item que saiu de PLUGGY_ITEM_IDS (ex.: reconexão): os investimentos dele não contam mais.
  await db.query(
    'UPDATE fin.investments SET deleted_at = now() WHERE deleted_at IS NULL AND NOT (item_id = ANY($1::uuid[]))',
    [config.pluggy.itemIds],
  );
}

function warnAboutItem(item: PluggyItem, stats: SyncStats): void {
  const label = `Item ${shortId(item.id)} (${item.connector?.name ?? '?'})`;
  if (item.status && item.status !== 'UPDATED' && item.status !== 'UPDATING') {
    warn(stats, `${label} está com status ${item.status}/${item.executionStatus ?? '?'}: os dados podem estar desatualizados. Reautorize no Meu Pluggy.`);
  }
  if (item.consentExpiresAt) {
    const daysLeft = Math.floor((new Date(item.consentExpiresAt).getTime() - Date.now()) / 86_400_000);
    if (daysLeft <= 30) {
      warn(stats, `${label}: o consentimento do Open Finance expira em ${daysLeft} dia(s). Renove no app do banco / Meu Pluggy.`);
    }
  }
  if (item.lastUpdatedAt) {
    const hours = (Date.now() - new Date(item.lastUpdatedAt).getTime()) / 3_600_000;
    if (hours > 48) warn(stats, `${label}: a Pluggy não atualiza com o banco há ${Math.floor(hours)} h.`);
  }
}

async function upsertItem(db: Db, item: PluggyItem): Promise<void> {
  await db.query(
    `INSERT INTO fin.items (id, connector_name, status, execution_status, last_updated_at, consent_expires_at, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       connector_name = EXCLUDED.connector_name, status = EXCLUDED.status,
       execution_status = EXCLUDED.execution_status, last_updated_at = EXCLUDED.last_updated_at,
       consent_expires_at = EXCLUDED.consent_expires_at, raw = EXCLUDED.raw, last_synced_at = now()`,
    [item.id, item.connector?.name ?? null, item.status ?? null, item.executionStatus ?? null,
      item.lastUpdatedAt ?? null, item.consentExpiresAt ?? null, JSON.stringify(item)],
  );
}

interface AccountRow {
  id: number;
  relinked: boolean;
}

async function syncAccount(
  db: Db, client: PluggyClient, config: Config, opts: SyncOptions,
  item: PluggyItem, account: PluggyAccount, seenAccountIds: Set<string>, stats: SyncStats,
): Promise<AccountStats | null> {
  const label = account.marketingName || account.name;

  const row = await withTransaction(db, (c) => upsertAccount(c, item, account, seenAccountIds, stats));
  if (!row) return null;
  seenAccountIds.add(account.id);

  // Janela: primeira vez (ou conta religada após reconexão) busca o histórico todo.
  const { rows: countRows } = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM fin.transactions WHERE account_id = $1', [row.id],
  );
  const firstTime = Number(countRows[0]!.n) === 0;
  const lookback = opts.full || firstTime || row.relinked ? config.sync.initialLookbackDays : config.sync.lookbackDays;
  const dateFrom = daysAgo(lookback, new Date(), config.timezone);

  const fetched = new Map<string, NormalizedTransaction>();
  for await (const page of client.listTransactions(account.id, { dateFrom })) {
    for (const tx of page) fetched.set(tx.id, normalizeTransaction(tx, account.type, config.timezone));
  }
  const incoming = [...fetched.values()];

  const result = await withTransaction(db, (c) => applyTransactions(c, row.id, incoming, dateFrom, label, stats));

  const grouped = await withTransaction(db, (c) => groupInstallments(c, row.id));

  let bills = 0;
  if (account.type === 'CREDIT') {
    try {
      const list = await client.listBills(account.id);
      bills = await withTransaction(db, (c) => upsertBills(c, row.id, list));
    } catch (err) {
      // Faturas só existem em conexões Open Finance reguladas; não é motivo para falhar a conta.
      warn(stats, `Faturas de ${label}: ${errorMessage(err)}`);
    }
  }

  const accStats: AccountStats = {
    account: label,
    fetched: incoming.length,
    ...result,
    signMismatch: incoming.filter((t) => t.sign_mismatch).length,
    grouped,
    bills,
    window: `${dateFrom}→`,
  };
  if (accStats.signMismatch > 0) {
    warn(stats, `${label}: ${accStats.signMismatch} transação(ões) com sinal inesperado para o tipo (veja raw); o signed_amount segue o campo type.`);
  }
  log.info(`Conta ${label}`, { ...accStats, account: undefined });
  return accStats;
}

async function upsertAccount(
  c: DbClient, item: PluggyItem, a: PluggyAccount, seenAccountIds: Set<string>, stats: SyncStats,
): Promise<AccountRow | null> {
  const fields = [
    item.id, a.type, a.subtype, a.name, a.marketingName ?? null, a.number ?? null,
    a.currencyCode ?? 'BRL', money(a.balance ?? null),
    money(a.creditData?.creditLimit ?? null), money(a.creditData?.availableCreditLimit ?? null),
    toLocalDateOrNull(a.creditData?.balanceCloseDate), toLocalDateOrNull(a.creditData?.balanceDueDate),
    JSON.stringify(a),
  ];
  const setClause = `item_id = $2, type = $3, subtype = $4, name = $5, marketing_name = $6, number = $7,
    currency_code = $8, balance = $9, credit_limit = $10, available_credit_limit = $11,
    balance_close_date = $12, balance_due_date = $13, raw = $14, last_synced_at = now()`;

  let accountId: number;
  let relinked = false;

  const byId = await c.query<{ id: string }>('SELECT id FROM fin.accounts WHERE pluggy_id = $1', [a.id]);
  if (byId.rows[0]) {
    accountId = Number(byId.rows[0].id);
    await c.query(`UPDATE fin.accounts SET ${setClause} WHERE pluggy_id = $1`, [a.id, ...fields]);
  } else {
    const fingerprint = accountFingerprint(a);
    const byFp = await c.query<{ id: string; pluggy_id: string }>(
      'SELECT id, pluggy_id FROM fin.accounts WHERE fingerprint = $1', [fingerprint],
    );
    const existing = byFp.rows[0];
    if (existing && seenAccountIds.has(existing.pluggy_id)) {
      warn(stats, `A conta ${a.name} aparece em mais de um item (${shortId(item.id)}). Se você reconectou o banco, remova o item antigo de PLUGGY_ITEM_IDS. Ignorada nesta rodada.`);
      return null;
    }
    if (existing) {
      // Reconexão: mesma conta, id novo na Pluggy. Mantém o id interno e o histórico.
      accountId = Number(existing.id);
      relinked = true;
      await c.query(
        `UPDATE fin.accounts SET previous_pluggy_ids = array_append(previous_pluggy_ids, pluggy_id),
           pluggy_id = $1, ${setClause} WHERE id = $15`,
        [a.id, ...fields, accountId],
      );
      log.info(`Conta ${a.name} religada a um novo id da Pluggy (reconexão)`);
    } else {
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO fin.accounts (pluggy_id, fingerprint, item_id, type, subtype, name, marketing_name, number,
           currency_code, balance, credit_limit, available_credit_limit, balance_close_date, balance_due_date, raw)
         VALUES ($1, $15, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [a.id, ...fields, fingerprint],
      );
      accountId = Number(inserted.rows[0]!.id);
    }
  }

  await c.query(
    `INSERT INTO fin.account_balance_snapshots (account_id, captured_on, balance, credit_limit, available_credit_limit)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, captured_on) DO UPDATE SET
       balance = EXCLUDED.balance, credit_limit = EXCLUDED.credit_limit,
       available_credit_limit = EXCLUDED.available_credit_limit, captured_at = now()`,
    [accountId, dateInTimezone(new Date()), money(a.balance ?? null),
      money(a.creditData?.creditLimit ?? null), money(a.creditData?.availableCreditLimit ?? null)],
  );

  return { id: accountId, relinked };
}

// Colunas copiadas da tabela temporária "incoming" para fin.transactions.
const TX_COLUMNS = [
  'provider_id', 'provider_code', 'occurred_at', 'precise_at', 'local_date', 'description', 'description_raw',
  'amount', 'signed_amount', 'currency_code', 'amount_in_account_currency', 'type', 'status',
  'operation_type', 'pluggy_category', 'installment_number', 'total_installments', 'purchase_date',
  'bill_pluggy_id', 'card_number', 'raw',
] as const;
const TX_SET_FROM_INCOMING = TX_COLUMNS.map((col) => `${col} = i.${col}`).join(', ');

async function applyTransactions(
  c: DbClient, accountId: number, incoming: NormalizedTransaction[], dateFrom: string, label: string, stats: SyncStats,
): Promise<Pick<AccountStats, 'inserted' | 'updated' | 'relinked' | 'softDeleted' | 'softDeleteSkipped'>> {
  await c.query(`
    CREATE TEMP TABLE incoming (
      pluggy_id uuid PRIMARY KEY, provider_id text, provider_code text, occurred_at timestamptz,
      precise_at timestamptz, local_date date, description text, description_raw text, amount numeric(14,2),
      signed_amount numeric(14,2), currency_code text, amount_in_account_currency numeric(14,2),
      type text, status text, operation_type text, pluggy_category text, installment_number int,
      total_installments int, purchase_date date, bill_pluggy_id uuid, card_number text, raw jsonb
    ) ON COMMIT DROP`);

  const BATCH = 500;
  for (let i = 0; i < incoming.length; i += BATCH) {
    const batch = incoming.slice(i, i + BATCH).map(({ sign_mismatch: _ignored, ...t }) => t);
    await c.query(
      `INSERT INTO incoming
       SELECT * FROM jsonb_populate_recordset(NULL::incoming, $1::jsonb)`,
      [JSON.stringify(batch)],
    );
  }

  // 1. Mesmo id da Pluggy: atualiza (PENDING → POSTED, descrição corrigida...) e "desapaga".
  const updated = await c.query(
    `UPDATE fin.transactions t SET ${TX_SET_FROM_INCOMING}, last_seen_at = now(), deleted_at = NULL
     FROM incoming i WHERE t.pluggy_id = i.pluggy_id AND t.account_id = $1`,
    [accountId],
  );

  // 2. Ids novos: tenta religar a uma linha existente cujo id antigo não veio mais.
  //    rank 1 = mesmo providerId (id do banco, estável entre itens)
  //    rank 2 = mesmo providerCode e mesmo valor
  //    Quando falta providerId de um dos lados (o Meu Pluggy nunca manda):
  //    rank 3 = mesmo instante exato e mesma parcela, com o mesmo valor OU a mesma descrição
  //             (religa quando a Pluggy recria mudando só a descrição ou só o valor)
  //    rank 4 = mesma data, valor e descrição
  const candidates = await c.query<{ new_id: string; tx_id: string; rank: number }>(
    `WITH pairs AS (
       SELECT n.pluggy_id AS new_id, t.id AS tx_id, t.deleted_at,
              (n.provider_id IS NOT NULL AND t.provider_id = n.provider_id) AS by_provider_id,
              (n.provider_code IS NOT NULL AND t.provider_code = n.provider_code
                AND t.signed_amount = n.signed_amount) AS by_provider_code,
              ((n.provider_id IS NULL OR t.provider_id IS NULL)
                AND t.precise_at = n.precise_at
                AND t.installment_number IS NOT DISTINCT FROM n.installment_number
                AND (t.signed_amount = n.signed_amount
                     OR fin.norm_text(t.description) = fin.norm_text(n.description))) AS by_instant,
              ((n.provider_id IS NULL OR t.provider_id IS NULL)
                AND t.local_date = n.local_date AND t.signed_amount = n.signed_amount
                AND fin.norm_text(t.description) = fin.norm_text(n.description)) AS by_attributes
       FROM incoming n
       JOIN fin.transactions t ON t.account_id = $1
       WHERE NOT EXISTS (SELECT 1 FROM fin.transactions x WHERE x.pluggy_id = n.pluggy_id)
         AND NOT EXISTS (SELECT 1 FROM incoming y WHERE y.pluggy_id = t.pluggy_id)
         AND (t.deleted_at IS NOT NULL OR t.occurred_at >= $2::date - interval '7 days')
         -- filtro barato antes de comparar descrições
         AND (t.provider_id = n.provider_id OR t.provider_code = n.provider_code
              OR t.precise_at = n.precise_at OR (t.local_date = n.local_date AND t.signed_amount = n.signed_amount))
     )
     SELECT new_id, tx_id,
            CASE WHEN by_provider_id THEN 1 WHEN by_provider_code THEN 2 WHEN by_instant THEN 3 ELSE 4 END AS rank
     FROM pairs
     WHERE by_provider_id OR by_provider_code OR by_instant OR by_attributes
     ORDER BY rank, deleted_at DESC NULLS LAST, tx_id`,
    [accountId, dateFrom],
  );
  const usedNew = new Set<string>();
  const usedTx = new Set<string>();
  const pairs: Array<{ tx_id: number; new_id: string }> = [];
  for (const cand of candidates.rows) {
    if (usedNew.has(cand.new_id) || usedTx.has(cand.tx_id)) continue;
    usedNew.add(cand.new_id);
    usedTx.add(cand.tx_id);
    pairs.push({ tx_id: Number(cand.tx_id), new_id: cand.new_id });
  }
  let relinked = 0;
  if (pairs.length > 0) {
    const res = await c.query(
      `UPDATE fin.transactions t SET
         previous_pluggy_ids = array_append(t.previous_pluggy_ids, t.pluggy_id),
         pluggy_id = i.pluggy_id, ${TX_SET_FROM_INCOMING}, last_seen_at = now(), deleted_at = NULL
       FROM jsonb_to_recordset($1::jsonb) AS m(tx_id bigint, new_id uuid)
       JOIN incoming i ON i.pluggy_id = m.new_id
       WHERE t.id = m.tx_id`,
      [JSON.stringify(pairs)],
    );
    relinked = res.rowCount ?? 0;
  }

  // 3. O que sobrou é novo de verdade.
  const inserted = await c.query(
    `INSERT INTO fin.transactions (pluggy_id, account_id, ${TX_COLUMNS.join(', ')})
     SELECT i.pluggy_id, $1, ${TX_COLUMNS.map((col) => `i.${col}`).join(', ')}
     FROM incoming i
     WHERE NOT EXISTS (SELECT 1 FROM fin.transactions t WHERE t.pluggy_id = i.pluggy_id)`,
    [accountId],
  );

  // 4. O que estava na janela e não veio mais: soft delete.
  //    Margem de 2 dias no início da janela (a borda do filtro dateFrom é em UTC).
  const missing = await c.query<{ missing: string; in_window: string }>(
    `SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM incoming i WHERE i.pluggy_id = t.pluggy_id)) AS missing,
            count(*) AS in_window
     FROM fin.transactions t
     WHERE t.account_id = $1 AND t.deleted_at IS NULL AND t.occurred_at >= $2::date + interval '2 days'`,
    [accountId, dateFrom],
  );
  const missingCount = Number(missing.rows[0]!.missing);
  const inWindow = Number(missing.rows[0]!.in_window);
  let softDeleted = 0;
  let softDeleteSkipped = false;
  const suspicious = incoming.length === 0
    || (inWindow >= MIN_ROWS_FOR_RATIO_GUARD && missingCount / inWindow > MAX_SOFT_DELETE_RATIO);
  if (missingCount > 0 && suspicious) {
    softDeleteSkipped = true;
    warn(stats, `${label}: ${missingCount} de ${inWindow} transações da janela não vieram da Pluggy. Parece falha da API, então nada foi marcado como apagado. Se for real, rode um sync novamente mais tarde.`);
  } else if (missingCount > 0) {
    const res = await c.query<{ deleted: string; with_override: string }>(
      `WITH gone AS (
         UPDATE fin.transactions t SET deleted_at = now()
         WHERE t.account_id = $1 AND t.deleted_at IS NULL AND t.occurred_at >= $2::date + interval '2 days'
           AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.pluggy_id = t.pluggy_id)
         RETURNING t.id
       )
       SELECT count(*) AS deleted, count(o.transaction_id) AS with_override
       FROM gone LEFT JOIN fin.transaction_overrides o ON o.transaction_id = gone.id`,
      [accountId, dateFrom],
    );
    softDeleted = Number(res.rows[0]!.deleted);
    const lost = Number(res.rows[0]!.with_override);
    if (lost > 0) {
      warn(stats, `${label}: ${lost} transação(ões) com categoria ou nota sua sumiram da Pluggy e saíram dos relatórios. Veja fin.v_lost_overrides e reaplique na transação nova, se ela existir.`);
    }
  }

  return {
    inserted: inserted.rowCount ?? 0,
    updated: updated.rowCount ?? 0,
    relinked,
    softDeleted,
    softDeleteSkipped,
  };
}

/**
 * Agrupa parcelas da mesma compra. O Open Finance não manda um id de agrupamento,
 * então a chave é: descrição sem o "2/6" + nº total de parcelas + data da compra
 * (quando o banco informa) ou o mês estimado da 1ª parcela, com tolerância de ±1 mês.
 * Duas compras iguais no mesmo mês viram grupos diferentes porque um grupo não aceita
 * duas parcelas com o mesmo número.
 */
async function groupInstallments(c: DbClient, accountId: number): Promise<number> {
  const { rows } = await c.query<{
    id: string; description: string; local_date: string; signed_amount: string;
    installment_number: number; total_installments: number; purchase_date: string | null;
  }>(
    `SELECT id, description, local_date, signed_amount, installment_number, total_installments, purchase_date
     FROM fin.transactions
     WHERE account_id = $1 AND installment_group_id IS NULL AND deleted_at IS NULL AND total_installments > 1
     ORDER BY local_date, installment_number, id`,
    [accountId],
  );

  let grouped = 0;
  for (const tx of rows) {
    const matchKey = installmentMatchKey(tx.description, tx.total_installments);
    const anchor = installmentAnchorMonth(tx.local_date, tx.installment_number);

    const found = await c.query<{ id: string }>(
      `SELECT g.id
       FROM fin.installment_groups g
       WHERE g.account_id = $1 AND g.match_key = $2
         AND CASE
               WHEN $3::date IS NOT NULL AND g.purchase_date IS NOT NULL THEN g.purchase_date = $3::date
               ELSE g.anchor_month BETWEEN $4::date - interval '1 month' AND $4::date + interval '1 month'
             END
         AND NOT EXISTS (
           SELECT 1 FROM fin.transactions t
           WHERE t.installment_group_id = g.id AND t.installment_number = $5 AND t.deleted_at IS NULL
         )
       ORDER BY abs(g.anchor_month - $4::date), g.id
       LIMIT 1`,
      [accountId, matchKey, tx.purchase_date, anchor, tx.installment_number],
    );

    let groupId = found.rows[0]?.id;
    if (!groupId) {
      const created = await c.query<{ id: string }>(
        `INSERT INTO fin.installment_groups
           (account_id, group_key, match_key, description, total_installments, installment_amount, anchor_month, purchase_date)
         VALUES ($1, $2, $3, $4, $5, abs($6::numeric), $7, $8) RETURNING id`,
        [accountId, `${matchKey}|${anchor}|tx:${tx.id}`, matchKey, stripInstallmentSuffix(tx.description),
          tx.total_installments, tx.signed_amount, anchor, tx.purchase_date],
      );
      groupId = created.rows[0]!.id;
    }
    await c.query('UPDATE fin.transactions SET installment_group_id = $2 WHERE id = $1', [tx.id, groupId]);
    grouped++;
  }
  return grouped;
}

async function upsertInvestments(c: DbClient, itemId: string, list: PluggyInvestment[]): Promise<number> {
  // Lista vazia: provavelmente falha da API (um item com investimentos não fica sem nenhum, nem os
  // resgatados). Não marca nada como apagado.
  if (list.length === 0) return 0;
  for (const x of list) {
    await c.query(
      `INSERT INTO fin.investments (pluggy_id, item_id, type, subtype, name, balance, currency_code, balance_date, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (pluggy_id) DO UPDATE SET
         item_id = EXCLUDED.item_id, type = EXCLUDED.type, subtype = EXCLUDED.subtype, name = EXCLUDED.name,
         balance = EXCLUDED.balance, currency_code = EXCLUDED.currency_code, balance_date = EXCLUDED.balance_date,
         status = EXCLUDED.status, raw = EXCLUDED.raw, last_seen_at = now(), deleted_at = NULL`,
      [x.id, itemId, x.type ?? null, x.subtype ?? null, x.name ?? null, money(x.balance ?? null), x.currencyCode ?? null,
        toLocalDateOrNull(x.date), x.status ?? null, JSON.stringify(x)],
    );
  }
  await c.query(
    'UPDATE fin.investments SET deleted_at = now() WHERE item_id = $1 AND deleted_at IS NULL AND NOT (pluggy_id = ANY($2::uuid[]))',
    [itemId, list.map((x) => x.id)],
  );
  return list.length;
}

async function upsertBills(c: DbClient, accountId: number, bills: PluggyBill[]): Promise<number> {
  const sum = (list: Array<{ amount?: number | null }> | null | undefined) =>
    money((list ?? []).reduce((acc, x) => acc + (x.amount ?? 0), 0));
  for (const b of bills) {
    await c.query(
      `INSERT INTO fin.credit_card_bills
         (pluggy_id, account_id, due_date, total_amount, minimum_payment_amount, allows_installments,
          finance_charges_total, payments_total, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (pluggy_id) DO UPDATE SET
         account_id = EXCLUDED.account_id, due_date = EXCLUDED.due_date, total_amount = EXCLUDED.total_amount,
         minimum_payment_amount = EXCLUDED.minimum_payment_amount, allows_installments = EXCLUDED.allows_installments,
         finance_charges_total = EXCLUDED.finance_charges_total, payments_total = EXCLUDED.payments_total,
         raw = EXCLUDED.raw, last_seen_at = now()`,
      [b.id, accountId, toLocalDateOrNull(b.dueDate), money(b.totalAmount), money(b.minimumPaymentAmount ?? null),
        b.allowsInstallments ?? null, sum(b.financeCharges), sum(b.payments), JSON.stringify(b)],
    );
  }
  return bills.length;
}

function warn(stats: SyncStats, message: string): void {
  stats.warnings.push(message);
  log.warn(message);
}
