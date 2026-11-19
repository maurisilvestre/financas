// Log em uma linha por evento. Nunca registre segredos nem payloads completos.
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
const MIN = ORDER[configured] ?? ORDER.info;
let allToStderr = false;

/** Manda todo o log para o stderr. Usado pelo MCP, em que o stdout é só do protocolo. */
export function logToStderr(): void {
  allToStderr = true;
}

function write(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (ORDER[level] < MIN) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (extra && Object.keys(extra).length > 0) line += ` ${JSON.stringify(extra)}`;
  (allToStderr || level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => write('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};

/** Só o começo do id: logs e saídas nunca mostram ids completos. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
