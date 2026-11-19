// "A pagar até o próximo salário": a função pura que decide o que já foi pago, o que falta e se o
// saldo de cada conta cobre (sem banco).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ItemBruto, resumirAPagar } from '../src/apagar.ts';

const item = (over: Partial<ItemBruto>): ItemBruto => ({
  tipo: 'conta_fixa', id: 1, descricao: 'Conta', conta_id: 10, vencimento: '2026-11-20',
  valor: '100.00', pago: '0.00', pago_em: null, pago_manual: false, ...over,
});
const contas = [{ id: 10, conta: 'Banco A', saldo: '1000.00' }, { id: 20, conta: 'Banco B', saldo: '50.00' }];
const base = { hoje: '2026-11-12', inicio_ciclo: '2026-11-12', limite_atraso: '2026-10-28', contas };

test('fatura fechada: paga quando o que chegou no cartão cobre o total; senão falta a diferença', () => {
  const r = resumirAPagar({ ...base, itens: [
    item({ tipo: 'fatura', descricao: 'Fatura A', valor: '900.00', pago: '900.00', pago_em: '2026-11-12', vencimento: '2026-11-13' }),
    item({ tipo: 'fatura', descricao: 'Fatura B', valor: '900.00', pago: '300.00', vencimento: '2026-11-14' }),
  ] });
  assert.deepEqual(r.itens.map((i) => [i.descricao, i.situacao, i.valor]), [
    ['Fatura A', 'paga', '900.00'],
    ['Fatura B', 'a_pagar', '600.00'],
  ]);
  assert.equal(r.a_pagar, '600.00');
});

test('conta fixa: paga se apareceu o pagamento (vale o valor pago) ou se o usuário marcou "já paguei"', () => {
  const r = resumirAPagar({ ...base, itens: [
    item({ descricao: 'Mensalidade', valor: '950.00', pago: '950.00', pago_em: '2026-11-13', vencimento: '2026-11-13' }),
    item({ descricao: 'Telefone', valor: '70.00', pago: '140.00', pago_em: '2026-11-13', vencimento: '2026-11-13' }),
    item({ descricao: 'Empréstimo', valor: '1500.00', pago_manual: true, vencimento: '2026-11-30' }),
    item({ descricao: 'Luz', valor: '310.00', vencimento: '2026-11-13' }),
  ] });
  assert.deepEqual(r.itens.map((i) => [i.descricao, i.situacao, i.valor]), [
    ['Luz', 'a_pagar', '310.00'],
    ['Mensalidade', 'paga', '950.00'],
    ['Telefone', 'paga', '140.00'],
    ['Empréstimo', 'paga', '1500.00'],
  ]);
  assert.equal(r.a_pagar, '310.00');
});

test('fatura aberta entra como estimativa; conta fixa sem valor conhecido não soma', () => {
  const r = resumirAPagar({ ...base, itens: [
    item({ tipo: 'fatura_aberta', descricao: 'Fatura Cartão 2', valor: '420.00', vencimento: '2026-11-20' }),
    item({ descricao: 'Nova', valor: null, vencimento: '2026-11-21' }),
  ] });
  assert.deepEqual(r.itens.map((i) => [i.descricao, i.situacao, i.valor, i.estimado]), [
    ['Fatura Cartão 2', 'a_pagar', '420.00', true],
    ['Nova', 'a_pagar', null, false],
  ]);
  assert.equal(r.a_pagar, '420.00');
});

test('atrasada: não paga e já venceu; some o que foi pago no ciclo anterior e o que venceu há muito', () => {
  const r = resumirAPagar({ ...base, inicio_ciclo: '2026-11-12', itens: [
    item({ descricao: 'Venceu ontem', vencimento: '2026-11-11' }),
    item({ descricao: 'Venceu há 20 dias', vencimento: '2026-10-23' }),
    item({ descricao: 'Paga no ciclo anterior', vencimento: '2026-11-03', pago: '100.00', pago_em: '2026-11-03' }),
    item({ descricao: 'Paga neste ciclo', vencimento: '2026-11-12', pago: '100.00', pago_em: '2026-11-12' }),
  ] });
  assert.deepEqual(r.itens.map((i) => [i.descricao, i.situacao]), [
    ['Venceu ontem', 'atrasada'],
    ['Paga neste ciclo', 'paga'],
  ]);
});

