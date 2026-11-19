// Sugestões de categoria (feitas pela IA) na API do app: listar, aplicar, recusar e aplicar
// as de confiança alta. As sugestões são gravadas aqui direto no banco, como o classificador faria.
//
// Requer o Postgres descartável (ver sync.integration.test.ts) e TEST_PG_URL.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { startWebServer } from '../src/api/server.ts';
import { createSeededDb, type SeededDb } from './fixture-db.ts';

describe('sugestões da IA na API (integração)', { skip: process.env.TEST_PG_URL ? false : 'defina TEST_PG_URL para rodar' }, () => {
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
    seeded = await createSeededDb('fin_sug');
    await seeded.app.query(
      `INSERT INTO fin.category_suggestions (key, example, category_id, confidence, reason, model)
       SELECT s.key, s.example, c.id, s.confidence, s.reason, 'teste'
       FROM (VALUES ('academia smart fit', 'ACADEMIA SMART FIT', 'Saúde', 0.92, 'academia'),
                    ('geladeira eletrolar', 'GELADEIRA ELETROLAR 02/10', 'Casa e reforma', 0.95, 'eletrodoméstico'),
                    ('loja do ze', 'LOJA DO ZE', 'Compras', 0.50, 'loja genérica')) AS s(key, example, categoria, confidence, reason)
       JOIN fin.categories c ON c.name = s.categoria`);
    await seeded.app.query(
      `INSERT INTO fin.category_suggestions (key, example, category_id, confidence, reason, model)
       VALUES ('nao bate com nada', 'NAO BATE', NULL, 0.1, 'sem ideia', 'teste')`);
    server = await startWebServer({ pools: { read: seeded.read, write: seeded.write }, host: '127.0.0.1', port: 0, staticDir: null });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await seeded?.close();
  });

  test('GET /api/sugestoes: grupos com transações sem categoria, maior valor primeiro; sem as incertas', async () => {
    const { status, json } = await get('/api/sugestoes');
    assert.equal(status, 200);
    assert.deepEqual(json.grupos.map((g: { chave: string }) => g.chave), ['geladeira eletrolar', 'academia smart fit', 'loja do ze']);
    assert.deepEqual(json.grupos[0], {
      chave: 'geladeira eletrolar', exemplo: 'GELADEIRA ELETROLAR 02/10', categoria: 'Casa e reforma', cor: '#79740e',
      confianca: '0.95', motivo: 'eletrodoméstico', transacoes: 1, total: '-400.00', ultima: json.grupos[0].ultima,
      em_lote: true,
    });
    assert.deepEqual({ grupos: json.total_grupos, transacoes: json.total_transacoes }, { grupos: 3, transacoes: 3 });
  });

  test('POST /api/sugestoes/aplicar: categoriza as transações do grupo (pode trocar a categoria)', async () => {
    const r = await post('/api/sugestoes/aplicar', { chave: 'academia smart fit', categoria: 'Lazer' });
    assert.deepEqual(r, { status: 200, json: { ok: true, aplicadas: 1 } });
    const t = (await get('/api/transacoes?texto=smart%20fit')).json.transacoes[0];
    assert.deepEqual({ c: t.categoria, o: t.origem_categoria }, { c: 'Lazer', o: 'manual' });
    const grupos = (await get('/api/sugestoes')).json.grupos.map((g: { chave: string }) => g.chave);
    assert.ok(!grupos.includes('academia smart fit'));
  });

  test('POST /api/sugestoes/recusar: some da lista e não volta', async () => {
    assert.equal((await post('/api/sugestoes/recusar', { chave: 'loja do ze' })).status, 200);
    const grupos = (await get('/api/sugestoes')).json.grupos.map((g: { chave: string }) => g.chave);
    assert.deepEqual(grupos, ['geladeira eletrolar']);
    const { rows } = await seeded.app.query("SELECT status FROM fin.category_suggestions WHERE key = 'loja do ze'");
    assert.equal(rows[0].status, 'rejected');
  });

  test('POST /api/sugestoes/aplicar-confiaveis: aplica de uma vez as de confiança alta', async () => {
    // Duas sugestões de confiança alta que NÃO podem ir em lote: uma esconderia um gasto
    // como movimentação, e a outra chama de gasto uma entrada de dinheiro.
    await seeded.app.query(
      `INSERT INTO fin.transactions (pluggy_id, account_id, occurred_at, local_date, description, amount, signed_amount,
                                     currency_code, type, status, raw)
       SELECT gen_random_uuid(), a.id, now(), current_date - 1, d.descricao, abs(d.valor), d.valor, 'BRL',
              CASE WHEN d.valor < 0 THEN 'DEBIT' ELSE 'CREDIT' END, 'POSTED', '{}'::jsonb
       FROM fin.accounts a,
            (VALUES ('PIX ENVIADO LOJA SUSPEITA', -300.00), ('REEMBOLSO LOJA XYZ', 50.00)) AS d(descricao, valor)
       WHERE a.subtype = 'CHECKING_ACCOUNT'`);
    await seeded.app.query(
      `INSERT INTO fin.category_suggestions (key, example, category_id, confidence, reason, model)
       SELECT s.key, s.example, c.id, 0.99, 'teste', 'teste'
       FROM (VALUES ('pix enviado loja suspeita', 'PIX ENVIADO LOJA SUSPEITA', 'Transferência entre contas'),
                    ('reembolso loja xyz', 'REEMBOLSO LOJA XYZ', 'Mercado')) AS s(key, example, categoria)
       JOIN fin.categories c ON c.name = s.categoria`);
    const antes = (await get('/api/sugestoes')).json.grupos;
    assert.deepEqual(
      Object.fromEntries(antes.map((g: { chave: string; em_lote: boolean }) => [g.chave, g.em_lote])),
      { 'geladeira eletrolar': true, 'pix enviado loja suspeita': false, 'reembolso loja xyz': false });

    const r = await post('/api/sugestoes/aplicar-confiaveis', { minimo: 0.9 });
    assert.deepEqual(r.json, { ok: true, grupos: 1, transacoes: 1 });
    assert.equal((await get('/api/transacoes?texto=geladeira')).json.transacoes[0].categoria, 'Casa e reforma');
    assert.deepEqual((await get('/api/sugestoes')).json.grupos.map((g: { chave: string }) => g.chave).sort(),
      ['pix enviado loja suspeita', 'reembolso loja xyz'], 'ficam para confirmar uma a uma');
  });

  test('chave que não existe → 404', async () => {
    assert.equal((await post('/api/sugestoes/aplicar', { chave: 'nao existe', categoria: 'Mercado' })).status, 404);
    assert.equal((await post('/api/sugestoes/recusar', { chave: 'nao existe' })).status, 404);
  });

  test('papel fin_mcp: só muda o status da sugestão; não cria nem troca a categoria sugerida', async () => {
    const c = new pg.Client({ connectionString: seeded.urlFor('fin_mcp') });
    await c.connect();
    try {
      await assert.rejects(c.query("INSERT INTO fin.category_suggestions (key, example, confidence, model) VALUES ('x', 'x', 0.5, 'x')"), /permission denied/);
      await assert.rejects(c.query("UPDATE fin.category_suggestions SET category_id = NULL WHERE key = 'loja do ze'"), /permission denied/);
      await assert.rejects(c.query('DELETE FROM fin.category_suggestions'), /permission denied/);
    } finally {
      await c.end();
    }
  });
});
