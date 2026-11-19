import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argsFromQuery, type ObjectSchema } from '../src/mcp/schema.ts';

const schema: ObjectSchema = {
  type: 'object',
  properties: {
    texto: { type: 'string', minLength: 2 },
    limite: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    valor_min: { type: 'number', minimum: 0 },
    sem_categoria: { type: 'boolean', default: false },
  },
  additionalProperties: false,
};

test('argsFromQuery: converte números e booleanos da URL e aplica defaults', () => {
  const args = argsFromQuery(schema, new URLSearchParams('texto=uber&limite=20&valor_min=10.5&sem_categoria=true'));
  assert.deepEqual(args, { texto: 'uber', limite: 20, valor_min: 10.5, sem_categoria: true });
  assert.deepEqual(argsFromQuery(schema, new URLSearchParams('')), { limite: 100, sem_categoria: false });
});

test('argsFromQuery: parâmetro vazio vale como ausente', () => {
  assert.deepEqual(argsFromQuery(schema, new URLSearchParams('texto=&limite=')), { limite: 100, sem_categoria: false });
});

test('argsFromQuery: valor que não converte vira erro que cita o parâmetro', () => {
  assert.throws(() => argsFromQuery(schema, new URLSearchParams('limite=abc')), /limite/);
  assert.throws(() => argsFromQuery(schema, new URLSearchParams('sem_categoria=talvez')), /sem_categoria/);
  assert.throws(() => argsFromQuery(schema, new URLSearchParams('outro=1')), /outro/);
  assert.throws(() => argsFromQuery(schema, new URLSearchParams('limite=1&limite=2')), /limite/);
});
