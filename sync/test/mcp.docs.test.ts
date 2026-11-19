// O guia do MCP (docs/mcp.md) precisa citar toda ferramenta e todo prompt: ferramenta nova sem
// documentação quebra este teste.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildServer } from '../src/mcp/tools.ts';

const guia = readFileSync(new URL('../../docs/mcp.md', import.meta.url), 'utf8');
const servidor = buildServer({ read: {} as never, write: {} as never });

test('docs/mcp.md documenta todas as ferramentas', () => {
  const faltam = servidor.tools.map((t) => t.name).filter((n) => !guia.includes(`\`${n}\``));
  assert.deepEqual(faltam, []);
});

test('docs/mcp.md documenta todos os prompts', () => {
  const faltam = (servidor.prompts ?? []).map((p) => p.name.replaceAll('_', ' ')).filter((n) => !guia.includes(`**${n}**`));
  assert.deepEqual(faltam, []);
});
