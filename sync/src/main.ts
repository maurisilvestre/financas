// CLI do serviço de sync.
//   migrate          aplica as migrations
//   check            testa as credenciais e lista items e contas (não grava nada)
//   sync [--full]    roda uma sincronização agora (--full busca a janela inicial completa)
//   daemon           fica rodando e sincroniza nos horários de SYNC_TIMES
//   status           mostra as últimas execuções e a situação de cada conta
//   mcp              servidor MCP no stdin/stdout (para o Claude Desktop / Claude Code)
//   web              app web: API + front (pasta web/)
//   classify         sugere categorias por IA (Claude Haiku) para o que nenhuma regra pegou
import Anthropic from '@anthropic-ai/sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAllowedHosts, startWebServer } from './api/server.ts';
import { type ClassifyConfig, classifyPending, loadClassifyConfig } from './classify.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createPool, type Db } from './db.ts';
import { errorMessage, log, logToStderr, shortId } from './log.ts';
import { serveStdio } from './mcp/protocol.ts';
import { buildServer } from './mcp/tools.ts';
import { migrate } from './migrate.ts';
import { contextoMcp, type Pools } from './queries.ts';
import { PluggyClient } from './pluggy.ts';
import { pedidoDeSync } from './pedido.ts';
import { esperarProximo, msUntilNext } from './scheduler.ts';
import { runSync } from './sync.ts';

const here = dirname(fileURLToPath(import.meta.url));
// No container as migrations ficam em /app/migrations; no repositório, em ../db/migrations.
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? (here.startsWith('/app/') ? '/app/migrations' : join(here, '..', '..', 'db', 'migrations'));

/**
 * MCP: lê com fin_readonly e escreve com fin_mcp (só overrides e regras). O stdout é só do
 * protocolo; o log vai para o stderr. Conexão: PGHOST/PGPORT/PGDATABASE + as senhas abaixo.
 */
/**
 * Conexões da camada do usuário (MCP e app web): leitura com fin_readonly e escrita com
 * fin_mcp (só overrides e regras). Host/porta/banco vêm de PGHOST/PGPORT/PGDATABASE.
 */
