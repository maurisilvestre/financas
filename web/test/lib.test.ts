// Funções puras do front (formatação, meses, rotas, gráficos, sugestão de regra).
// Roda com o Node direto: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  caminhoAcumulado, caminhoLinha, escalaFaixa, escalaMax, larguraGrafico, marcas, marcasFaixa, rotulosEspacados, rotulosMeses,
} from '../src/lib/charts.ts';
import {
  brl, brlCompacto, contaCurta, dataCurta, deltaPct, fmtDelta, lerReais, mesAtual, mesCurto, mesLongo,
  percentual, shiftMes, somaReais, sugerirPadrao, ultimoDia,
} from '../src/lib/format.ts';
import { buildHash, parseHash } from '../src/lib/route.ts';
import { situacaoTexto } from '../src/lib/apagar.ts';
import { mensagemSync, syncEsperado, terminou } from '../src/lib/sync.ts';
import { paginaDoMes, paginar, primeiroBuraco } from '../src/lib/previsao.ts';

// Intl usa espaço não separável entre "R$" e o número.
const plain = (s: string) => s.replace(/ /g, ' ');

test('brl: valores em texto (como vêm da API) e números', () => {
  assert.equal(plain(brl('1255.90')), 'R$ 1.255,90');
  assert.equal(plain(brl('-167.7')), '-R$ 167,70');
  assert.equal(plain(brl(0)), 'R$ 0,00');
  assert.equal(brl(null), '—');
  assert.equal(brl('abc'), '—');
});

test('somaReais: soma valores da API em centavos inteiros (sem erro de float)', () => {
  assert.equal(somaReais(['0.10', '0.20']), '0.30');
  assert.equal(somaReais(['1255.90', '-167.70', '400']), '1488.20');
  assert.equal(somaReais([]), '0.00');
  assert.equal(somaReais(['-0.10', '0.05']), '-0.05');
});

test('brlCompacto: rótulos curtos para eixos de gráfico', () => {
  assert.equal(brlCompacto(950), 'R$ 950');
  assert.equal(brlCompacto(12_300), 'R$ 12,3 mil');
  assert.equal(brlCompacto(40_000), 'R$ 40 mil');
  assert.equal(brlCompacto(1_250_000), 'R$ 1,25 mi');
});

test('deltaPct e fmtDelta: variação em relação a uma base', () => {
  assert.equal(deltaPct('120', '100'), 20);
  assert.equal(deltaPct('80', '100'), -20);
  assert.equal(deltaPct('10', '0'), null);
  assert.equal(deltaPct('10', null), null);
  assert.equal(fmtDelta(12.4), '+12%');
  assert.equal(fmtDelta(-8.6), '−9%');
  assert.equal(fmtDelta(0.2), '0%');
  assert.equal(fmtDelta(2549), '>+300%'); // números enormes só fazem barulho
});

test('meses: rótulos, deslocamento, último dia e mês atual em Brasília', () => {
  assert.equal(mesCurto('2026-11'), 'nov/26');
  assert.equal(mesLongo('2026-03'), 'março de 2026');
  assert.equal(shiftMes('2026-01', -1), '2025-12');
  assert.equal(shiftMes('2026-11', 2), '2027-01');
  assert.equal(ultimoDia('2026-02'), '2026-02-28');
  assert.equal(ultimoDia('2028-02'), '2028-02-29');
  assert.equal(ultimoDia('2026-12'), '2026-12-31');
  assert.equal(dataCurta('2026-11-05'), '05/11');
  // 01:30 UTC do dia 1º ainda é dia 31 em Brasília.
  assert.equal(mesAtual(new Date('2026-11-01T01:30:00Z')), '2026-10');
});

test('contaCurta: encurta nomes longos de conta', () => {
  assert.equal(contaCurta('Banco Exemplo S.A. - Instituição de Pagamento (Conta Pré-paga)'), 'Banco Exemplo');
  assert.equal(contaCurta('Banco Exemplo'), 'Banco Exemplo');
  assert.equal(contaCurta('cartao-principal'), 'cartao-principal');
});

test('sugerirPadrao: trecho da descrição bom para uma regra "contém"', () => {
  assert.equal(sugerirPadrao('NETFLIX.COM'), 'netflix.com');
  assert.equal(sugerirPadrao('Pagamento efetuado|CLINICA VIDA   SOCIEDADE COOPERATIVA'), 'clinica vida sociedade');
  assert.equal(sugerirPadrao('Transferência enviada pelo Pix|IFOOD PAGO INSTITUICAO'), 'ifood pago instituicao');
  assert.equal(sugerirPadrao('IFOOD *RESTAURANTE X'), 'ifood');
  assert.equal(sugerirPadrao('MP *ALIEXPRESS'), 'aliexpress');
  assert.equal(sugerirPadrao('Esc*Cursodigit 9/10'), 'esc');
  assert.equal(sugerirPadrao('PIX QR CODE DINAMICO - DES  ORGAO PUBLICO EXEMPLO'), 'pix qr code');
  assert.equal(sugerirPadrao('GASTOS CARTAO DE CREDITO - DOCTO: 1234567'), 'gastos cartao de');
  assert.equal(sugerirPadrao('Max Pinhais'), 'max pinhais');
});

