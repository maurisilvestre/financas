// Botão "Sincronizar": quando o sync pedido terminou e o que dizer no fim.
import type { StatusSync } from '../types.ts';

const TZ = 'America/Sao_Paulo';

/** Id do sync a esperar: o que já está rodando ou o próximo que começar. */
export function syncEsperado(s: StatusSync): number {
  if (!s.ultimo) return 1;
  return s.rodando ? s.ultimo.id : s.ultimo.id + 1;
}

/** O sync esperado começou e terminou (nada pendente nem rodando). */
export function terminou(esperado: number, s: StatusSync): boolean {
  return !s.pedido_pendente && !s.rodando && !!s.ultimo && s.ultimo.id >= esperado;
}

function quando(iso: string): string {
  const d = new Date(iso);
  const dia = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(d);
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${dia} às ${hora}`;
}

/** "Sincronizado: 3 movimentações novas." ou, sem nada novo, quando a Pluggy atualizou cada banco. */
export function mensagemSync(s: StatusSync): { texto: string; tipo: 'ok' | 'erro' } {
  const u = s.ultimo;
  if (!u) return { texto: 'Ainda não houve sync.', tipo: 'erro' };
  const erro = (u.erro ?? '').split('\n')[0];
  if (u.status === 'error') return { texto: `O sync falhou: ${erro}`, tipo: 'erro' };
  const novas = u.inseridas === 1 ? '1 movimentação nova' : `${u.inseridas} movimentações novas`;
  if (u.status === 'partial') return { texto: `Sincronizado em parte (${novas}): ${erro}`, tipo: 'erro' };
  if (u.inseridas > 0) return { texto: `Sincronizado: ${novas}.`, tipo: 'ok' };
  const bancos = s.bancos.filter((b) => b.atualizado_em).map((b) => `${b.conta} em ${quando(b.atualizado_em!)}`);
  return {
    texto: `Sincronizado, nada novo: a Pluggy ainda não buscou dados mais recentes nos bancos.${bancos.length ? ` Última atualização: ${bancos.join(', ')}.` : ''} Para buscar agora, atualize a conexão no site do Meu Pluggy e sincronize de novo.`,
    tipo: 'ok',
  };
}
