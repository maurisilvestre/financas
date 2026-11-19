// "A pagar até o próximo salário" pela API: próximo salário, contas fixas (reconhecidas pela
// descrição em qualquer conta, ou marcadas como pagas), faturas fechadas e a aberta, saldo das
// contas e as escritas da camada do usuário.
// Dados de test/fixture-db.ts mais transações e faturas inseridas aqui, em datas relativas a hoje.
//
// Requer o Postgres descartável (ver sync.integration.test.ts) e TEST_PG_URL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { startWebServer } from '../src/api/server.ts';
import { dateInTimezone } from '../src/normalize.ts';
import { createSeededDb, type SeededDb } from './fixture-db.ts';

const dia = (n: number) => dateInTimezone(new Date(Date.now() + n * 86_400_000));
const diaDoMes = (d: string) => Number(d.slice(8, 10));

describe('a pagar até o próximo salário (integração)', { skip: process.env.TEST_PG_URL ? false : 'defina TEST_PG_URL para rodar' }, () => {
  let seeded: SeededDb;
  let server: Server;
  let base: string;
  let conta: number;
  let cartao: number;

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
  /** Mesma data no mês anterior (o fim do mês fica no último dia), como o Postgres faz. */
  const mesAntes = async (d: string) => (await seeded.app.query<{ d: string }>(
    `SELECT to_char($1::date - interval '1 month', 'YYYY-MM-DD') AS d`, [d])).rows[0]!.d;
  const mesDepois = async (d: string) => (await seeded.app.query<{ d: string }>(
    `SELECT to_char($1::date + interval '1 month', 'YYYY-MM-DD') AS d`, [d])).rows[0]!.d;
  const inserir = async (accountId: number, data: string, descricao: string, valor: number) => {
    await seeded.app.query(
      `INSERT INTO fin.transactions (pluggy_id, account_id, occurred_at, local_date, description, amount, signed_amount, currency_code, type, status, raw)
       VALUES (gen_random_uuid(), $1, now(), $2::date, $3, abs($4::numeric), $4::numeric, 'BRL', CASE WHEN $4::numeric < 0 THEN 'DEBIT' ELSE 'CREDIT' END, 'POSTED', '{}'::jsonb)`,
      [accountId, data, descricao, valor]);
  };
  const fatura = async (vencimento: string, total: number) => {
    const id = randomUUID();
    await seeded.app.query(
      `INSERT INTO fin.credit_card_bills (pluggy_id, account_id, due_date, total_amount, raw) VALUES ($1, $2, $3::date, $4, '{}'::jsonb)`,
      [id, cartao, vencimento, total]);
    return id;
  };

  before(async () => {
    seeded = await createSeededDb('fin_apagar');
    conta = (await seeded.app.query<{ id: number }>(`SELECT id::int FROM fin.accounts WHERE subtype = 'CHECKING_ACCOUNT'`)).rows[0]!.id;
    cartao = (await seeded.app.query<{ id: number }>(`SELECT id::int FROM fin.accounts WHERE subtype = 'CREDIT_CARD'`)).rows[0]!.id;
    // Salário de anteontem (as regras do fixture põem SALARIO na categoria Salário pelo tipo da operação).
    await seeded.app.query(
      `INSERT INTO fin.transactions (pluggy_id, account_id, occurred_at, local_date, description, amount, signed_amount, currency_code, type, status, operation_type, raw)
       VALUES (gen_random_uuid(), $1, now(), $2::date, 'SALARIO EMPRESA X', 8000, 8000, 'BRL', 'CREDIT', 'POSTED', 'FOLHA_PAGAMENTO', '{}'::jsonb)`,
      [conta, dia(-2)]);
    // Luz: daqui a 3 dias; no mês passado saíram 300 (o valor esperado vem daí).
    await inserir(conta, await mesAntes(dia(3)), 'Pagamento efetuado|CIA ENERGIA SUL', -300);
    // Celular: a conta do mês passado foi paga 8 dias atrasada; esse pagamento é do mês passado,
    // não adianta a deste mês (cada pagamento vale para o vencimento mais próximo).
    await inserir(conta, await seeded.app.query<{ d: string }>(`SELECT to_char($1::date + 8, 'YYYY-MM-DD') AS d`, [await mesAntes(dia(3))]).then((r) => r.rows[0]!.d), 'PAGTO OPERADORA CEL S.A.', -40);
    // Mensalidade: venceu ontem e foi paga ontem.
    await inserir(conta, dia(-1), 'PAGTO COBRANCA COLEGIO EXEMPLO', -950);
    // Cartão: o que já está numa fatura velha não conta na aberta; uma compra de hoje e uma parcela futura.
    const velha = await fatura(dia(-20), 300);
    await seeded.app.query(`UPDATE fin.transactions SET bill_pluggy_id = $1 WHERE account_id = $2 AND local_date < $3::date`, [velha, cartao, dia(-3)]);
    await inserir(cartao, dia(0), 'MERCADO DO BAIRRO', -50);
    await inserir(cartao, dia(20), 'LOJA PARCELADA 03/05', -999);

    server = await startWebServer({ pools: { read: seeded.read, write: seeded.write }, host: '127.0.0.1', port: 0, staticDir: null });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await seeded?.close();
  });

  test('contas fixas: criar valida a conta e o trecho; o fin_mcp não apaga', async () => {
    const criar = (c: Record<string, unknown>) => post('/api/contas-fixas', { conta_id: conta, ...c });
    assert.equal((await criar({ nome: 'Luz', padrao: 'cia energia', dia: diaDoMes(dia(3)) })).status, 200);
    assert.equal((await criar({ nome: 'Mensalidade', padrao: 'colegio exemplo', dia: diaDoMes(dia(-1)) })).status, 200);
    assert.equal((await criar({ nome: 'Internet', padrao: 'provedor net', dia: diaDoMes(dia(-5)), valor: 100 })).status, 200);
    assert.equal((await criar({ nome: 'Antiga', padrao: 'coisa antiga', dia: 10, valor: 50 })).status, 200);
    assert.equal((await criar({ nome: 'Celular', padrao: 'operadora cel', dia: diaDoMes(dia(3)) })).status, 200);
    assert.equal((await criar({ nome: 'x', padrao: 'ab', dia: 5 })).status, 400, 'trecho curto demais');
    assert.equal((await criar({ nome: 'x', padrao: 'abc', dia: 32 })).status, 400);
    assert.equal((await post('/api/contas-fixas', { nome: 'x', padrao: 'abc', dia: 5, conta_id: cartao })).status, 400, 'cartão não paga conta');
    assert.equal((await post('/api/contas-fixas/999999', { status: 'encerrada' })).status, 404);
    await assert.rejects(seeded.write.query('DELETE FROM fin.recurring_bills'), /permission denied/);
    await assert.rejects(seeded.read.query(`INSERT INTO fin.recurring_bills (name, pattern, due_day) VALUES ('x', 'xyz', 1)`), /read-only|permission denied/);
  });

  test('próximo salário, saldo, contas fixas pagas, a pagar e atrasadas, fatura aberta estimada', async () => {
    const antiga = (await get('/api/a-pagar')).json.contas_fixas.find((c: any) => c.nome === 'Antiga');
    assert.equal((await post(`/api/contas-fixas/${antiga.id}`, { status: 'encerrada' })).status, 200);

    const { status, json: r } = await get('/api/a-pagar');
    assert.equal(status, 200);
    assert.deepEqual(r.ultimo_salario, { data: dia(-2), valor: '8000.00' });
    assert.equal(r.proximo_salario, await mesDepois(dia(-2)));
    assert.deepEqual(r.contas.map((c: any) => [c.conta, c.saldo]), [['Conta Corrente', '2500.50']]);
    assert.equal(r.guardado.total, '1500.50', 'o guardado vem junto, para ver se cobre o que falta');

    const itens = r.itens.map((i: any) => [i.tipo, i.descricao, i.vencimento, i.situacao, i.valor]);
    const internetDepois = await mesDepois(dia(-5));
    assert.deepEqual(itens.filter((i: any[]) => i[0] === 'conta_fixa'), [
      ['conta_fixa', 'Internet', dia(-5), 'atrasada', '100.00'],
      ['conta_fixa', 'Mensalidade', dia(-1), 'paga', '950.00'],
      ['conta_fixa', 'Celular', dia(3), 'a_pagar', '40.00'],
      ['conta_fixa', 'Luz', dia(3), 'a_pagar', '300.00'],
      ...(internetDepois < r.proximo_salario ? [['conta_fixa', 'Internet', internetDepois, 'a_pagar', '100.00']] : []),
    ], 'a encerrada não aparece');
    // Fatura aberta: o que foi gasto no cartão até hoje e ainda não está numa fatura fechada (a parcela futura fica de fora).
    const aberta = r.itens.find((i: any) => i.tipo === 'fatura_aberta');
    assert.equal(aberta.vencimento, await mesDepois(dia(-20)));
    assert.equal(aberta.valor, '450.00', 'geladeira de ontem (400) + mercado de hoje (50)');
    assert.equal(aberta.estimado, true);
    assert.equal(aberta.conta_id, conta, 'sai da conta corrente do mesmo banco');
  });

  test('fatura fechada: a pagar até chegar o pagamento no cartão; "já paguei" tira a conta da lista', async () => {
    await fatura(dia(2), 640);
    let r = (await get('/api/a-pagar')).json;
    assert.equal(r.itens.some((i: any) => i.tipo === 'fatura_aberta'), false, 'a próxima aberta vence depois do salário');
    const fechada = r.itens.find((i: any) => i.tipo === 'fatura');
    assert.deepEqual([fechada.vencimento, fechada.situacao, fechada.valor, fechada.conta], [dia(2), 'a_pagar', '640.00', 'Conta Corrente']);

    await inserir(cartao, dia(0), 'Pagamento recebido', 640);
    const internet = r.contas_fixas.find((c: any) => c.nome === 'Internet');
    assert.equal((await post(`/api/contas-fixas/${internet.id}`, { pago_ate: dia(-5) })).status, 200);

    r = (await get('/api/a-pagar')).json;
    assert.equal(r.itens.find((i: any) => i.tipo === 'fatura').situacao, 'paga');
    assert.equal(r.itens.some((i: any) => i.descricao === 'Internet' && i.vencimento === dia(-5)), false, 'paga antes do salário: é do ciclo anterior');
    const falta = r.itens.filter((i: any) => i.situacao !== 'paga').reduce((s: number, i: any) => s + Number(i.valor), 0);
    assert.equal(r.a_pagar, falta.toFixed(2));
    assert.equal(r.sobra, (2500.5 - falta).toFixed(2));
    assert.equal(r.contas[0].a_pagar, r.a_pagar);
  });
  test('fatura paga pela conta (débito automático com o valor exato) conta como paga, mesmo sem o crédito no cartão', async () => {
    await fatura(dia(4), 777.77);
    let r = (await get('/api/a-pagar')).json;
    assert.equal(r.itens.find((i: any) => i.tipo === 'fatura' && i.vencimento === dia(4)).situacao, 'a_pagar');
    await inserir(conta, dia(0), 'PROVISAO GASTO CART CRED - DOCTO: 1', -777.77);
    r = (await get('/api/a-pagar')).json;
    const f = r.itens.find((i: any) => i.tipo === 'fatura' && i.vencimento === dia(4));
    assert.deepEqual([f.situacao, f.pago_em], ['paga', dia(0)]);
  });

  test('a confirmar: venceu depois da última atualização do banco na Pluggy', async () => {
    assert.equal((await post('/api/contas-fixas', { nome: 'Condomínio', padrao: 'condominio xyz', dia: diaDoMes(dia(-1)), valor: 90, conta_id: conta })).status, 200);
    let r = (await get('/api/a-pagar')).json;
    assert.equal(r.itens.find((i: any) => i.descricao === 'Condomínio').situacao, 'atrasada', 'o banco atualizou hoje');
    await seeded.app.query(`UPDATE fin.items SET last_updated_at = now() - interval '3 days'`);
    r = (await get('/api/a-pagar')).json;
    assert.equal(r.itens.find((i: any) => i.descricao === 'Condomínio').situacao, 'a_confirmar');
    assert.equal(r.contas[0].dados_ate, dia(-3));
  });
  test('débito automático vencido depois da última atualização do banco: pago e fora do saldo; "já paguei" também', async () => {
    // O banco atualizou há 3 dias (teste anterior).
    assert.equal((await post('/api/contas-fixas', {
      nome: 'Financ', padrao: 'prestacao xyz', dia: diaDoMes(dia(-1)), valor: 500, conta_id: conta, debito_automatico: true,
    })).status, 200);
    let r = (await get('/api/a-pagar')).json;
    const f = r.itens.find((i: any) => i.descricao === 'Financ');
    assert.deepEqual([f.situacao, f.presumida, f.fora_do_saldo], ['paga', true, true]);
    assert.deepEqual([r.contas[0].saldo_banco, r.contas[0].ja_saiu, r.contas[0].saldo], ['2500.50', '500.00', '2000.50']);
    assert.equal(r.contas_fixas.find((c: any) => c.nome === 'Financ').debito_automatico, true);

    // "Já paguei" no condomínio (a confirmar) agora: pago e também fora do saldo.
    const cond = r.contas_fixas.find((c: any) => c.nome === 'Condomínio');
    assert.equal((await post(`/api/contas-fixas/${cond.id}`, { pago_ate: dia(-1) })).status, 200);
    r = (await get('/api/a-pagar')).json;
    const c = r.itens.find((i: any) => i.descricao === 'Condomínio');
    assert.deepEqual([c.situacao, c.fora_do_saldo], ['paga', true]);
    assert.equal(r.ja_saiu, '590.00');

    // O banco atualiza com os dados de hoje e o débito não veio: atrasada (o débito falhou).
    // O condomínio, marcado antes dessa atualização, já está no saldo.
    await seeded.app.query(`UPDATE fin.items SET last_updated_at = now()`);
    r = (await get('/api/a-pagar')).json;
    assert.equal(r.itens.find((i: any) => i.descricao === 'Financ').situacao, 'atrasada');
    assert.equal(r.itens.find((i: any) => i.descricao === 'Condomínio').fora_do_saldo, false);
    assert.equal(r.ja_saiu, '0.00');
  });
});