test('rotas: hash ↔ página e filtros', () => {
  assert.deepEqual(parseHash(''), { page: 'visao', query: {} });
  assert.deepEqual(parseHash('#/transacoes?categoria=Sa%C3%BAde&mes=2026-10'), { page: 'transacoes', query: { categoria: 'Saúde', mes: '2026-10' } });
  assert.deepEqual(parseHash('#/nao-existe'), { page: 'visao', query: {} });
  assert.equal(buildHash('transacoes', { categoria: 'Saúde', texto: '', mes: undefined }), '#/transacoes?categoria=Sa%C3%BAde');
  assert.equal(buildHash('parcelas'), '#/parcelas');
  assert.deepEqual(parseHash('#/sugestoes'), { page: 'sugestoes', query: {} });
  assert.deepEqual(parseHash('#/previsao'), { page: 'previsao', query: {} });
});

test('caminhoAcumulado: linha do acumulado dia a dia dentro da área do gráfico', () => {
  const area = { x0: 0, x1: 200, y0: 0, y1: 100 };
  // 3 dias no mês, teto 100: dia 1 em x=0, dia 3 em x=200; valor 100 no topo (y=0).
  assert.equal(caminhoAcumulado([0, 50, 100], 3, 100, area), 'M0,100 L100,50 L200,0');
  // Mês com 30 dias e só 2 dias passados: a linha para no dia 2.
  assert.equal(caminhoAcumulado([10, 20], 30, 40, { x0: 10, x1: 300, y0: 5, y1: 85 }), 'M10,65 L20,45');
  assert.equal(caminhoAcumulado([], 30, 100, area), '');
});

test('gráficos: teto "redondo" e marcas do eixo', () => {
  assert.equal(escalaMax([0]), 1);
  assert.equal(escalaMax([83_710.71, 52_205.4]), 100_000);
  assert.equal(escalaMax([1255.9]), 1500);
  assert.equal(escalaMax([37.5]), 40);
  assert.deepEqual(marcas(100_000, 4), [0, 25_000, 50_000, 75_000, 100_000]);
});

test('escalaFaixa: teto e piso "redondos", sempre com o zero dentro', () => {
  assert.deepEqual(escalaFaixa([1200, 5300]), { min: 0, max: 6000 });
  assert.deepEqual(escalaFaixa([-4800, 2100]), { min: -5000, max: 2500 });
  assert.deepEqual(escalaFaixa([-300, -120]), { min: -300, max: 0 });
  assert.deepEqual(escalaFaixa([]), { min: 0, max: 1 });
});

test('caminhoLinha: série com negativos, de min (base) a max (topo), pontos igualmente espaçados', () => {
  const area = { x0: 0, x1: 200, y0: 0, y1: 100 };
  // Faixa -100..100: o zero fica no meio (y=50).
  assert.equal(caminhoLinha([-100, 0, 100], -100, 100, area), 'M0,100 L100,50 L200,0');
  assert.equal(caminhoLinha([50], 0, 100, area), 'M0,50');
  assert.equal(caminhoLinha([], 0, 100, area), '');
});

test('lerReais: valor digitado no formato brasileiro (ou com ponto decimal)', () => {
  assert.equal(lerReais('4.000'), 4000);
  assert.equal(lerReais('1.299,90'), 1299.9);
  assert.equal(lerReais('R$ 350,5'), 350.5);
  assert.equal(lerReais('7200'), 7200);
  assert.equal(lerReais('89.90'), 89.9);
  assert.equal(lerReais(''), null);
  assert.equal(lerReais('abc'), null);
  assert.equal(lerReais('-10'), null);
});

test('marcasFaixa: zero sempre; o lado pequeno não ganha rótulos que se sobrepõem', () => {
  assert.deepEqual(marcasFaixa(-5000, 2500), [-5000, -2500, 0, 1250, 2500]);
  assert.deepEqual(marcasFaixa(-2500, 50000), [0, 25000, 50000]);
  assert.deepEqual(marcasFaixa(0, 6000), [0, 3000, 6000]);
  assert.deepEqual(marcasFaixa(-300, 0), [-300, -150, 0]);
});

