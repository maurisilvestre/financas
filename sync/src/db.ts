import pg from 'pg';

// date (1082) volta como string "YYYY-MM-DD", sem passar por fuso horário.
pg.types.setTypeParser(1082, (v) => v);
// numeric (1700) continua string: dinheiro não vira float.

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

/**
 * Conecta usando as variáveis padrão do Postgres (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).
 * `overrides` troca o que precisar (o MCP usa outro usuário e um timeout por consulta).
 */
export function createPool(connectionString?: string, overrides: pg.PoolConfig = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 4,
    application_name: 'financas-sync',
    ...overrides,
  });
  pool.on('error', () => {
    /* erros de conexões ociosas são tratados na próxima query */
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lock de sessão (pg_try_advisory_lock) para impedir dois syncs ao mesmo tempo,
 * por exemplo o agendado e um `sync` manual. Retorna null se já estiver em uso.
 */
export async function tryAdvisoryLock(db: Db, key: number): Promise<(() => Promise<void>) | null> {
  const client = await db.connect();
  const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key]);
  if (!rows[0]?.ok) {
    client.release();
    return null;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      client.release();
    }
  };
}
