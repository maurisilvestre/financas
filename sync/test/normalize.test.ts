import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItemIds, parseSyncTimes } from '../src/config.ts';
import {
  accountFingerprint,
  installmentAnchorMonth,
  installmentMatchKey,
  money,
  normalizeText,
  normalizeTransaction,
  preciseInstant,
  shiftMonth,
  stripInstallmentSuffix,
  toLocalDate,
} from '../src/normalize.ts';
import type { PluggyTransaction } from '../src/pluggy.ts';
import { msUntilNext } from '../src/scheduler.ts';
import { shortId } from '../src/log.ts';

test('shortId: ids nunca aparecem completos em logs e saídas', () => {
  assert.equal(shortId('11111111-1111-4111-8111-111111111111'), '11111111…');
});

const tx = (over: Partial<PluggyTransaction>): PluggyTransaction => ({
  id: '22222222-2222-4222-8222-222222222222',
  accountId: '33333333-3333-4333-8333-333333333333',
  date: '2026-11-05T15:30:00.000Z',
  description: 'Compra',
  amount: -10,
  currencyCode: 'BRL',
  status: 'POSTED',
  type: 'DEBIT',
  ...over,
});

test('toLocalDate: data sem hora (meia-noite UTC) mantém o dia', () => {
  assert.equal(toLocalDate('2026-11-05T00:00:00.000Z'), '2026-11-05');
});

test('toLocalDate: horário real é convertido para Brasília', () => {
  assert.equal(toLocalDate('2026-11-06T01:30:00.000Z'), '2026-11-05'); // 22:30 do dia 5 em SP
  assert.equal(toLocalDate('2026-11-05T15:30:00.000Z'), '2026-11-05');
  assert.equal(toLocalDate('2026-11-05'), '2026-11-05');
});

test('money: arredonda e formata com 2 casas', () => {
  assert.equal(money(1.005), '1.01');
  assert.equal(money(-212.45), '-212.45');
  assert.equal(money(0.1 + 0.2), '0.30');
  assert.equal(money(-0.001), '0.00');
  assert.equal(money(null), null);
  assert.equal(money(Number.NaN), null);
});

test('signed_amount: conta corrente', () => {
  const debit = normalizeTransaction(tx({ amount: -212.45, type: 'DEBIT' }), 'BANK');
  assert.equal(debit.signed_amount, '-212.45');
  assert.equal(debit.sign_mismatch, false);
  const credit = normalizeTransaction(tx({ amount: 1500, type: 'CREDIT' }), 'BANK');
  assert.equal(credit.signed_amount, '1500.00');
  assert.equal(credit.sign_mismatch, false);
});

test('signed_amount: cartão (compra positiva, pagamento negativo na Pluggy)', () => {
  const purchase = normalizeTransaction(tx({ amount: 75, type: 'DEBIT' }), 'CREDIT');
  assert.equal(purchase.signed_amount, '-75.00');
  assert.equal(purchase.sign_mismatch, false);
  const payment = normalizeTransaction(tx({ amount: -150, type: 'CREDIT' }), 'CREDIT');
  assert.equal(payment.signed_amount, '150.00');
  assert.equal(payment.sign_mismatch, false);
});

test('sign_mismatch quando o sinal contradiz o tipo', () => {
  const odd = normalizeTransaction(tx({ amount: 75, type: 'DEBIT' }), 'BANK');
  assert.equal(odd.signed_amount, '-75.00');
  assert.equal(odd.sign_mismatch, true);
});

test('parcelas: só aceita metadados coerentes', () => {
  const ok = normalizeTransaction(tx({ creditCardMetadata: { installmentNumber: 2, totalInstallments: 6, purchaseDate: '2026-09-28T00:00:00.000Z' } }), 'CREDIT');
  assert.equal(ok.installment_number, 2);
  assert.equal(ok.total_installments, 6);
  assert.equal(ok.purchase_date, '2026-09-28');
  const single = normalizeTransaction(tx({ creditCardMetadata: { installmentNumber: 1, totalInstallments: 1 } }), 'CREDIT');
  assert.equal(single.total_installments, null);
  const broken = normalizeTransaction(tx({ creditCardMetadata: { installmentNumber: 7, totalInstallments: 6 } }), 'CREDIT');
  assert.equal(broken.installment_number, null);
});

// Âncora de religação quando o banco não manda providerId (caso do Meu Pluggy).
test('preciseInstant: conta usa o horário de date', () => {
  assert.equal(preciseInstant(tx({ date: '2026-10-21T16:11:42.001Z' })), '2026-10-21T16:11:42.001Z');
});

test('preciseInstant: cartão usa transactionDateTime (instante da compra, igual em todas as parcelas)', () => {
  const installment = tx({
    date: '2026-12-16T03:00:00.000Z',
    creditCardMetadata: { installmentNumber: 4, totalInstallments: 10, transactionDateTime: '2026-09-12T19:40:58.001Z' },
  });
  assert.equal(preciseInstant(installment), '2026-09-12T19:40:58.001Z');
});