test('percentual: quanto de um objetivo já foi juntado, de 0 a 100', () => {
  assert.equal(percentual('500.00', '2000.00'), 25);
  assert.equal(percentual('0.00', '2000.00'), 0);
  assert.equal(percentual('2500.00', '2000.00'), 100, 'passou do alvo: fica em 100');
  assert.equal(percentual('10', '0'), 0, 'sem alvo');
  assert.equal(percentual('1', '3'), 33.3, 'uma casa decimal');
});

test('primeiroBuraco: o 1º mês em que sobra dinheiro, mas o saldo acumulado continua negativo', () => {
  const meses = [
    { mes: '2027-02', sobra: '-442.09', saldo: '-6586.46' },
    { mes: '2027-03', sobra: '962.81', saldo: '-5623.65' },
    { mes: '2027-04', sobra: '1545.69', saldo: '-4077.96' },
  ];
  // A sobra de mar/27 diminui o buraco de 6.586,46 para 5.623,65 (valores sem sinal, para o texto).
  assert.deepEqual(primeiroBuraco(meses), { mes: '2027-03', sobra: '962.81', antes: '6586.46', depois: '5623.65' });
  assert.equal(primeiroBuraco([{ mes: '2027-01', sobra: '100.00', saldo: '100.00' }, { mes: '2027-02', sobra: '50.00', saldo: '150.00' }]), null);
  assert.equal(primeiroBuraco([{ mes: '2027-01', sobra: '-10.00', saldo: '-10.00' }, { mes: '2027-02', sobra: '-5.00', saldo: '-15.00' }]), null);
  assert.equal(primeiroBuraco([]), null);
});

