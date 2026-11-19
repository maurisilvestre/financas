// Protocolo MCP (JSON-RPC 2.0 sobre stdio), sem banco: ferramentas e prompts falsos.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { log, logToStderr } from '../src/log.ts';
import { LATEST_PROTOCOL_VERSION, createMcpHandler, serveStdio, type ServerSpec } from '../src/mcp/protocol.ts';
import { ToolError } from '../src/mcp/schema.ts';

const noArgs = { type: 'object', properties: {}, additionalProperties: false } as const;

const spec: ServerSpec = {
  name: 'teste',
  version: '0.0.1',
  instructions: 'instruções do servidor',
  tools: [
    {
      name: 'eco',
      description: 'Devolve o texto repetido',
      inputSchema: {
        type: 'object',
        properties: {
          texto: { type: 'string', minLength: 1 },
          vezes: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
          modo: { type: 'string', enum: ['a', 'b'] },
          mes: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
          ligado: { type: 'boolean' },
          valor: { type: 'number', minimum: 0 },
        },
        required: ['texto'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => ({ texto: String(args.texto).repeat(args.vezes as number), args }),
    },
    { name: 'falha_esperada', description: 'x', inputSchema: noArgs, handler: async () => { throw new ToolError('Categoria "x" não existe'); } },
    { name: 'falha_inesperada', description: 'x', inputSchema: noArgs, handler: async () => { throw new Error('conexão caiu'); } },
  ],
  prompts: [
    { name: 'dica', description: 'Uma dica', arguments: [{ name: 'meses', description: 'Quantos meses' }], render: (a) => `Analise ${a.meses ?? '3'} meses` },
  ],
};

const handle = createMcpHandler(spec);
// Respostas JSON-RPC são dados soltos; nos testes basta acessar os campos (any).
const req = async (id: number, method: string, params?: unknown): Promise<any> =>
  handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const callTool = async (name: string, args?: unknown): Promise<any> => (await req(9, 'tools/call', { name, arguments: args })).result;
const textOf = (result: { content: Array<{ type: string; text: string }> }) => result.content[0]!.text;

test('initialize: aceita a versão pedida pelo cliente quando suportada', async () => {
  const r = await req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(Object.keys(r.result.capabilities).sort(), ['prompts', 'tools']);
  assert.deepEqual(r.result.serverInfo, { name: 'teste', version: '0.0.1' });
  assert.equal(r.result.instructions, 'instruções do servidor');
});

test('initialize: versão desconhecida → responde com a mais recente que o servidor suporta', async () => {
  const r = await req(1, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(r.result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

test('notificações e respostas do cliente não geram resposta', async () => {
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handle({ jsonrpc: '2.0', id: 3, result: {} }), null);
});

test('ping responde vazio; método desconhecido é -32601', async () => {
  assert.deepEqual(await req(4, 'ping'), { jsonrpc: '2.0', id: 4, result: {} });
  assert.equal((await req(5, 'resources/list')).error.code, -32601);
});

test('mensagem que não é JSON-RPC 2.0 é -32600', async () => {
  assert.equal(((await handle({ id: 6, method: 'ping' })) as { error: { code: number } }).error.code, -32600);
});

test('tools/list expõe nome, descrição, schema e anotações', async () => {
  const { tools } = (await req(7, 'tools/list')).result;
  assert.deepEqual(tools.map((t: { name: string }) => t.name), ['eco', 'falha_esperada', 'falha_inesperada']);
  assert.equal(tools[0].inputSchema.type, 'object');
  assert.deepEqual(tools[0].annotations, { readOnlyHint: true });
  assert.equal('handler' in tools[0], false);
});

test('tools/call: aplica default e devolve o resultado como JSON em texto', async () => {
  const result = await callTool('eco', { texto: 'ab' });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(textOf(result)), { texto: 'ab', args: { texto: 'ab', vezes: 1 } });
});

test('tools/call: sem "arguments" vale como objeto vazio', async () => {
  const result = await callTool('falha_esperada');
  assert.equal(result.isError, true);
});

test('tools/call: argumentos inválidos viram isError com mensagem que cita o parâmetro', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ texto: 'a', vezes: 9 }, /vezes/],
    [{ texto: 'a', vezes: 1.5 }, /vezes/],
    [{ texto: 'a', extra: 1 }, /extra/],
    [{}, /texto/],
    [{ texto: 5 }, /texto/],
    [{ texto: '' }, /texto/],
    [{ texto: 'a', modo: 'c' }, /modo/],
    [{ texto: 'a', mes: '2026-1' }, /mes/],
    [{ texto: 'a', ligado: 'sim' }, /ligado/],
    [{ texto: 'a', valor: -1 }, /valor/],
    ['nao-e-objeto', /objeto/],
  ];
  for (const [args, re] of cases) {
    const result = await callTool('eco', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), re, JSON.stringify(args));
  }
});

test('tools/call: ToolError e erro inesperado viram isError, sem derrubar o servidor', async () => {
  const expected = await callTool('falha_esperada', {});
  assert.deepEqual([expected.isError, textOf(expected)], [true, 'Categoria "x" não existe']);
  const unexpected = await callTool('falha_inesperada', {});
  assert.equal(unexpected.isError, true);
  assert.match(textOf(unexpected), /conexão caiu/);
  assert.equal((await req(10, 'ping')).result !== undefined, true);
});

test('tools/call: ferramenta desconhecida é erro de protocolo -32602', async () => {
  assert.equal((await req(11, 'tools/call', { name: 'nao_existe', arguments: {} })).error.code, -32602);
});

test('prompts/list e prompts/get', async () => {
  const { prompts } = (await req(12, 'prompts/list')).result;
  assert.deepEqual(prompts, [{ name: 'dica', description: 'Uma dica', arguments: [{ name: 'meses', description: 'Quantos meses' }] }]);
  const got = (await req(13, 'prompts/get', { name: 'dica', arguments: { meses: '6' } })).result;
  assert.deepEqual(got.messages, [{ role: 'user', content: { type: 'text', text: 'Analise 6 meses' } }]);
  assert.equal((await req(14, 'prompts/get', { name: 'nao_existe' })).error.code, -32602);
});

test('serveStdio: uma mensagem por linha; JSON inválido vira -32700; notificação fica sem resposta', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let received = '';
  output.on('data', (chunk: Buffer) => { received += chunk.toString('utf8'); });
  const done = serveStdio(spec, input, output);
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write('isso não é json\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('\n');
  input.end();
  await done;
  const lines = received.trim().split('\n').map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.find((l) => l.id === 1), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(lines.find((l) => l.id === null)?.error?.code, -32700);
});

test('logToStderr: o log não escreve no stdout (o stdout é do protocolo)', () => {
  const out = process.stdout.write;
  const err = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((s: string) => { stdout += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { stderr += s; return true; }) as typeof process.stderr.write;
  try {
    logToStderr();
    log.info('mensagem de teste');
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  assert.equal(stdout, '');
  assert.match(stderr, /mensagem de teste/);
});
