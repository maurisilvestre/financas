// Ferramentas do MCP contra um Postgres de verdade, com dados vindos de um sync (Pluggy simulada).
// Leitura com fin_readonly, escrita com fin_mcp, como no container. Dados: test/fixture-db.ts.
//
// Requer o Postgres descartável (ver sync.integration.test.ts) e TEST_PG_URL.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import type { Db } from '../src/db.ts';
import { createMcpHandler } from '../src/mcp/protocol.ts';
import { buildServer } from '../src/mcp/tools.ts';
import { createSeededDb, mon, type SeededDb } from './fixture-db.ts';

describe('MCP (integração)', { skip: process.env.TEST_PG_URL ? false : 'defina TEST_PG_URL para rodar' }, () => {
  let seeded: SeededDb;
  let app: Db;
  let urlFor: (user: string) => string;
  let handle: ReturnType<typeof createMcpHandler>;

  // Resultado de tools/call: o JSON que a ferramenta devolveu, ou o texto do erro.
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as any;
    assert.ok(res.result, JSON.stringify(res));
    const text = res.result.content[0].text as string;
    return res.result.isError ? { erro: text } : JSON.parse(text);
  };
  const ok = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const r = await call(name, args);
    assert.equal(r.erro, undefined, `${name} falhou: ${r.erro}`);
    return r;
  };

  before(async () => {
    seeded = await createSeededDb('fin_mcp');
    ({ app, urlFor } = seeded);
    handle = createMcpHandler(buildServer({ read: seeded.read, write: seeded.write }));
  });

  after(async () => {
    await seeded?.close();
  });

  test('anuncia as ferramentas de leitura e as de escrita da camada do usuário', async () => {
    const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as any;
    const names = res.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, [
      'a_pagar', 'atualizar_objetivo', 'atualizar_planejado', 'buscar_transacoes', 'categorias', 'compromissos_futuros', 'contas',
      'criar_objetivo', 'criar_regra', 'definir_categoria', 'excluir_da_previsao', 'faturas', 'gastos_por_categoria',
      'gastos_recorrentes', 'planejar_gasto', 'previsao', 'remover_exclusao_da_previsao', 'resumo_mensal',
    ]);
    const writes = res.result.tools.filter((t: { annotations?: { readOnlyHint?: boolean } }) => t.annotations?.readOnlyHint === false);
    assert.deepEqual(writes.map((t: { name: string }) => t.name).sort(), [
      'atualizar_objetivo', 'atualizar_planejado', 'criar_objetivo', 'criar_regra', 'definir_categoria', 'excluir_da_previsao',
      'planejar_gasto', 'remover_exclusao_da_previsao',
    ]);
  });

  test('guardião: previsao simula a compra; planejar_gasto faz a próxima previsão contar com ela', async () => {
    const sim = await ok('previsao', { valor: 300, descricao: 'Cadeira', reserva: 50000, margem: 0 });
    assert.equal(sim.compra.descricao, 'Cadeira');
    assert.equal(sim.compra.veredito, 'cabe');
    assert.equal(sim.meses[0].compra, '300.00');
    const { id } = await ok('planejar_gasto', { descricao: 'Cadeira', motivo: 'escritório', valor: 300, mes: sim.meses[1].mes });
    const depois = await ok('previsao');
    assert.equal(depois.meses[1].planejados, '300.00');
    assert.deepEqual(depois.planejados.map((x: { id: number }) => x.id), [id]);
    await ok('atualizar_planejado', { id, status: 'cancelado' });
    assert.equal((await ok('previsao')).meses[1].planejados, '0.00');
    assert.match((await call('previsao', { valor: 10, mes: '2099-01' })).erro, /fora da previsão/);
  });

  test('objetivos: criar_objetivo entra na previsão; atualizar_objetivo muda o aporte e conclui', async () => {
    const mes = (await ok('previsao')).meses[1].mes;
    const { id } = await ok('criar_objetivo', { nome: 'Viagem de férias', valor: 900, por_mes: 300, inicio: mes });
    let p = await ok('previsao');
    assert.equal(p.meses[1].guardar, '300.00');
    assert.equal(p.objetivos[0].nome, 'Viagem de férias');
    await ok('atualizar_objetivo', { id, por_mes: 900 });
    p = await ok('previsao');
    assert.deepEqual([p.meses[1].guardar, p.meses[2].guardar], ['900.00', '0.00']);
    await ok('atualizar_objetivo', { id, status: 'concluido' });
    assert.deepEqual((await ok('previsao')).objetivos, []);
  });

  test('initialize traz instruções para interpretar os dados', async () => {
    const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })) as any;
    assert.equal(res.result.serverInfo.name, 'financas');
    assert.match(res.result.instructions, /transfer/);
  });

  test('resumo_mensal: gastos, receitas e saldo por mês, sem meses futuros', async () => {
    const { meses } = await ok('resumo_mensal');
    const m2 = meses.find((m: { mes: string }) => m.mes === mon(2));
    assert.deepEqual(m2, {
      mes: mon(2), gastos: '1255.90', gastos_cartao: '55.90', gastos_conta: '1200.00',
      receitas: '8000.00', saldo: '6744.10', sem_categoria: 0, em_andamento: false,
    });
    assert.ok(meses.every((m: { mes: string }) => m.mes <= mon(0)));
  });

  test('buscar_transacoes: por texto, com total e soma do filtro inteiro', async () => {
    const r = await ok('buscar_transacoes', { texto: 'netflix', limite: 2 });
    assert.deepEqual({ encontradas: r.encontradas, soma: r.soma, mostrando: r.mostrando }, { encontradas: 3, soma: '-167.70', mostrando: 2 });
    assert.deepEqual(Object.keys(r.transacoes[0]).sort(), ['categoria', 'conta', 'data', 'descricao', 'fluxo', 'id', 'ignorada', 'nota', 'origem_categoria', 'parcela', 'status', 'valor']);
    assert.equal(r.transacoes[0].categoria, 'Assinaturas');
  });

  test('buscar_transacoes: só as sem categoria', async () => {
    const r = await ok('buscar_transacoes', { sem_categoria: true });
    const descs = r.transacoes.map((t: { descricao: string }) => t.descricao).sort();
    assert.deepEqual(descs, ['ACADEMIA SMART FIT', 'GELADEIRA ELETROLAR 02/10', 'LOJA DO ZE']);
  });

  test('gastos_por_categoria: total e média mensal no período', async () => {
    const r = await ok('gastos_por_categoria', { de: mon(3), ate: mon(1) });
    assert.equal(r.meses, 3);
    const byName = Object.fromEntries(r.categorias.map((c: { categoria: string }) => [c.categoria, c]));
    assert.deepEqual(byName['Saúde'], { categoria: 'Saúde', total: '3600.00', transacoes: 3, media_mensal: '1200.00' });
    assert.equal(byName['Assinaturas'].total, '167.70');
  });

  test('gastos_por_categoria: só cartão ou só conta', async () => {
    const nomes = async (origem: string) => (await ok('gastos_por_categoria', { de: mon(3), ate: mon(2), origem }))
      .categorias.map((c: { categoria: string }) => c.categoria);
    assert.deepEqual(await nomes('cartao'), ['Assinaturas']);
    assert.deepEqual(await nomes('conta'), ['Saúde']);
  });

  test('gastos_recorrentes: acha assinaturas e contas fixas, ignora parcelas e gastos avulsos', async () => {
    const r = await ok('gastos_recorrentes');
    const descs = r.recorrentes.map((x: { descricao: string }) => x.descricao);
    assert.ok(descs.includes('NETFLIX.COM'), JSON.stringify(descs));
    assert.ok(descs.includes('Pagamento efetuado|CLINICA VIDA'));
    assert.ok(!descs.some((d: string) => /GELADEIRA|LOJA DO ZE/.test(d)));
    const netflix = r.recorrentes.find((x: { descricao: string }) => x.descricao === 'NETFLIX.COM');
    assert.deepEqual({ meses: netflix.meses, valor_medio: netflix.valor_medio }, { meses: 3, valor_medio: '55.90' });
  });

  test('compromissos_futuros: parcelamentos em aberto e quanto pesa por mês', async () => {
    const r = await ok('compromissos_futuros');
    const geladeira = r.parcelamentos.find((p: { compra: string }) => p.compra === 'GELADEIRA ELETROLAR');
    assert.ok(geladeira, JSON.stringify(r.parcelamentos));
    assert.equal(geladeira.parcelas_total, 10);
    assert.ok(geladeira.parcelas_restantes >= 8);
    assert.ok(r.por_mes.length > 0 && r.por_mes.every((m: { mes: string }) => m.mes >= mon(0)));
  });

  test('contas e categorias', async () => {
    const { contas } = await ok('contas');
    assert.deepEqual(contas.map((c: { nome: string }) => c.nome).sort(), ['CARTAO TESTE', 'Conta Corrente']);
    const { categorias } = await ok('categorias');
    const saude = categorias.find((c: { nome: string }) => c.nome === 'Saúde');
    assert.ok(saude.regras.some((r: { padrao: string }) => r.padrao.includes('unimed')));
    assert.ok(Array.isArray((await ok('faturas')).faturas));
  });

  test('definir_categoria: grava o override (nome sem acento serve) e mantém a nota se não vier outra', async () => {
    const loja = (await ok('buscar_transacoes', { texto: 'loja do ze' })).transacoes[0];
    const r = await ok('definir_categoria', { transacao_id: loja.id, categoria: 'casa e reforma', nota: 'tinta' });
    assert.deepEqual(
      { categoria: r.transacao.categoria, origem: r.transacao.origem_categoria, nota: r.transacao.nota },
      { categoria: 'Casa e reforma', origem: 'manual', nota: 'tinta' });
    const again = await ok('definir_categoria', { transacao_id: loja.id, categoria: 'Compras' });
    assert.deepEqual({ categoria: again.transacao.categoria, nota: again.transacao.nota }, { categoria: 'Compras', nota: 'tinta' });
  });

  test('definir_categoria: categoria ou transação inexistente → erro claro', async () => {
    const loja = (await ok('buscar_transacoes', { texto: 'loja do ze' })).transacoes[0];
    const badCat = await call('definir_categoria', { transacao_id: loja.id, categoria: 'Inexistente' });
    assert.match(badCat.erro, /não existe/);
    assert.match(badCat.erro, /Mercado/);
    const badTx = await call('definir_categoria', { transacao_id: 99_999_999, categoria: 'Mercado' });
    assert.match(badTx.erro, /não encontrada/);
  });

  test('criar_regra: grava, recategoriza o histórico e diz quantas transações pegou', async () => {
    const r = await ok('criar_regra', { categoria: 'Saúde', padrao: 'smart fit' });
    assert.deepEqual({ casam: r.casam, antes: r.ja_nessa_categoria_antes, agora: r.nessa_categoria_agora }, { casam: 1, antes: 0, agora: 1 });
    const smart = (await ok('buscar_transacoes', { texto: 'smart fit' })).transacoes[0];
    assert.deepEqual({ c: smart.categoria, o: smart.origem_categoria }, { c: 'Saúde', o: 'rule' });
  });

  test('criar_regra: só "contém" (regex pelo MCP poderia travar a view para todos); padrão curto → erro; nada gravado', async () => {
    const before = await app.query('SELECT count(*)::int AS n FROM fin.category_rules');
    assert.match((await call('criar_regra', { categoria: 'Saúde', tipo: 'regex', padrao: '(a+)+$' })).erro, /tipo/);
    assert.match((await call('criar_regra', { categoria: 'Saúde', padrao: 'ab' })).erro, /padrao/);
    const afterCount = await app.query('SELECT count(*)::int AS n FROM fin.category_rules');
    assert.equal(afterCount.rows[0].n, before.rows[0].n);
  });

  test('papel fin_mcp: escreve só overrides e regras; não lê nem altera o resto', async () => {
    const c = new pg.Client({ connectionString: urlFor('fin_mcp') });
    await c.connect();
    try {
      await assert.rejects(c.query("UPDATE fin.transactions SET description = 'x'"), /permission denied/);
      await assert.rejects(c.query('SELECT raw FROM fin.transactions LIMIT 1'), /permission denied/);
      await assert.rejects(c.query("INSERT INTO fin.categories (name, kind) VALUES ('x', 'expense')"), /permission denied/);
      await assert.rejects(c.query('DELETE FROM fin.transaction_overrides'), /permission denied/);
      await assert.rejects(c.query('DELETE FROM fin.category_rules'), /permission denied/);
    } finally {
      await c.end();
    }
  });

  test('prompt do guardião: leva o que, o valor e o porquê e manda usar a previsão', async () => {
    const got = (await handle({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'posso_comprar', arguments: { o_que: 'Geladeira', valor: 'R$ 4.000', motivo: 'a velha quebrou' } } })) as any;
    const text = got.result.messages[0].content.text as string;
    for (const trecho of [/Geladeira/, /R\$ 4\.000/, /a velha quebrou/, /previsao/, /planejar_gasto/, /cortaveis/, /equivale/]) assert.match(text, trecho);
    assert.doesNotMatch(text, /urgente/, 'parcelar coisa da casa não é mais só em urgência');
  });

  test('prompt de equilibrar: objetivos, saldo positivo e o dia a dia', async () => {
    const got = (await handle({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'equilibrar_objetivos', arguments: {} } })) as any;
    const text = got.result.messages[0].content.text as string;
    for (const trecho of [/previsao/, /aporte_maximo/, /criar_objetivo/, /atualizar_objetivo/, /cenario=meta/]) assert.match(text, trecho);
  });

  test('prompts prontos: dicas de economia, categorizar pendentes, posso comprar e equilibrar', async () => {
    const list = (await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' })) as any;
    assert.deepEqual(list.result.prompts.map((p: { name: string }) => p.name).sort(), ['categorizar_pendentes', 'dicas_de_economia', 'equilibrar_objetivos', 'posso_comprar']);
    const got = (await handle({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'dicas_de_economia', arguments: { meses: '6' } } })) as any;
    const text = got.result.messages[0].content.text as string;
    assert.match(text, /gastos_recorrentes/);
    assert.match(text, /6 meses/);
  });
});