// Meses seguidos a partir de `de` (AAAA-MM).
const seqMeses = (de: string, n: number) => Array.from({ length: n }, (_, i) => {
  const [a, m] = de.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(a, m - 1 + i, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
});

test('rotulosMeses: rótulos do eixo alinhados ao calendário, sem passar do limite', () => {
  assert.deepEqual(rotulosMeses(seqMeses('2026-11', 12), 13), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '12 meses: todos');
  // 24 meses com espaço para 13: de 2 em 2 (jan, mar, mai...), começando em nov/26.
  assert.deepEqual(rotulosMeses(seqMeses('2026-11', 24), 13), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  // 48 meses com espaço para 19: trimestres (jan, abr, jul, out); o 1º é jan/27.
  const tri = rotulosMeses(seqMeses('2026-11', 48), 19);
  assert.equal(tri.length, 16);
  assert.deepEqual(tri.slice(0, 3), [2, 5, 8]);
  // Com pouco espaço: semestres (jan e jul).
  assert.deepEqual(rotulosMeses(seqMeses('2026-11', 48), 8), [2, 8, 14, 20, 26, 32, 38, 44]);
  assert.deepEqual(rotulosMeses([], 10), []);
});

test('paginar: a tabela da previsão de 12 em 12 meses', () => {
  assert.deepEqual(paginar(12), [{ de: 0, ate: 12 }]);
  assert.deepEqual(paginar(30), [{ de: 0, ate: 12 }, { de: 12, ate: 24 }, { de: 24, ate: 30 }]);
  assert.equal(paginar(48).length, 4);
  assert.deepEqual(paginar(0), []);
});

test('paginaDoMes: em que página da tabela fica um mês (0 se não estiver)', () => {
  const meses = seqMeses('2026-11', 48).map((mes) => ({ mes }));
  assert.equal(paginaDoMes(meses, '2026-11'), 0);
  assert.equal(paginaDoMes(meses, '2027-10'), 0);
  assert.equal(paginaDoMes(meses, '2027-11'), 1);
  assert.equal(paginaDoMes(meses, '2030-10'), 3);
  assert.equal(paginaDoMes(meses, '2031-01'), 0);
});

test('situacaoTexto: quando vence, quando foi paga ou há quanto tempo atrasou', () => {
  const hoje = '2026-11-12';
  const it = (over: Record<string, unknown>) => ({ situacao: 'a_pagar', vencimento: '2026-11-12', pago_em: null, estimado: false, ...over }) as any;
  assert.equal(situacaoTexto(it({}), hoje), 'Vence hoje');
  assert.equal(situacaoTexto(it({ vencimento: '2026-11-13' }), hoje), 'Vence amanhã');
  assert.equal(situacaoTexto(it({ vencimento: '2026-12-03' }), hoje), 'Vence em 21 dias');
  assert.equal(situacaoTexto(it({ vencimento: '2026-11-20', estimado: true }), hoje), 'Vence em 8 dias · estimativa');
  assert.equal(situacaoTexto(it({ situacao: 'atrasada', vencimento: '2026-11-11' }), hoje), 'Atrasada há 1 dia');
  assert.equal(situacaoTexto(it({ situacao: 'atrasada', vencimento: '2026-11-07' }), hoje), 'Atrasada há 5 dias');
  assert.equal(situacaoTexto(it({ situacao: 'paga', pago_em: '2026-11-12' }), hoje), 'Paga em 12/11');
  assert.equal(situacaoTexto(it({ situacao: 'paga' }), hoje), 'Paga (marcada por você)');
  assert.equal(situacaoTexto(it({ situacao: 'paga', presumida: true, fora_do_saldo: true, vencimento: '2026-11-16' }), hoje),
    'Débito automático em 16/11 · ainda não aparece no banco');
  assert.equal(situacaoTexto(it({ situacao: 'paga', fora_do_saldo: true }), hoje), 'Paga (marcada por você) · ainda não aparece no banco');
  assert.equal(situacaoTexto(it({ situacao: 'a_confirmar', vencimento: '2026-11-11' }), hoje), 'Venceu em 11/11 · a confirmar: o banco ainda não mandou os dados desse dia');
});

test('sync pelo botão: espera o sync que começa depois do pedido (ou o que já estava rodando) terminar', () => {
  const st = (over: Record<string, unknown>) => ({ ultimo: { id: 7, status: 'success' }, pedido_pendente: false, rodando: false, bancos: [], ...over }) as any;
  assert.equal(syncEsperado(st({})), 8, 'o próximo');
  assert.equal(syncEsperado(st({ rodando: true, ultimo: { id: 7, status: 'running' } })), 7, 'o que já está rodando');
  assert.equal(syncEsperado(st({ ultimo: null })), 1);
  assert.equal(terminou(8, st({ pedido_pendente: true })), false);
  assert.equal(terminou(8, st({ ultimo: { id: 8, status: 'running' }, rodando: true })), false);
  assert.equal(terminou(8, st({ ultimo: { id: 8, status: 'success' } })), true);
});

test('mensagemSync: o que chegou, ou quando a Pluggy atualizou cada banco se nada chegou', () => {
  const bancos = [
    { conta: 'Banco A', atualizado_em: '2026-11-16T14:27:00.000Z' },
    { conta: 'Banco B', atualizado_em: '2026-11-16T20:17:00.000Z' },
  ];
  const st = (ultimo: Record<string, unknown>) => ({ ultimo: { id: 1, inseridas: 0, erro: null, ...ultimo }, pedido_pendente: false, rodando: false, bancos }) as any;
  assert.deepEqual(mensagemSync(st({ status: 'success', inseridas: 3 })), { texto: 'Sincronizado: 3 movimentações novas.', tipo: 'ok' });
  assert.deepEqual(mensagemSync(st({ status: 'success', inseridas: 1 })), { texto: 'Sincronizado: 1 movimentação nova.', tipo: 'ok' });
  assert.deepEqual(mensagemSync(st({ status: 'success' })), {
    texto: 'Sincronizado, nada novo: a Pluggy ainda não buscou dados mais recentes nos bancos. Última atualização: Banco A em 16/11 às 11:27, Banco B em 16/11 às 17:17. Para buscar agora, atualize a conexão no site do Meu Pluggy e sincronize de novo.',
    tipo: 'ok',
  });
  assert.deepEqual(mensagemSync(st({ status: 'error', erro: 'Credenciais da Pluggy recusadas.\noutra linha' })),
    { texto: 'O sync falhou: Credenciais da Pluggy recusadas.', tipo: 'erro' });
  assert.equal(mensagemSync(st({ status: 'partial', inseridas: 2, erro: 'Item abc…: fora do ar' })).tipo, 'erro');
});

test('larguraGrafico: a de sempre em tela larga; em tela estreita, a do espaço, para o texto não encolher', () => {
  assert.equal(larguraGrafico(0), 680); // ainda sem medida (antes de montar)
  assert.equal(larguraGrafico(900), 680);
  assert.equal(larguraGrafico(520), 680); // metade da grade no computador: fica como estava
  assert.equal(larguraGrafico(330), 330); // celular
  assert.equal(larguraGrafico(329.6), 330);
  assert.equal(larguraGrafico(266), 266); // celular de 320 px
  assert.equal(larguraGrafico(200), 240); // nunca menor que o mínimo
});

test('rotulosEspacados: um rótulo a cada tantos itens, sem se sobreporem', () => {
  assert.deepEqual(rotulosEspacados(12, 604), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // cabem todos
  assert.deepEqual(rotulosEspacados(12, 254), [0, 2, 4, 6, 8, 10]); // celular: de 2 em 2
  assert.deepEqual(rotulosEspacados(12, 120), [0, 4, 8]);
  assert.deepEqual(rotulosEspacados(0, 300), []);
});
