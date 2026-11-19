// Cálculo da previsão mês a mês e do veredito de uma compra (função pura, centavos inteiros).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MesBase, projetar } from '../src/previsao.ts';

/** Meses com entradas 10.000, conta 3.000, cartão 4.000 e as parcelas dadas (sobra = 3.000 − parcelas). */
const meses = (parcelas: string[], planejados?: string[], guardar?: string[]): MesBase[] => parcelas.map((p, i) => ({
  mes: `2027-0${i + 1}`, entradas: '10000.00', gastos_conta: '3000.00', cartao_avista: '4000.00',
  parcelas: p, planejados: planejados?.[i] ?? '0.00', guardar_planejado: guardar?.[i] ?? '0.00',
}));

test('sobra, saldo acumulado e capacidade de compra à vista em cada mês', () => {
  const r = projetar(meses(['2000.00', '1000.00', '0.00']), { reserva: '0', margem: '0' });
  assert.deepEqual(r.meses.map((m) => [m.sobra, m.saldo, m.capacidade_avista]), [
    ['1000.00', '1000.00', '1000.00'],
    ['2000.00', '3000.00', '3000.00'],
    ['3000.00', '6000.00', '6000.00'],
  ]);
  assert.equal(r.compra, undefined);
});

test('capacidade olha o menor saldo daqui para a frente (e nunca fica negativa)', () => {
  const r = projetar(meses(['5000.00', '2000.00', '0.00']), { reserva: '0', margem: '0' });
  assert.deepEqual(r.meses.map((m) => [m.sobra, m.saldo, m.capacidade_avista]), [
    ['-2000.00', '-2000.00', '0.00'],
    ['1000.00', '-1000.00', '0.00'],
    ['3000.00', '2000.00', '2000.00'],
  ]);
});

test('reserva entra no saldo e gastos planejados saem da sobra', () => {
  const r = projetar(meses(['0.00', '0.00'], ['500.00', '0.00']), { reserva: '1500', margem: '0' });
  assert.deepEqual(r.meses.map((m) => [m.sobra, m.saldo]), [['2500.00', '4000.00'], ['3000.00', '7000.00']]);
});

test('compra à vista: cabe, no limite (abaixo da margem) ou não cabe', () => {
  const base = meses(['2000.00', '1000.00', '0.00']);
  const cabe = projetar(base, { reserva: '0', margem: '100', compra: { valor: '500', parcelas: 1, mes: '2027-01' } });
  assert.deepEqual(cabe.compra, {
    valor: '500.00', parcelas: 1, mes: '2027-01', veredito: 'cabe',
    menor_saldo: '500.00', mes_menor_saldo: '2027-01', a_partir_de: '2027-01', corte_mensal: null, tira_dos_objetivos: '0.00',
  });
  assert.deepEqual(cabe.meses.map((m) => [m.compra, m.saldo_com_compra]), [['500.00', '500.00'], ['0.00', '2500.00'], ['0.00', '5500.00']]);

  const limite = projetar(base, { reserva: '0', margem: '100', compra: { valor: '950', parcelas: 1, mes: '2027-01' } });
  assert.equal(limite.compra!.veredito, 'no_limite');
  assert.equal(limite.compra!.menor_saldo, '50.00');
});

test('não cabe: diz a partir de quando cabe e quanto cortar por mês, desde já, para caber', () => {
  const r = projetar(meses(['5000.00', '2000.00', '0.00']), { reserva: '0', margem: '0', compra: { valor: '1000', parcelas: 1, mes: '2027-01' } });
  // saldo com a compra: -3000, -2000, 1000. Cortando c por mês: -3000 + c ≥ 0 e -2000 + 2c ≥ 0 → c = 3000.
  assert.deepEqual(r.compra, {
    valor: '1000.00', parcelas: 1, mes: '2027-01', veredito: 'nao_cabe',
    menor_saldo: '-3000.00', mes_menor_saldo: '2027-01', a_partir_de: '2027-03', corte_mensal: '3000.00', tira_dos_objetivos: '0.00',
  });
});

