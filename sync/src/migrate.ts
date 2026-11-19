// Runner de migrations em SQL puro: aplica db/migrations/NNNN_nome.sql em ordem,
// cada uma numa transação, e guarda o checksum para detectar arquivos alterados.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { log } from './log.ts';

const MIGRATION_LOCK = 734_001;
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export async function migrate(db: Db, dir: string): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('CREATE SCHEMA IF NOT EXISTS fin');
    await client.query(`
      CREATE TABLE IF NOT EXISTS fin.schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM fin.schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    const files = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`A migration ${file} foi alterada depois de aplicada. Crie uma nova migration em vez de editar a antiga.`);
        }
        continue;
      }
      log.info(`Aplicando migration ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO fin.schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Falha na migration ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
