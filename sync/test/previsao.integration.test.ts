// Previsão ("guardião do compra ou não compra") pela API: médias, o que fica fora delas,
// parcelas, gastos planejados, simulação de compra e as escritas da camada do usuário.
// Dados de test/fixture-db.ts mais transações inseridas aqui.
//
// Requer o Postgres descartável (ver sync.integration.test.ts) e TEST_PG_URL.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { startWebServer } from '../src/api/server.ts';
import { createSeededDb, mon, type SeededDb } from './fixture-db.ts';

describe('previsão e simulação de compra (integração)', { skip: process.env.TEST_PG_URL ? false : 'defina TEST_PG_URL para rodar' }, () => {
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
    seeded = await createSeededDb('fin_prev');
    // Na conta corrente, além do fixture (salário 8.000 nos meses 1 e 2, plano de saúde 1.200 nos meses 1 a 3, LOJA DO ZE 80 no mês 1):
    //  - assinatura que acabou (2.500, meses 1 a 3): vai ser excluída pelo trecho da descrição;
    //  - imposto pago uma vez (17.550, mês 2): pontual, fica fora sozinho;
    //  - curso (3.000, meses 1 e 2, categoria Educação): vai ser excluído pela categoria;
    //  - parcela que mudou de descrição (4.122 no mês 2, 4.120 no mês 1): valor parecido, não é pontual.
    const linhas = [
      [1, 'ASSINATURA ANTIGA', 2500], [2, 'ASSINATURA ANTIGA', 2500], [3, 'ASSINATURA ANTIGA', 2500],
      [2, 'PAGTO TRIBUTO ITBI', 17550],
      [1, 'CURSO INTENSIVO', 3000], [2, 'CURSO INTENSIVO', 3000],
      [2, 'PARCELA CONSORCIO DOCTO', 4122], [1, 'PARCELA CONSORCIO PARCELA DOCTO', 4120],
    ] as const;
    for (const [k, descricao, valor] of linhas) {
      await seeded.app.query(
        `INSERT INTO fin.transactions (pluggy_id, account_id, occurred_at, local_date, description, amount, signed_amount, currency_code, type, status, raw)
         SELECT gen_random_uuid(), id, now(), $1::date, $2, $3, -$3::numeric, 'BRL', 'DEBIT', 'POSTED', '{}'::jsonb
         FROM fin.accounts WHERE subtype = 'CHECKING_ACCOUNT'`, [`${mon(k)}-12`, descricao, valor]);
    }
    await seeded.app.query(
      `INSERT INTO fin.transaction_overrides (transaction_id, category_id)
       SELECT t.id, c.id FROM fin.transactions t, fin.categories c WHERE t.description = 'CURSO INTENSIVO' AND c.name = 'Educação'`);
    server = await startWebServer({ pools: { read: seeded.read, write: seeded.write }, host: '127.0.0.1', port: 0, staticDir: null });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await seeded?.close();
  });

  test('médias: entradas e cartão de 6 meses, conta de 3 meses; o pontual grande fica fora sozinho', async () => {
    const { status, json: p } = await get('/api/previsao');
    assert.equal(status, 200);
    assert.deepEqual(p.base, { meses_media: 6, de: mon(6), ate: mon(1), meses_fixos: 3, fixos_de: mon(3) });
    // Entradas: 2 salários de 8.000 ÷ 6. Cartão: Netflix 3 × 55,90 + academia 129,90 = 297,60 ÷ 6.
    // Conta (meses 1 a 3): plano de saúde 3.600 + loja 80 + assinatura 7.500 + curso 6.000 + parcela 8.242 = 25.422 ÷ 3.
    assert.deepEqual(p.medias, { entradas: '2666.67', gastos_conta: '8474.00', cartao_avista: '49.60', cartao_avista_media: '49.60' });
    assert.deepEqual(p.fora_da_media.pontuais.map((x: any) => [x.descricao, x.valor]), [['PAGTO TRIBUTO ITBI', '17550.00']]);
    assert.equal(p.meses.length, 12);
    assert.equal(p.meses[0].mes, mon(0));
    assert.equal(p.cenario, 'media');
  });

  test('exclusões: assinatura que acabou (trecho) e curso (categoria) saem da média', async () => {
    const a = await post('/api/previsao/exclusoes', { padrao: 'assinatura antiga', motivo: 'acabou em outubro' });
    assert.equal(a.status, 200);
    assert.equal((await post('/api/previsao/exclusoes', { categoria: 'Educação', motivo: 'curso terminou' })).status, 200);
    const { json: p } = await get('/api/previsao');
    // Conta: 25.422 − 7.500 − 6.000 = 11.922 ÷ 3.
    assert.equal(p.medias.gastos_conta, '3974.00');
    assert.deepEqual(p.fora_da_media.encerrados, [{ id: a.json.id, padrao: 'assinatura antiga', motivo: 'acabou em outubro', total: '7500.00' }]);
    assert.deepEqual(p.fora_da_media.categorias.map((c: any) => [c.categoria, c.total]), [['Educação', '6000.00']]);

    // Desativar devolve a assinatura à média.
    assert.equal((await post(`/api/previsao/exclusoes/${a.json.id}/remover`, {})).status, 200);
    assert.equal((await get('/api/previsao')).json.medias.gastos_conta, '6474.00');
    await post('/api/previsao/exclusoes', { padrao: 'assinatura antiga', motivo: 'acabou em outubro' });
  });

  test('exclusão: exatamente um entre trecho e categoria; categoria precisa existir', async () => {
    assert.equal((await post('/api/previsao/exclusoes', { motivo: 'x' })).status, 400);
    assert.equal((await post('/api/previsao/exclusoes', { padrao: 'abc', categoria: 'Lazer', motivo: 'x' })).status, 400);
    assert.equal((await post('/api/previsao/exclusoes', { categoria: 'Não existe', motivo: 'x' })).status, 400);
    assert.equal((await post('/api/previsao/exclusoes', { padrao: 'ab', motivo: 'x' })).status, 400);
  });

  test('parcelas do mês vêm do plano de parcelas, exatas', async () => {
    const { json: p } = await get('/api/previsao');
    const { json: c } = await get('/api/compromissos');
    const porMes = new Map<string, number>();
    for (const r of c.por_mes) porMes.set(r.mes, (porMes.get(r.mes) ?? 0) + Number(r.comprometido));
    for (const m of p.meses) assert.equal(Number(m.parcelas), porMes.get(m.mes) ?? 0, m.mes);
    assert.ok(p.meses.some((m: any) => m.parcelas === '400.00'), 'a geladeira 10x de 400 do fixture');
  });

  test('gasto planejado: entra dividido nos meses, sai da previsão quando realizado', async () => {
    const r = await post('/api/planejados', { descricao: 'Geladeira nova', motivo: 'a velha quebrou', valor: 3000, parcelas: 2, mes: mon(-1) });
    assert.equal(r.status, 200);
    let { json: p } = await get('/api/previsao');
    assert.deepEqual(p.meses.slice(0, 3).map((m: any) => m.planejados), ['0.00', '1500.00', '1500.00']);
    assert.deepEqual(p.planejados.map((x: any) => [x.descricao, x.motivo, x.valor, x.parcelas, x.mes, x.status]),
      [['Geladeira nova', 'a velha quebrou', '3000.00', 2, mon(-1), 'planejado']]);

    assert.equal((await post(`/api/planejados/${r.json.id}/status`, { status: 'realizado' })).status, 200);
    ({ json: p } = await get('/api/previsao'));
    assert.ok(p.meses.every((m: any) => m.planejados === '0.00'));
    assert.equal(p.planejados.length, 0, 'só os planejados aparecem na lista');
    assert.equal((await post('/api/planejados', { descricao: 'x', valor: -1, mes: mon(0) })).status, 400);
    assert.equal((await post('/api/planejados/999999/status', { status: 'cancelado' })).status, 404);
  });

  test('simulação de compra: veredito, menor saldo e começo sugerido; cenário da meta troca o cartão', async () => {
    const { status, json: p } = await get(`/api/previsao?valor=500&descricao=Sofa&mes=${mon(0)}&reserva=100000&margem=0`);
    assert.equal(status, 200);
    assert.equal(p.compra.descricao, 'Sofa');
    assert.equal(p.compra.veredito, 'cabe');
    assert.equal(p.meses[0].compra, '500.00');

    // Sem reserva, a conta (5.374) é maior que as entradas (2.667): nada cabe.
    const { json: n } = await get(`/api/previsao?valor=500&mes=${mon(0)}`);
    assert.equal(n.compra.veredito, 'nao_cabe');
    assert.equal(n.compra.a_partir_de, null);

    await post('/api/meta', { meta_cartao_avista: 10 });
    const { json: m } = await get('/api/previsao?cenario=meta');
    assert.equal(m.cenario, 'meta');
    assert.equal(m.medias.cartao_avista, '10.00');
    assert.equal(m.medias.cartao_avista_media, '49.60');
    assert.equal(m.meses[0].cartao_avista, '10.00');
    assert.equal((await get('/api/previsao?valor=10&mes=2099-01')).status, 400);
  });

  test('objetivos: planejam o aporte até completar, mas só guardam o que sobra; atualizar muda o plano', async () => {
    const { json: antes } = await get('/api/previsao');
    const r = await post('/api/objetivos', { nome: 'Reserva', motivo: 'imprevistos', valor: 2500, ja_guardado: 500, por_mes: 800, inicio: mon(-1) });
    assert.equal(r.status, 200);
    let { json: p } = await get('/api/previsao');
    // Faltam 2.000: 800, 800 e 400 a partir do mês que vem.
    assert.deepEqual(p.meses.slice(0, 5).map((m: any) => m.guardar_planejado), ['0.00', '800.00', '800.00', '400.00', '0.00']);
    // No fixture a conta é maior que as entradas: não sobra, então não guarda e o saldo não muda.
    assert.ok(p.meses.every((m: any) => m.guardar === '0.00'), 'se não sobra, não guarda');
    assert.deepEqual(p.meses.map((m: any) => [m.sobra, m.saldo]), antes.meses.map((m: any) => [m.sobra, m.saldo]));
    // Com dinheiro (reserva), guarda o planejado.
    ({ json: p } = await get('/api/previsao?reserva=100000'));
    assert.deepEqual(p.meses.slice(0, 5).map((m: any) => m.guardar), ['0.00', '800.00', '800.00', '400.00', '0.00']);
    assert.deepEqual(p.objetivos, [{
      id: r.json.id, nome: 'Reserva', motivo: 'imprevistos', alvo: '2500.00', guardado: '500.00', falta: '2000.00',
      por_mes: '800.00', inicio: mon(-1), fica_pronto: mon(-3), status: 'ativo',
    }]);

    assert.equal((await post(`/api/objetivos/${r.json.id}`, { ja_guardado: 1300 })).status, 200);
    ({ json: p } = await get('/api/previsao'));
    assert.equal(p.objetivos[0].fica_pronto, mon(-2), 'faltam 1.200: 800 e 400');
    assert.equal((await post(`/api/objetivos/${r.json.id}`, { por_mes: 1200 })).status, 200);
    ({ json: p } = await get('/api/previsao'));
    assert.deepEqual([p.objetivos[0].por_mes, p.objetivos[0].fica_pronto], ['1200.00', mon(-1)]);

    assert.equal((await post(`/api/objetivos/${r.json.id}`, {})).status, 400, 'nada para mudar');
    assert.equal((await post('/api/objetivos/999999', { por_mes: 10 })).status, 404);
    assert.equal((await post('/api/objetivos', { nome: 'x', valor: -1, por_mes: 10 })).status, 400);

    assert.equal((await post(`/api/objetivos/${r.json.id}`, { status: 'concluido' })).status, 200);
    ({ json: p } = await get('/api/previsao'));
    assert.deepEqual(p.objetivos, []);
    assert.ok(p.meses.every((m: any) => m.guardar_planejado === '0.00'));
  });

  test('simulação: a compra equivale a quantos meses de aporte de cada objetivo', async () => {
    const { json: g } = await post('/api/objetivos', { nome: 'Reforma', valor: 10000, por_mes: 1000, inicio: mon(0) });
    const { json: p } = await get(`/api/previsao?valor=2500&mes=${mon(0)}&reserva=100000&margem=0`);
    assert.deepEqual(p.compra.equivale, [{ id: g.id, nome: 'Reforma', meses: 3 }]);
    assert.equal((await post(`/api/objetivos/${g.id}`, { status: 'cancelado' })).status, 200);
  });

  test('parcelado que passa do horizonte: o veredito e o "a partir de" contam todas as parcelas', async () => {
    const ultimo = mon(-11);
    const { json: p } = await get(`/api/previsao?valor=1200&parcelas=10&mes=${ultimo}&reserva=1000000&margem=0`);
    assert.equal(p.meses.length, 12, 'a tabela continua com 12 meses');
    assert.equal(p.compra.veredito, 'cabe');
    assert.equal(p.compra.a_partir_de, ultimo);
  });

  test('horizonte de até 4 anos: 48 meses na tabela; mais que isso é recusado', async () => {
    const { status, json: p } = await get('/api/previsao?meses=48');
    assert.equal(status, 200);
    assert.equal(p.meses.length, 48);
    assert.equal(p.meses.at(-1).mes, mon(-47));
    assert.equal((await get('/api/previsao?meses=49')).status, 400);
    // A compra pode ser num mês do 4º ano.
    const { json: c } = await get(`/api/previsao?meses=48&valor=100&mes=${mon(-40)}&reserva=100000`);
    assert.equal(c.compra.mes, mon(-40));
  });

  test('guardado: parte do que está nos investimentos e mostra até onde chega (fora do veredito)', async () => {
    const { json: p } = await get('/api/previsao');
    assert.equal(p.guardado.total, '1500.50', 'o CDB resgatado não conta');
    assert.deepEqual(p.guardado.contas, [{ conta: 'Conta Corrente', saldo: '1500.50', data: p.guardado.data }]);
    assert.match(p.guardado.data, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(p.guardado.inicial, '1500.50');
    assert.equal(p.meses[0].guardado, (1500.5 + Number(p.meses[0].sobra)).toFixed(2));
    assert.ok('tranquilo_em' in p.guardado && 'acaba_em' in p.guardado && 'menor' in p.guardado);
    assert.equal(p.reserva, '0.00', 'o saldo do veredito continua começando na reserva');
    const { json: c } = await get(`/api/previsao?valor=100&mes=${mon(0)}`);
    assert.equal(c.meses[0].guardado_com_compra, (Number(c.meses[0].guardado) - 100).toFixed(2));
    assert.ok(c.compra.guardado);
  });

  test('onde dá para cortar: média de 6 meses das categorias que não são essenciais', async () => {
    const { json: p } = await get('/api/previsao');
    // Netflix (Assinaturas): 3 × 55,90 ÷ 6. Educação está excluída; sem categoria não entra.
    assert.deepEqual(p.cortaveis, [{ categoria: 'Assinaturas', media_mensal: '27.95' }]);
  });

  test('fin_mcp não apaga planejados, exclusões nem objetivos', async () => {
    await assert.rejects(seeded.write.query('DELETE FROM fin.planned_expenses'), /permission denied/);
    await assert.rejects(seeded.write.query('DELETE FROM fin.forecast_exclusions'), /permission denied/);
    await assert.rejects(seeded.write.query("UPDATE fin.planned_expenses SET total_amount = 1"), /permission denied/);
    await assert.rejects(seeded.write.query('DELETE FROM fin.goals'), /permission denied/);
    await assert.rejects(seeded.write.query("UPDATE fin.goals SET name = 'x'"), /permission denied/);
  });
});
