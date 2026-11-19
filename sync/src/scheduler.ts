import { setTimeout as sleep } from 'node:timers/promises';
import type { SyncTime } from './config.ts';

/** Horário de parede (h, m, s) agora no fuso informado. */
function wallClock(now: Date, tz: string): { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: get('hour'), minute: get('minute'), second: get('second') };
}

/**
 * Milissegundos até o próximo horário de SYNC_TIMES no fuso local.
 * (O Brasil não tem horário de verão desde 2019; se voltar, o erro é de no máximo 1 h num dia.)
 */
export function msUntilNext(times: SyncTime[], now = new Date(), tz = 'America/Sao_Paulo'): number {
  const { hour, minute, second } = wallClock(now, tz);
  const nowSec = hour * 3600 + minute * 60 + second;
  const slots = times.map((t) => t.hour * 3600 + t.minute * 60).sort((a, b) => a - b);
  const next = slots.find((s) => s > nowSec) ?? (slots[0]! + 86_400);
  return (next - nowSec) * 1000 - now.getMilliseconds();
}

/**
 * Espera até o próximo sync marcado (`ms`), conferindo a cada `intervalo` se o app pediu um
 * ("Sincronizar"). Devolve 'app' se houve pedido, 'schedule' no horário e null se o daemon foi
 * encerrado. Uma checagem que falha (banco fora do ar) conta como "sem pedido".
 */
export async function esperarProximo(
  ms: number, temPedido: () => Promise<boolean>, signal: AbortSignal, intervalo = 10_000,
): Promise<'schedule' | 'app' | null> {
  const fim = Date.now() + ms;
  for (;;) {
    const resta = fim - Date.now();
    if (resta <= 0) return 'schedule';
    try {
      await sleep(Math.min(intervalo, resta), undefined, { signal });
    } catch {
      return null;
    }
    if (await temPedido().catch(() => false)) return 'app';
  }
}
