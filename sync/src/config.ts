import { readFileSync } from 'node:fs';

export interface SyncTime {
  hour: number;
  minute: number;
}

export interface Config {
  timezone: string;
  pluggy: {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    itemIds: string[];
    requestTimeoutMs: number;
  };
  sync: {
    times: SyncTime[];
    lookbackDays: number;
    initialLookbackDays: number;
    runOnStart: boolean;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Aceita NOME ou NOME_FILE (para usar Docker secrets no lugar de variáveis de ambiente).
export function readValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = readValue(env, name);
  if (!value) throw new Error(`Variável ${name} não definida (veja .env.example)`);
  return value;
}

function intValue(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = readValue(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} deve ser um inteiro entre ${min} e ${max} (recebido: ${raw})`);
  }
  return n;
}

export function parseSyncTimes(raw: string): SyncTime[] {
  const times = raw.split(',').map((part) => {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) throw new Error(`SYNC_TIMES inválido: "${part}" (use HH:MM separados por vírgula)`);
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) throw new Error(`SYNC_TIMES inválido: "${part}"`);
    return { hour, minute };
  });
  return times.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

export function parseItemIds(raw: string): string[] {
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('PLUGGY_ITEM_IDS vazio');
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`PLUGGY_ITEM_IDS contém um id inválido: "${id}"`);
  }
  return [...new Set(ids)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts = { requirePluggy: true }): Config {
  const pluggyValue = (name: string) => (opts.requirePluggy ? required(env, name) : (readValue(env, name) ?? ''));
  const itemIdsRaw = pluggyValue('PLUGGY_ITEM_IDS');

  return {
    timezone: readValue(env, 'APP_TIMEZONE') ?? 'America/Sao_Paulo',
    pluggy: {
      baseUrl: readValue(env, 'PLUGGY_BASE_URL') ?? 'https://api.pluggy.ai',
      clientId: pluggyValue('PLUGGY_CLIENT_ID'),
      clientSecret: pluggyValue('PLUGGY_CLIENT_SECRET'),
      itemIds: itemIdsRaw ? parseItemIds(itemIdsRaw) : [],
      requestTimeoutMs: intValue(env, 'PLUGGY_TIMEOUT_MS', 30_000, 1_000, 300_000),
    },
    sync: {
      times: parseSyncTimes(readValue(env, 'SYNC_TIMES') ?? '07:17,19:17'),
      lookbackDays: intValue(env, 'SYNC_LOOKBACK_DAYS', 120, 7, 400),
      initialLookbackDays: intValue(env, 'SYNC_INITIAL_LOOKBACK_DAYS', 365, 7, 400),
      runOnStart: (readValue(env, 'SYNC_ON_START') ?? 'true').toLowerCase() !== 'false',
    },
  };
}
