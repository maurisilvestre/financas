// Espera do daemon até o próximo sync: o horário marcado ou um pedido do app, o que vier antes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esperarProximo } from '../src/scheduler.ts';

test('pedido do app interrompe a espera', async () => {
  let checagens = 0;
  const r = await esperarProximo(60_000, async () => ++checagens >= 2, new AbortController().signal, 5);
  assert.equal(r, 'app');
  assert.equal(checagens, 2);
});

test('sem pedido, roda no horário marcado', async () => {
  const r = await esperarProximo(20, async () => false, new AbortController().signal, 5);
  assert.equal(r, 'schedule');
});

test('checagem que falha (banco fora do ar) não derruba a espera', async () => {
  const r = await esperarProximo(20, async () => { throw new Error('sem conexão'); }, new AbortController().signal, 5);
  assert.equal(r, 'schedule');
});

test('encerrar o daemon interrompe a espera', async () => {
  const c = new AbortController();
  setTimeout(() => c.abort(), 10);
  assert.equal(await esperarProximo(60_000, async () => false, c.signal, 1_000), null);
});
