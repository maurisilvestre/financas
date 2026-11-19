// API do app web contra um Postgres de verdade (dados de test/fixture-db.ts), por HTTP.
// Cobre as rotas, as consultas novas (visão do mês, prévia de regra, ignorar, paginação)
// e as proteções de uma API local sem login: Host, Origin, Content-Type, tamanho do corpo
// e arquivos estáticos sem path traversal.
//
// Requer o Postgres descartável (ver sync.integration.test.ts) e TEST_PG_URL.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startWebServer } from '../src/api/server.ts';
import { createSeededDb, mon, type SeededDb } from './fixture-db.ts';

interface Res { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }

describe('API web (integração)', { skip: process.env.TEST_PG_URL ? false : 'defina TEST_PG_URL para rodar' }, () => {
  let seeded: SeededDb;
  let server: Server;
  let port: number;

  // Pedido HTTP cru, para poder mandar Host/Origin arbitrários (fetch não deixa trocar o Host).
  const http = (method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { text += c; });
        res.on('end', () => {
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  const get = (path: string) => http('GET', path);
  const origin = () => `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    http('POST', path, { body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: origin(), ...headers } });
  const ok = async (p: Promise<Res>) => {
    const r = await p;
    assert.equal(r.status, 200, `${r.status}: ${r.text}`);
    return r.json;
  };
  const idOf = async (texto: string) => (await ok(get(`/api/transacoes?texto=${encodeURIComponent(texto)}`))).transacoes[0].id as number;

  before(async () => {
    seeded = await createSeededDb('fin_api');
    const staticDir = mkdtempSync(join(tmpdir(), 'fin-web-'));
    mkdirSync(join(staticDir, 'assets'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Finanças</title><div id="app"></div>');
    writeFileSync(join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1)');
    server = await startWebServer({ pools: { read: seeded.read, write: seeded.write }, host: '127.0.0.1', port: 0, staticDir });
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await seeded?.close();
  });

  // --- leitura -------------------------------------------------------------

  test('GET /api/visao: resumo do mês, mês anterior, média e categorias com cor e média', async () => {
    const v = await ok(get(`/api/visao?mes=${mon(2)}`));
    assert.equal(v.mes, mon(2));
    assert.equal(v.em_andamento, false);
    assert.deepEqual(v.resumo, { mes: mon(2), gastos: '1255.90', receitas: '8000.00', saldo: '6744.10', sem_categoria: 0 });
    assert.deepEqual(v.anterior, { mes: mon(3), gastos: '1255.90', receitas: '0.00', saldo: '-1255.90', sem_categoria: 0 });
    // Só o mês 3 tem dados entre os 3 anteriores: a média é dele.
    assert.deepEqual(v.media_3m, { meses: 1, gastos: '1255.90', receitas: '0.00' });
    const saude = v.categorias.find((c: { categoria: string }) => c.categoria === 'Saúde');
    assert.deepEqual(saude, { categoria: 'Saúde', cor: '#cc241d', total: '1200.00', media_3m: '1200.00' });
    assert.equal(v.parcelas_proximos_meses.length, 3);
    assert.ok(v.parcelas_proximos_meses.every((p: { comprometido: string }) => p.comprometido === '400.00'), JSON.stringify(v.parcelas_proximos_meses));
  });

  // --- cartão × conta (quase todo gasto é no cartão; no débito ficam as contas fixas) ---

  test('GET /api/resumo separa gastos no cartão e na conta', async () => {
    const { meses } = await ok(get('/api/resumo?meses=4'));
    const m2 = meses.find((m: { mes: string }) => m.mes === mon(2));
    assert.deepEqual({ cartao: m2.gastos_cartao, conta: m2.gastos_conta, total: m2.gastos }, { cartao: '55.90', conta: '1200.00', total: '1255.90' });
  });

  test('GET /api/visao: total no cartão e na conta, cada cartão, com média', async () => {
    const v = await ok(get(`/api/visao?mes=${mon(2)}`));
    assert.deepEqual(v.por_origem, {
      cartao: { gastos: '55.90', media_3m: '55.90' },
      conta: { gastos: '1200.00', media_3m: '1200.00' },
    });
    assert.deepEqual(v.cartoes, [{ conta: 'CARTAO TESTE', gastos: '55.90', media_3m: '55.90' }]);
  });

  test('GET /api/visao?origem=: categorias só do cartão ou só da conta', async () => {
    const cartao = await ok(get(`/api/visao?mes=${mon(2)}&origem=cartao`));
    assert.deepEqual(cartao.categorias.map((c: { categoria: string }) => c.categoria), ['Assinaturas']);
    const conta = await ok(get(`/api/visao?mes=${mon(2)}&origem=conta`));
    assert.deepEqual(conta.categorias.map((c: { categoria: string }) => c.categoria), ['Saúde']);
    assert.equal((await get(`/api/visao?origem=poupanca`)).status, 400);
  });

  test('GET /api/transacoes?origem=: só cartões ou só contas', async () => {
    assert.equal((await ok(get('/api/transacoes?texto=netflix&origem=cartao'))).encontradas, 3);
    assert.equal((await ok(get('/api/transacoes?texto=netflix&origem=conta'))).encontradas, 0);
  });

  test('GET /api/visao sem mês: mês atual, em andamento', async () => {
    const v = await ok(get('/api/visao'));
    assert.deepEqual({ mes: v.mes, em_andamento: v.em_andamento }, { mes: mon(0), em_andamento: true });
  });

  test('GET /api/transacoes: filtros, total do filtro inteiro e paginação por offset', async () => {
    const page2 = await ok(get('/api/transacoes?texto=netflix&limite=2&offset=2'));
    assert.deepEqual({ encontradas: page2.encontradas, soma: page2.soma, mostrando: page2.mostrando }, { encontradas: 3, soma: '-167.70', mostrando: 1 });
    const beyond = await ok(get('/api/transacoes?texto=netflix&offset=50'));
    assert.deepEqual({ encontradas: beyond.encontradas, mostrando: beyond.mostrando }, { encontradas: 3, mostrando: 0 });
  });

  test('GET /api/transacoes: parâmetro inválido → 400 com mensagem', async () => {
    const r = await get('/api/transacoes?limite=abc');
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /limite/);
  });

  test('GET /api/categorias traz a cor; resumo, recorrentes, compromissos e contas respondem', async () => {
    const { categorias } = await ok(get('/api/categorias'));
    assert.equal(categorias.find((c: { nome: string }) => c.nome === 'Mercado').cor, '#689d6a');
    assert.ok((await ok(get('/api/resumo?meses=3'))).meses.length > 0);
    assert.ok((await ok(get('/api/recorrentes'))).recorrentes.length > 0);
    assert.ok((await ok(get('/api/compromissos'))).parcelamentos.length > 0);
    assert.equal((await ok(get('/api/contas'))).contas.length, 2);
  });

  test('GET /api/regras/previa: quantas transações a regra pegaria, com exemplos, sem gravar', async () => {
    const p = await ok(get('/api/regras/previa?padrao=smart%20fit'));
    assert.deepEqual(p, { padrao: 'smart fit', casam: 1, exemplos: [{ descricao: 'ACADEMIA SMART FIT', categoria: null, n: 1 }] });
  });

  // --- escrita -------------------------------------------------------------

  test('POST /api/transacoes/:id/categoria grava o override', async () => {
    const id = await idOf('loja do ze');
    const r = await ok(post(`/api/transacoes/${id}/categoria`, { categoria: 'Casa e reforma', nota: 'tinta' }));
    assert.deepEqual({ c: r.transacao.categoria, o: r.transacao.origem_categoria, n: r.transacao.nota }, { c: 'Casa e reforma', o: 'manual', n: 'tinta' });
  });

  test('POST categoria de transação inexistente → 404', async () => {
    const r = await post('/api/transacoes/99999999/categoria', { categoria: 'Mercado' });
    assert.equal(r.status, 404);
    assert.match(r.json.erro, /não encontrada/);
  });

  test('POST /api/transacoes/:id/ignorar tira dos relatórios e dá para desfazer', async () => {
    const id = await idOf('academia smart');
    assert.deepEqual((await ok(post(`/api/transacoes/${id}/ignorar`, { ignorar: true }))).transacao, { id, ignorada: true });
    assert.equal((await ok(get('/api/transacoes?texto=academia%20smart'))).encontradas, 0);
    const withIgnored = await ok(get('/api/transacoes?texto=academia%20smart&incluir_ignoradas=true'));
    assert.equal(withIgnored.transacoes[0].ignorada, true);
    await ok(post(`/api/transacoes/${id}/ignorar`, { ignorar: false }));
    assert.equal((await ok(get('/api/transacoes?texto=academia%20smart'))).encontradas, 1);
  });

  test('POST /api/regras cria a regra e responde quantas pegou', async () => {
    const r = await ok(post('/api/regras', { categoria: 'Saúde', padrao: 'smart fit' }));
    assert.equal(r.casam, 1);
    assert.equal((await ok(get('/api/transacoes?texto=smart%20fit'))).transacoes[0].categoria, 'Saúde');
  });

  // --- proteções -----------------------------------------------------------

  test('atrás do tailscale serve: aceita o nome configurado com Origin https (com a porta); o resto continua recusado', async () => {
    const proxied = await startWebServer({
      pools: { read: seeded.read, write: seeded.write }, host: '127.0.0.1', port: 0, staticDir: null,
      proxyHostnames: ['servidor.tail0000.ts.net'],
    });
    const p2 = (proxied.address() as AddressInfo).port;
    const raw = (method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: p2, method, path, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
      });
    const tail = 'servidor.tail0000.ts.net:8443';
    // Escrita inofensiva para os outros testes: o pedido de sync (repetido, só diz que já foi pedido).
    const escrever = (host: string, origem: string) => raw('POST', '/api/sync', { host, origin: origem, 'content-type': 'application/json' }, '{}');
    try {
      assert.equal(await raw('GET', '/api/contas', { host: tail }), 200);
      assert.equal(await raw('GET', '/api/contas', { host: 'outro.tail0000.ts.net:8443' }), 403);
      assert.equal(await escrever(tail, `https://${tail}`), 200);
      assert.equal(await escrever(tail, `http://${tail}`), 403, 'atrás do proxy, só https');
      assert.equal(await escrever(tail, 'https://servidor.tail0000.ts.net'), 403, 'a porta faz parte da origem');
      assert.equal(await escrever(tail, 'https://evil.example'), 403);
      assert.equal(await escrever(`127.0.0.1:${p2}`, `http://127.0.0.1:${p2}`), 200, 'local continua igual');
      assert.equal(await escrever(`127.0.0.1:${p2}`, `https://127.0.0.1:${p2}`), 403);
    } finally {
      await new Promise((r) => proxied.close(r));
    }
  });

  test('Host diferente de 127.0.0.1/localhost → 403 (DNS rebinding)', async () => {
    const r = await http('GET', '/api/contas', { headers: { host: 'evil.example:8080' } });
    assert.equal(r.status, 403);
  });

  test('POST de outra origem, sem Origin ou sem JSON → recusado', async () => {
    const id = await idOf('netflix');
    assert.equal((await post(`/api/transacoes/${id}/categoria`, { categoria: 'Lazer' }, { origin: 'http://evil.example' })).status, 403);
    const noOrigin = await http('POST', `/api/transacoes/${id}/categoria`, { body: '{"categoria":"Lazer"}', headers: { 'content-type': 'application/json' } });
    assert.equal(noOrigin.status, 403);
    const form = await http('POST', `/api/transacoes/${id}/categoria`, { body: 'categoria=Lazer', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: origin() } });
    assert.equal(form.status, 415);
    assert.equal((await ok(get('/api/transacoes?texto=netflix'))).transacoes[0].categoria, 'Assinaturas', 'nada foi gravado');
  });

  test('corpo grande demais → 413; JSON inválido → 400; OPTIONS (preflight) → 405', async () => {
    const big = await http('POST', '/api/regras', { body: `{"padrao":"${'x'.repeat(70_000)}"}`, headers: { 'content-type': 'application/json', origin: origin() } });
    assert.equal(big.status, 413);
    const bad = await http('POST', '/api/regras', { body: '{nao é json', headers: { 'content-type': 'application/json', origin: origin() } });
    assert.equal(bad.status, 400);
    assert.equal((await http('OPTIONS', '/api/regras', { headers: { origin: 'http://evil.example' } })).status, 405);
  });

  test('rota desconhecida → 404 JSON; método errado → 405', async () => {
    assert.equal((await get('/api/nao-existe')).status, 404);
    assert.equal((await http('DELETE', '/api/regras', { headers: { origin: origin() } })).status, 405);
  });

  test('respostas da API: sem cache e nosniff', async () => {
    const r = await get('/api/contas');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(String(r.headers['content-type']), /application\/json/);
  });

  // --- front estático ------------------------------------------------------

  test('GET / serve o index.html com CSP; assets com tipo e cache longo', async () => {
    const index = await get('/');
    assert.equal(index.status, 200);
    assert.match(index.text, /Finanças/);
    assert.match(String(index.headers['content-security-policy']), /default-src 'self'/);
    assert.match(String(index.headers['content-security-policy']), /frame-ancestors 'none'/);
    const asset = await get('/assets/app-abc123.js');
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    assert.match(String(asset.headers['cache-control']), /immutable/);
  });

  test('arquivos fora da pasta do front não são servidos (path traversal)', async () => {
    for (const path of ['/../package.json', '/assets/../../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
      const r = await get(path);
      assert.equal(r.status, 404, path);
    }
  });
});