test('compra parcelada: divide em centavos (a 1ª leva o resto) e só sugere início com todas as parcelas no horizonte', () => {
  const r = projetar(meses(['0.00', '0.00', '0.00']), { reserva: '0', margem: '0', compra: { valor: '1000', parcelas: 3, mes: '2027-01' } });
  assert.deepEqual(r.meses.map((m) => m.compra), ['333.34', '333.33', '333.33']);
  assert.equal(r.compra!.veredito, 'cabe');

  // Sobra de 3.000 por mês, sem reserva: 7.000 em 2x não cabe começando no 1º mês (3.000 − 3.500 < 0),
  // cabe começando no 2º (saldo 6.000 − 3.500, depois 9.000 − 7.000), e no 3º não haveria mês para a 2ª parcela.
  const r2 = projetar(meses(['0.00', '0.00', '0.00']), { reserva: '0', margem: '0', compra: { valor: '7000', parcelas: 2, mes: '2027-01' } });
  assert.equal(r2.compra!.veredito, 'nao_cabe');
  assert.equal(r2.compra!.a_partir_de, '2027-02');
});

test('compra fora do horizonte é erro do usuário', () => {
  assert.throws(() => projetar(meses(['0.00']), { reserva: '0', margem: '0', compra: { valor: '10', parcelas: 1, mes: '2030-01' } }),
    /fora da previsão/);
});

test('guarda para os objetivos só o que sobra, depois de cobrir o buraco dos meses anteriores', () => {
  // Sobra: -2000, 3000, 500. Planejado: 1000 por mês.
  // 1º mês: não sobra, não guarda. 2º: cobre os -2000 e guarda 1000. 3º: só sobram 500, guarda 500.
  const r = projetar(meses(['5000.00', '0.00', '2500.00'], undefined, ['1000.00', '1000.00', '1000.00']), { reserva: '0', margem: '0' });
  assert.deepEqual(r.meses.map((m) => [m.sobra, m.guardar_planejado, m.guardar, m.saldo, m.capacidade_avista]), [
    ['-2000.00', '1000.00', '0.00', '-2000.00', '0.00'],
    ['3000.00', '1000.00', '1000.00', '0.00', '0.00'],
    ['500.00', '1000.00', '500.00', '0.00', '0.00'],
  ]);
});

test('com os objetivos em dia, a sobra vai para eles e o resto fica no saldo', () => {
  const r = projetar(meses(['0.00', '0.00'], undefined, ['1000.00', '0.00']), { reserva: '0', margem: '0' });
  assert.deepEqual(r.meses.map((m) => [m.sobra, m.guardar, m.saldo]), [['3000.00', '1000.00', '2000.00'], ['3000.00', '0.00', '5000.00']]);
});

test('compra que tiraria dos objetivos não cabe, mesmo com o saldo positivo', () => {
  // Sobra de 3000, 2500 por mês para os objetivos: saldo 500, 1000, 1500.
  // 1000 à vista no 1º mês: só sobram 2000 para guardar (tira 500) e o saldo fica em 0.
  const base = meses(['0.00', '0.00', '0.00'], undefined, ['2500.00', '2500.00', '2500.00']);
  const r = projetar(base, { reserva: '0', margem: '0', compra: { valor: '1000', parcelas: 1, mes: '2027-01' } });
  assert.deepEqual(r.compra, {
    valor: '1000.00', parcelas: 1, mes: '2027-01', veredito: 'nao_cabe',
    menor_saldo: '0.00', mes_menor_saldo: '2027-01',
    // No 2º mês já há 500 de saldo: 500 + 3000 − 1000 cobre os 2500 dos objetivos.
    a_partir_de: '2027-02',
    // Cortando 500 por mês desde já, o 1º mês tem 3500 − 1000 = 2500 para os objetivos.
    corte_mensal: '500.00',
    tira_dos_objetivos: '500.00',
  });
  assert.deepEqual(r.meses.map((m) => [m.sobra_com_compra, m.guardar_com_compra, m.saldo_com_compra]), [
    ['2000.00', '2000.00', '0.00'], ['3000.00', '2500.00', '500.00'], ['3000.00', '2500.00', '1000.00'],
  ]);
});

