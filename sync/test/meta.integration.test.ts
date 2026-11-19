// Meta mensal do cartão à vista, acompanhamento dia a dia e alerta de parcelamentos novos, pela API.
// Dados de test/fixture-db.ts mais compras inseridas aqui no mês corrente.
//
// Requer o Postgres descartável (ver sync.integration.test.ts) e TEST_PG_URL.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { startWebServer } from '../src/api/server.ts';
import { createSeededDb, mon, today, type SeededDb } from './fixture-db.ts';

describe('meta do cartão à vista e alerta de parcelamentos (integração)', { skip: process.env.TEST_PG_URL ? false : 'defina TEST_PG_URL para rodar' }, () => {
  let seeded: SeededDb;
  let server: Server;
  let base: string;

  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, json: (await r.json()) as any };
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  before(async () => {
    seeded = await createSeededDb('fin_meta');
    const q = (sql: string) => seeded.app.query(sql);
    // No mês corrente: duas compras à vista no cartão (entram), uma na conta e uma ignorada (não entram).
    await q(`INSERT INTO fin.transactions (pluggy_id, account_id, occurred_at, local_date, description, amount, signed_amount, currency_code, type, status, raw)
             SELECT gen_random_uuid(), a.id, now(), d.data, d.descricao, d.valor, -d.valor, 'BRL', 'DEBIT', 'POSTED', '{}'::jsonb
             FROM fin.accounts a, (VALUES
               (date_trunc('month', current_date)::date, 'CARTAO TESTE DIA 1', 'CREDIT_CARD', 100.00),
               (current_date, 'CARTAO TESTE HOJE', 'CREDIT_CARD', 100.00),
               (current_date, 'CONTA TESTE', 'CHECKING_ACCOUNT', 999.00),
               (current_date, 'CARTAO IGNORADO', 'CREDIT_CARD', 500.00)) AS d(data, descricao, subtipo, valor)
             WHERE a.subtype = d.subtipo`);
    await q(`INSERT INTO fin.transaction_overrides (transaction_id, ignored)
             SELECT id, true FROM fin.transactions WHERE description = 'CARTAO IGNORADO'`);
    // Parcelamentos: um comprado hoje (alerta) e um de 60 dias atrás com parcela neste mês (sem alerta).
    for (const [descricao, compra, numero] of [['TV NOVA', 'current_date', 1], ['TV ANTIGA', "current_date - 60", 3]] as const) {
      await q(`WITH g AS (
                 INSERT INTO fin.installment_groups (account_id, group_key, match_key, description, total_installments,
                                                     installment_amount, anchor_month, purchase_date)
                 SELECT id, '${descricao}', lower('${descricao}') || '|10', '${descricao}', 10, 300, date_trunc('month', ${compra})::date, ${compra}
                 FROM fin.accounts WHERE subtype = 'CREDIT_CARD' RETURNING id, account_id)
               INSERT INTO fin.transactions (pluggy_id, account_id, occurred_at, local_date, description, amount, signed_amount,
                                             currency_code, type, status, raw, installment_number, total_installments,
                                             purchase_date, installment_group_id)
               SELECT gen_random_uuid(), g.account_id, now(), current_date, '${descricao} ${numero}/10', 300, -300, 'BRL', 'DEBIT',
                      'POSTED', '{}'::jsonb, ${numero}, 10, ${compra}, g.id FROM g`);
    }
    server = await startWebServer({ pools: { read: seeded.read, write: seeded.write }, host: '127.0.0.1', port: 0, staticDir: null });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await seeded?.close();
  });

  test('meta: começa vazia, grava com 2 casas e recusa valor negativo', async () => {
    assert.deepEqual((await get('/api/meta')).json, { meta_cartao_avista: null });
    assert.equal((await post('/api/meta', { meta_cartao_avista: 7200 })).status, 200);
    assert.deepEqual((await get('/api/meta')).json, { meta_cartao_avista: '7200.00' });
    assert.equal((await post('/api/meta', { meta_cartao_avista: -1 })).status, 400);
  });

  test('acompanhamento do mês corrente: só cartão à vista, acumulado dia a dia, ritmo e projeção', async () => {
    const { status, json: a } = await get('/api/meta/acompanhamento');
    assert.equal(status, 200);
    const dia = Number(today.slice(8, 10));
    assert.deepEqual(
      { mes: a.mes, em_andamento: a.em_andamento, meta: a.meta, dia_atual: a.dia_atual, gasto: a.gasto, status: a.status },
      { mes: mon(0), em_andamento: true, meta: '7200.00', dia_atual: dia, gasto: '200.00', status: 'dentro' },
      'fora: compra na conta, compra ignorada e parcelas');
    assert.equal(a.por_dia.length, dia);
    assert.equal(a.por_dia[0].gasto, dia === 1 ? '200.00' : '100.00');
    assert.equal(a.por_dia.at(-1).acumulado, '200.00');
    assert.equal(a.ritmo_ideal, (Math.round((7200 * dia / a.dias_no_mes) * 100) / 100).toFixed(2));
    assert.equal(a.projecao, (Math.round((200 / dia * a.dias_no_mes) * 100) / 100).toFixed(2));
    assert.equal(a.mes_anterior.mes, mon(1));
  });

  test('passou da meta → estourou', async () => {
    await post('/api/meta', { meta_cartao_avista: 150 });
    assert.equal((await get('/api/meta/acompanhamento')).json.status, 'estourou');
    await post('/api/meta', { meta_cartao_avista: 7200 });
  });

  test('mês fechado: dia atual = último dia; projeção = gasto; série completa', async () => {
    const { json: a } = await get(`/api/meta/acompanhamento?mes=${mon(1)}`);
    // No mês passado do fixture: Netflix (55,90) e academia (129,90) no cartão, à vista.
    assert.deepEqual({ em: a.em_andamento, dia: a.dia_atual, gasto: a.gasto, proj: a.projecao },
      { em: false, dia: a.dias_no_mes, gasto: a.gasto, proj: a.gasto });
    assert.ok(Number(a.gasto) >= 185.8, a.gasto);
    assert.equal(a.por_dia.length, a.dias_no_mes);
  });

  test('mês futuro → 400', async () => {
    assert.equal((await get(`/api/meta/acompanhamento?mes=${mon(-1)}`)).status, 400);
  });

  test('alerta: parcelamentos comprados nos últimos 30 dias (os antigos não)', async () => {
    const { json } = await get('/api/parcelamentos/novos');
    const compras = json.novos.map((n: { compra: string }) => n.compra);
    assert.ok(compras.includes('TV NOVA'), JSON.stringify(compras));
    assert.ok(!compras.includes('TV ANTIGA'));
    const tv = json.novos.find((n: { compra: string }) => n.compra === 'TV NOVA');
    assert.deepEqual({ parcelas: tv.parcelas, valor: tv.valor_parcela, total: tv.total, data: tv.data_compra },
      { parcelas: 10, valor: '300.00', total: '3000.00', data: today });
  });
});
