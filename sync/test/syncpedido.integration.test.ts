// Botão "Sincronizar" do app: o app só registra o pedido (não tem as credenciais da Pluggy); o
// daemon do sync confere os pedidos e roda. Aqui: o status, o pedido pela API, a deduplicação e
// a checagem que o daemon usa.
//
// Requer o Postgres descartável (ver sync.integration.test.ts) e TEST_PG_URL.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { startWebServer } from '../src/api/server.ts';
import { pedidoDeSync } from '../src/pedido.ts';
import { createSeededDb, type SeededDb } from './fixture-db.ts';

describe('botão de sincronizar (integração)', { skip: process.env.TEST_PG_URL ? false : 'defina TEST_PG_URL para rodar' }, () => {
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
    seeded = await createSeededDb('fin_syncpedido');
    // O sync do fixture "rodou" há 5 minutos (fora da trava de sync recente).
    await seeded.app.query(`UPDATE fin.sync_runs SET started_at = started_at - interval '5 minutes', finished_at = finished_at - interval '5 minutes'`);
    server = await startWebServer({ pools: { read: seeded.read, write: seeded.write }, host: '127.0.0.1', port: 0, staticDir: null });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await seeded?.close();
  });

  test('status: o último sync, se há pedido ou sync rodando e quando a Pluggy atualizou cada banco', async () => {
    const { status, json: s } = await get('/api/sync');
    assert.equal(status, 200);
    assert.equal(s.ultimo.status, 'success');
    assert.equal(s.ultimo.inseridas, 11);
    assert.ok(s.ultimo.terminado_em);
    assert.equal(s.pedido_pendente, false);
    assert.equal(s.rodando, false);
    assert.deepEqual(s.bancos.map((b: any) => b.conta), ['Conta Corrente']);
    assert.ok(s.bancos[0].atualizado_em);
  });

  test('pedir: registra uma vez; o daemon vê o pedido até um sync começar; sync rodando ou recente não pede de novo', async () => {
    let r = await post('/api/sync', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, pedido: true });
    assert.equal((await get('/api/sync')).json.pedido_pendente, true);
    assert.equal(await pedidoDeSync(seeded.app), true);

    r = await post('/api/sync', {});
    assert.deepEqual(r.json, { ok: true, pedido: false, motivo: 'ja_pedido' });
    assert.equal((await seeded.app.query('SELECT count(*)::int AS n FROM fin.sync_requests')).rows[0].n, 1);

    // O daemon começa um sync: o pedido foi atendido.
    await seeded.app.query(`INSERT INTO fin.sync_runs (trigger) VALUES ('app')`);
    assert.equal(await pedidoDeSync(seeded.app), false);
    let s = (await get('/api/sync')).json;
    assert.deepEqual([s.pedido_pendente, s.rodando, s.ultimo.trigger], [false, true, 'app']);
    assert.deepEqual((await post('/api/sync', {})).json, { ok: true, pedido: false, motivo: 'rodando' });

    await seeded.app.query(`UPDATE fin.sync_runs SET status = 'success', finished_at = now() WHERE trigger = 'app'`);
    s = (await get('/api/sync')).json;
    assert.equal(s.rodando, false);
    assert.deepEqual((await post('/api/sync', {})).json, { ok: true, pedido: false, motivo: 'recente' }, 'acabou de sincronizar');
  });

  test('fin_mcp só registra pedidos; fin_readonly não escreve', async () => {
    await assert.rejects(seeded.write.query('DELETE FROM fin.sync_requests'), /permission denied/);
    await assert.rejects(seeded.write.query('UPDATE fin.sync_requests SET requested_at = now()'), /permission denied/);
    await assert.rejects(seeded.write.query(`INSERT INTO fin.sync_runs (trigger) VALUES ('x')`), /permission denied/);
    await assert.rejects(seeded.read.query('INSERT INTO fin.sync_requests DEFAULT VALUES'), /read-only|permission denied/);
  });
});