test('quanto ainda dá para guardar por mês, a partir de cada mês, sem o saldo ficar abaixo da margem', () => {
  // saldo: -2000, -1000, 2000, 5000. A partir do 3º mês: min((2000 − 500) ÷ 1, (5000 − 500) ÷ 2) = 1500.
  // A partir do 1º ou do 2º: o saldo já está abaixo da margem, então 0.
  const r = projetar(meses(['5000.00', '2000.00', '0.00', '0.00']), { reserva: '0', margem: '500' });
  assert.deepEqual(r.meses.map((m) => m.aporte_maximo), ['0.00', '0.00', '1500.00', '4500.00']);
});

test('parcelas além do horizonte exibido também contam no veredito e no "a partir de"', () => {
  // 6 meses de base, 3 exibidos. Sobra de 3.000; 9.000 em 3x de 3.000 cabe com margem 0 desde o 1º mês.
  // Com 4 parcelas de 3.000 e margem 500 começando no 3º mês, a última cai no 6º (fora do que é exibido).
  const base = meses(['0.00', '0.00', '0.00', '0.00', '0.00', '0.00']);
  const r = projetar(base, { reserva: '0', margem: '500', exibir: 3, compra: { valor: '12000', parcelas: 4, mes: '2027-01' } });
  assert.equal(r.meses.length, 3, 'só os meses exibidos voltam');
  // Saldo com a compra desde o 1º mês: 0, 0, 0, 0 (sobra 3.000 − parcela 3.000) → abaixo da margem.
  assert.equal(r.compra!.veredito, 'no_limite');
  // Começando no 2º mês: 3000, 3000, 3000, 3000, 6000 → cabe; as parcelas vão até o 5º mês, fora do exibido.
  assert.equal(r.compra!.a_partir_de, '2027-02');
  assert.throws(() => projetar(base, { reserva: '0', margem: '0', exibir: 3, compra: { valor: '10', parcelas: 1, mes: '2027-05' } }),
    /fora da previsão \(de 2027-01 a 2027-03\)/);
});

test('guardado: começa no que está nos investimentos e soma a sobra de cada mês (ou tira o que falta)', () => {
  // sobra: -2000, -500, +1000, +3000
  const r = projetar(meses(['5000.00', '3500.00', '2000.00', '0.00']), { reserva: '0', margem: '0', guardado: '4000' });
  assert.deepEqual(r.meses.map((m) => m.guardado), ['2000.00', '1500.00', '2500.00', '5500.00']);
  assert.deepEqual(r.guardado, { inicial: '4000.00', menor: '1500.00', mes_menor: '2027-02', acaba_em: null, tranquilo_em: '2027-03' });
});

test('guardado: diz quando acaba e, sem sobra positiva de vez no horizonte, não há "tranquilo"', () => {
  // sobra: -2000, +1000, -500
  const r = projetar(meses(['5000.00', '2000.00', '3500.00']), { reserva: '0', margem: '0', guardado: '1500' });
  assert.deepEqual(r.meses.map((m) => m.guardado), ['-500.00', '500.00', '0.00']);
  assert.deepEqual(r.guardado, { inicial: '1500.00', menor: '-500.00', mes_menor: '2027-01', acaba_em: '2027-01', tranquilo_em: null });
});

test('guardado: com uma compra simulada, mostra também o caminho com ela', () => {
  const r = projetar(meses(['3000.00', '2000.00', '0.00']), {
    reserva: '0', margem: '0', guardado: '1000', compra: { valor: '1500', parcelas: 1, mes: '2027-01' },
  });
  // sobra sem a compra: 0, 1000, 3000; com ela: -1500, 1000, 3000
  assert.deepEqual(r.meses.map((m) => [m.guardado, m.guardado_com_compra]), [
    ['1000.00', '-500.00'], ['2000.00', '500.00'], ['5000.00', '3500.00'],
  ]);
  assert.deepEqual(r.compra!.guardado, { menor: '-500.00', mes_menor: '2027-01', acaba_em: '2027-01' });
});

test('sem guardado informado, nada de guardado na resposta', () => {
  const r = projetar(meses(['0.00']), { reserva: '0', margem: '0' });
  assert.equal(r.guardado, undefined);
  assert.equal(r.meses[0]!.guardado, undefined);
});