test('por conta: quanto sai de cada uma, se o saldo cobre e em que dia acaba; o total soma todas', () => {
  const r = resumirAPagar({ ...base, itens: [
    item({ descricao: 'Plano de saúde', valor: '600.00', vencimento: '2026-11-13' }),
    item({ descricao: 'Financiamento', valor: '700.00', vencimento: '2026-11-16' }),
    item({ descricao: 'Mensalidade', valor: '200.00', vencimento: '2026-12-03' }),
    item({ descricao: 'Fatura Banco B', tipo: 'fatura', conta_id: 20, valor: '40.00', vencimento: '2026-11-20' }),
    item({ descricao: 'Sem conta', conta_id: null, valor: '10.00', vencimento: '2026-11-25' }),
  ] });
  assert.deepEqual(r.contas, [
    { id: 10, conta: 'Banco A', saldo_banco: '1000.00', ja_saiu: '0.00', saldo: '1000.00', a_pagar: '1500.00', sobra: '-500.00', acaba_em: { data: '2026-11-16', descricao: 'Financiamento' }, dados_ate: null },
    { id: 20, conta: 'Banco B', saldo_banco: '50.00', ja_saiu: '0.00', saldo: '50.00', a_pagar: '40.00', sobra: '10.00', acaba_em: null, dados_ate: null },
  ]);
  assert.deepEqual([r.saldo, r.a_pagar, r.sobra], ['1050.00', '1550.00', '-500.00']);
});

test('a confirmar: venceu, mas o banco ainda não mandou dados desse dia em diante (não é atraso)', () => {
  const r = resumirAPagar({
    ...base, hoje: '2026-11-17',
    contas: [{ id: 10, conta: 'Banco A', saldo: '1000.00', dados_ate: '2026-11-16' }],
    itens: [
      item({ descricao: 'Luz', vencimento: '2026-11-13' }),
      item({ descricao: 'Financiamento', vencimento: '2026-11-16' }),
      item({ descricao: 'Sem conta', conta_id: null, vencimento: '2026-11-16' }),
    ],
  });
  assert.deepEqual(r.itens.map((i) => [i.descricao, i.situacao]), [
    ['Luz', 'atrasada'],
    ['Financiamento', 'a_confirmar'],
    ['Sem conta', 'atrasada'],
  ]);
  assert.equal(r.a_pagar, '300.00', 'a confirmar continua contando: o saldo também é de antes');
});

test('débito automático: passado o vencimento, conta como pago; se o banco ainda não mostrou, sai do saldo', () => {
  const r = resumirAPagar({
    ...base, hoje: '2026-11-17',
    contas: [{ id: 10, conta: 'Banco A', saldo: '1000.00', dados_ate: '2026-11-16', atualizado_em: '2026-11-16T14:27:00Z' }],
    itens: [
      item({ descricao: 'Financiamento', valor: '600.00', vencimento: '2026-11-16', debito_automatico: true }),
      item({ descricao: 'Luz', valor: '50.00', vencimento: '2026-11-20', debito_automatico: true }),
      item({ descricao: 'Velha', valor: '30.00', vencimento: '2026-11-14', debito_automatico: true }),
    ],
  });
  assert.deepEqual(r.itens.map((i) => [i.descricao, i.situacao, i.presumida, i.fora_do_saldo]), [
    ['Velha', 'atrasada', false, false],
    ['Financiamento', 'paga', true, true],
    ['Luz', 'a_pagar', false, false],
  ]);
  assert.deepEqual(r.contas.map((c) => [c.saldo_banco, c.ja_saiu, c.saldo, c.a_pagar, c.sobra]), [['1000.00', '600.00', '400.00', '80.00', '320.00']]);
  assert.deepEqual([r.saldo_banco, r.ja_saiu, r.saldo, r.a_pagar, r.sobra], ['1000.00', '600.00', '400.00', '80.00', '320.00']);
});

test('"já paguei" depois da última atualização do banco: pago e fora do saldo; antes dela, o saldo já reflete', () => {
  const r = resumirAPagar({
    ...base, hoje: '2026-11-17',
    contas: [{ id: 10, conta: 'Banco A', saldo: '1000.00', dados_ate: '2026-11-16', atualizado_em: '2026-11-16T14:27:00Z' }],
    itens: [
      item({ descricao: 'Marcada hoje', valor: '200.00', vencimento: '2026-11-16', pago_manual: true, marcado_em: '2026-11-17T13:00:00Z' }),
      item({ descricao: 'Marcada antes', valor: '300.00', vencimento: '2026-11-30', pago_manual: true, marcado_em: '2026-11-12T15:00:00Z' }),
      item({ descricao: 'Marcada sem data', valor: '50.00', vencimento: '2026-11-30', pago_manual: true }),
    ],
  });
  assert.deepEqual(r.itens.map((i) => [i.descricao, i.situacao, i.fora_do_saldo]), [
    ['Marcada hoje', 'paga', true],
    ['Marcada antes', 'paga', false],
    ['Marcada sem data', 'paga', false],
  ]);
  assert.equal(r.contas[0]!.saldo, '800.00');
});
