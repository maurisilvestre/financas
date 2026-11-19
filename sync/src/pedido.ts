// Pedido de sync feito pelo app (botão "Sincronizar"). O app não tem as credenciais da Pluggy: só
// registra o pedido em fin.sync_requests; o daemon confere aqui e roda. Um pedido está pendente
// enquanto nenhum sync começou depois dele, então o sync nunca precisa escrever na tabela.
import type { Db } from './db.ts';

export async function pedidoDeSync(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ pendente: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM fin.sync_requests r
       WHERE r.requested_at > coalesce((SELECT max(started_at) FROM fin.sync_runs), '-infinity'::timestamptz)
     ) AS pendente`);
  return rows[0]!.pendente;
}