function userPools(applicationName: string): Pools {
  const secret = (name: string, hint: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} não definido: ${hint}`);
    return value;
  };
  const base = { application_name: applicationName, statement_timeout: 15_000, max: 3 };
  return {
    read: createPool(undefined, { ...base, user: 'fin_readonly', password: secret('READ_DB_PASSWORD', 'é a READONLY_DB_PASSWORD do .env') }),
    write: createPool(undefined, { ...base, user: 'fin_mcp', password: secret('WRITE_DB_PASSWORD', 'defina MCP_DB_PASSWORD no .env (README, seção "MCP")') }),
  };
}

async function cmdMcp(): Promise<number> {
  logToStderr();
  const pools = userPools('financas-mcp');
  try {
    const contexto = await contextoMcp(pools.read);
    log.info(contexto ? 'MCP pronto, com o contexto da casa' : 'MCP pronto');
    await serveStdio(buildServer(pools, contexto), process.stdin, process.stdout);
  } finally {
    await Promise.all([pools.read.end(), pools.write.end()]).catch(() => {});
  }
  return 0;
}

/** App web: API + front compilado. No container escuta em 0.0.0.0; o compose publica só em 127.0.0.1. */
async function cmdWeb(): Promise<number> {
  const pools = userPools('financas-web');
  const port = Number(process.env.WEB_LISTEN_PORT ?? 8080);
  const host = process.env.WEB_LISTEN_HOST ?? '127.0.0.1';
  const staticDir = process.env.WEB_STATIC_DIR ?? (here.startsWith('/app/') ? '/app/web' : join(here, '..', '..', 'web', 'dist'));
  const proxyHostnames = parseAllowedHosts(process.env.WEB_ALLOWED_HOSTS);
  await pools.read.query('SELECT 1');
  const server = await startWebServer({ pools, host, port, staticDir, proxyHostnames });
  log.info(`App web no ar (porta ${port} do container)${proxyHostnames.length ? `; aceita também ${proxyHostnames.join(', ')} (https)` : ''}`);

  await new Promise<void>((resolveSignal) => {
    process.once('SIGTERM', () => resolveSignal());
    process.once('SIGINT', () => resolveSignal());
  });
  log.info('Encerrando o app web');
  await new Promise((r) => server.close(r));
  await Promise.all([pools.read.end(), pools.write.end()]).catch(() => {});
  return 0;
}

async function cmdMigrate(db: Db): Promise<void> {
  const applied = await migrate(db, MIGRATIONS_DIR);
  log.info(applied.length ? `Migrations aplicadas: ${applied.join(', ')}` : 'Banco já está atualizado');
}

async function cmdCheck(): Promise<void> {
  const config = loadConfig();
  const client = new PluggyClient({ ...config.pluggy, timeoutMs: config.pluggy.requestTimeoutMs });
  await client.checkCredentials();
  console.log('✔ Credenciais da Pluggy OK');
  for (const itemId of config.pluggy.itemIds) {
    try {
      const item = await client.getItem(itemId);
      console.log(`\nItem ${shortId(itemId)}`);
      console.log(`  conector: ${item.connector?.name ?? '?'} | status: ${item.status}/${item.executionStatus}`);
      console.log(`  atualizado com o banco: ${item.lastUpdatedAt ?? '?'} | consentimento expira: ${item.consentExpiresAt ?? 'não informado'}`);
      const accounts = await client.listAccounts(itemId);
      for (const a of accounts) {
        const last4 = (a.number ?? '').replace(/\D/g, '').slice(-4);
        console.log(`  - ${a.type}/${a.subtype}: ${a.marketingName || a.name}${last4 ? ` (final ${last4})` : ''}`);
      }
      if (accounts.length === 0) console.log('  (nenhuma conta: confira se o conector MeuPluggy foi vinculado a este item no Dashboard)');
    } catch (err) {
      console.log(`\n✘ Item ${shortId(itemId)}: ${errorMessage(err)}`);
    }
  }
}

async function cmdStatus(db: Db): Promise<void> {
  const runs = await db.query(
    `SELECT id, trigger, status, started_at, finished_at, jsonb_array_length(stats->'warnings') AS warnings, error
     FROM fin.sync_runs ORDER BY id DESC LIMIT 5`,
  );
  console.log('Últimas execuções:');
  console.table(runs.rows);
  const accounts = await db.query(
    `SELECT name, subtype, number_last4, balance, item_status, bank_data_updated_at, consent_expires_at, last_synced_at
     FROM fin.v_accounts ORDER BY name`,
  );
  console.log('Contas:');
  console.table(accounts.rows);
}

/** Sugere categorias por IA para o que nenhuma regra pegou. Só registra no log; nunca a chave. */
async function classifyNow(db: Db, cfg: ClassifyConfig): Promise<void> {
  const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 3, timeout: 120_000 });
  const r = await classifyPending(db, client, cfg);
  for (const w of r.warnings) log.warn(`Classificação: ${w}`);
  log.info('Classificação por IA', {
    modelo: cfg.model, estabelecimentos: r.keys, sugeridas: r.suggested, incertas: r.uncertain,
    pedidos: r.requests, tokens_entrada: r.inputTokens, tokens_saida: r.outputTokens,
  });
}

/** Depois de cada sync: classifica o que chegou sem categoria. Desligada sem ANTHROPIC_API_KEY. */
async function classifyAfterSync(db: Db): Promise<void> {
  if (process.env.CLASSIFY_AFTER_SYNC === 'false') return;
  const cfg = loadClassifyConfig();
  if (!cfg) return;
  await classifyNow(db, cfg).catch((err) => log.warn('Classificação por IA falhou', { error: errorMessage(err) }));
}

async function cmdClassify(db: Db): Promise<number> {
  const cfg = loadClassifyConfig();
  if (!cfg) {
    console.error('Defina ANTHROPIC_API_KEY no .env para ligar a classificação por IA (README, seção "Classificação por IA").');
    return 1;
  }
  await classifyNow(db, cfg);
  return 0;
}

async function cmdDaemon(db: Db): Promise<void> {
  const config = loadConfig();
  const classify = loadClassifyConfig();
  log.info(classify && process.env.CLASSIFY_AFTER_SYNC !== 'false'
    ? `Classificação por IA ligada (${classify.model}), depois de cada sync`
    : 'Classificação por IA desligada (sem ANTHROPIC_API_KEY ou CLASSIFY_AFTER_SYNC=false)');
  const controller = new AbortController();
  let running: Promise<unknown> | null = null;

  const shutdown = async (signal: string) => {
    log.info(`${signal} recebido; encerrando`);
    controller.abort();
    if (running) await Promise.race([running, sleep(60_000)]);
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const times = config.sync.times.map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`);
  log.info(`Daemon iniciado; sincroniza às ${times.join(', ')} (${config.timezone})`);

  if (config.sync.runOnStart) {
    const { rows } = await db.query<{ recent: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM fin.sync_runs WHERE status IN ('success', 'partial') AND started_at > now() - interval '6 hours') AS recent",
    );
    if (!rows[0]?.recent) {
      running = runSync(db, config, { trigger: 'startup' })
        .then(() => classifyAfterSync(db))
        .catch((err) => log.error('Sync falhou', { error: errorMessage(err) }));
      await running;
      running = null;
    }
  }

  while (!controller.signal.aborted) {
    const wait = msUntilNext(config.sync.times, new Date(), config.timezone);
    log.info(`Próximo sync em ${Math.round(wait / 60_000)} min`);
    // Espera o horário marcado, mas roda antes se o app pedir (botão "Sincronizar").
    const trigger = await esperarProximo(wait, () => pedidoDeSync(db), controller.signal);
    if (!trigger) break; // encerrado
    if (trigger === 'app') log.info('Sync pedido pelo app');
    running = runSync(db, config, { trigger })
      .then(() => classifyAfterSync(db))
      .catch((err) => log.error('Sync falhou', { error: errorMessage(err) }));
    await running;
    running = null;
  }
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'check') {
    await cmdCheck();
    return 0;
  }
  if (command === 'mcp') return cmdMcp();
  if (command === 'web') return cmdWeb();

  const db = createPool();
  try {
    switch (command) {
      case 'migrate':
        await cmdMigrate(db);
        return 0;
      case 'sync': {
        const result = await runSync(db, loadConfig(), { trigger: 'manual', full: args.includes('--full') });
        if (result.status === 'success' || result.status === 'partial') await classifyAfterSync(db);
        return result.status === 'success' ? 0 : result.status === 'partial' ? 2 : 1;
      }
      case 'classify':
        return await cmdClassify(db);
      case 'status':
        await cmdStatus(db);
        return 0;
      case 'daemon':
        await cmdDaemon(db);
        return 0;
      default:
        console.error('Uso: node src/main.ts <migrate | check | sync [--full] | classify | daemon | status | mcp | web>');
        return 64;
    }
  } finally {
    await db.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error(errorMessage(err));
    process.exit(1);
  },
);
