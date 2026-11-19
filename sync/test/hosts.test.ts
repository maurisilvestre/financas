// WEB_ALLOWED_HOSTS: nomes extras aceitos pela API, atrás de um proxy HTTPS (tailscale serve).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAllowedHosts } from '../src/api/server.ts';

test('lê nomes separados por vírgula, sem porta, em minúsculas', () => {
  assert.deepEqual(parseAllowedHosts('servidor.tail0000.ts.net'), ['servidor.tail0000.ts.net']);
  assert.deepEqual(parseAllowedHosts(' Servidor.Tail0000.ts.net:8443 , casa.local '), ['servidor.tail0000.ts.net', 'casa.local']);
  assert.deepEqual(parseAllowedHosts(''), []);
  assert.deepEqual(parseAllowedHosts(undefined), []);
});

test('recusa curinga, esquema, espaço e nomes padrão (que já são aceitos)', () => {
  for (const ruim of ['*', '*.ts.net', 'https://servidor.ts.net', 'a b', 'servidor.ts.net/x']) {
    assert.throws(() => parseAllowedHosts(ruim), /WEB_ALLOWED_HOSTS/, ruim);
  }
  assert.throws(() => parseAllowedHosts('localhost'), /WEB_ALLOWED_HOSTS/);
});