test('preciseInstant: data sem hora não serve de âncora', () => {
  assert.equal(preciseInstant(tx({ date: '2026-10-13T03:00:00.000Z' })), null); // meia-noite em Brasília
  assert.equal(preciseInstant(tx({ date: '2026-10-13T00:00:00.000Z' })), null); // meia-noite UTC
  const cardDateOnly = tx({ date: '2026-10-13T03:00:00.000Z', creditCardMetadata: { transactionDateTime: '2026-09-11T03:00:00.000Z' } });
  assert.equal(preciseInstant(cardDateOnly), null);
});

test('normalizeTransaction preenche precise_at', () => {
  assert.equal(normalizeTransaction(tx({ date: '2026-10-21T16:11:42.001Z' }), 'BANK').precise_at, '2026-10-21T16:11:42.001Z');
  assert.equal(normalizeTransaction(tx({ date: '2026-10-21T03:00:00.000Z' }), 'BANK').precise_at, null);
});

test('stripInstallmentSuffix: formatos comuns', () => {
  assert.equal(stripInstallmentSuffix('MAGALU 02/06'), 'MAGALU');
  assert.equal(stripInstallmentSuffix('Magalu - Parcela 2/6'), 'Magalu');
  assert.equal(stripInstallmentSuffix('LEROY MERLIN PARC 03/10'), 'LEROY MERLIN');
  assert.equal(stripInstallmentSuffix('Loja (2 de 6)'), 'Loja');
  assert.equal(stripInstallmentSuffix('Netflix'), 'Netflix');
  assert.equal(stripInstallmentSuffix('02/06'), '02/06');
});

test('installmentMatchKey ignora caixa, acento e o sufixo de parcela', () => {
  assert.equal(installmentMatchKey('LOJA ÁGUA 02/06', 6), installmentMatchKey('Loja Agua - Parcela 3/6', 6));
  assert.notEqual(installmentMatchKey('LOJA 02/06', 6), installmentMatchKey('LOJA 02/10', 10));
});

test('meses: âncora e deslocamento', () => {
  assert.equal(installmentAnchorMonth('2026-11-20', 3), '2026-09-01');
  assert.equal(installmentAnchorMonth('2026-02-10', 3), '2025-12-01');
  assert.equal(shiftMonth('2026-12-15', 1), '2027-01-01');
  assert.equal(shiftMonth('2026-01-15', -13), '2024-12-01');
});

test('accountFingerprint: estável entre formatos de número', () => {
  assert.equal(
    accountFingerprint({ subtype: 'CREDIT_CARD', number: 'xxxx4321', name: 'Mastercard' }),
    accountFingerprint({ subtype: 'CREDIT_CARD', number: '4321', name: 'Outro nome' }),
  );
  assert.notEqual(
    accountFingerprint({ subtype: 'CHECKING_ACCOUNT', number: '0001/12345-0', name: 'Conta' }),
    accountFingerprint({ subtype: 'SAVINGS_ACCOUNT', number: '0001/12345-0', name: 'Conta' }),
  );
  assert.equal(accountFingerprint({ subtype: 'CHECKING_ACCOUNT', number: null, name: 'Conta  Corrente' }), 'CHECKING_ACCOUNT|name:conta corrente');
});

test('normalizeText', () => {
  assert.equal(normalizeText('  Pagamento   de FATURA  Ação '), 'pagamento de fatura acao');
});

test('config: SYNC_TIMES e PLUGGY_ITEM_IDS', () => {
  assert.deepEqual(parseSyncTimes('19:17, 7:05'), [{ hour: 7, minute: 5 }, { hour: 19, minute: 17 }]);
  assert.throws(() => parseSyncTimes('25:00'));
  assert.throws(() => parseItemIds('nao-e-uuid'));
  assert.deepEqual(parseItemIds('44444444-4444-4444-8444-444444444444, 44444444-4444-4444-8444-444444444444'), ['44444444-4444-4444-8444-444444444444']);
});

test('scheduler: próximo horário no fuso de Brasília', () => {
  const times = [{ hour: 7, minute: 17 }, { hour: 19, minute: 17 }];
  // 2026-11-06 10:00 em SP = 13:00 UTC → próximo às 19:17 (9 h 17 min)
  assert.equal(msUntilNext(times, new Date('2026-11-06T13:00:00.000Z')), (9 * 60 + 17) * 60_000);
  // 20:00 em SP → próximo às 07:17 do dia seguinte (11 h 17 min)
  assert.equal(msUntilNext(times, new Date('2026-11-06T23:00:00.000Z')), (11 * 60 + 17) * 60_000);
});
