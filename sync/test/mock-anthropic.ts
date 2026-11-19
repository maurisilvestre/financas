// Servidor HTTP que imita POST /v1/messages da API da Anthropic, para testar a classificação
// sem rede e sem custo. Guarda os corpos recebidos para conferir o que foi enviado.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockReply {
  status?: number;
  body: unknown;
}

export interface MockAnthropic {
  url: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}

/** Mensagem no formato da API, com um bloco de texto. */
export function message(text: string, stopReason = 'end_turn'): unknown {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content: [{ type: 'text', text }], stop_reason: stopReason, stop_sequence: null, stop_details: null,
    usage: { input_tokens: 120, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

export async function startMockAnthropic(handler: (body: Record<string, any>) => MockReply): Promise<MockAnthropic> {
  const requests: Array<Record<string, any>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    requests.push(body);
    const reply = handler(body);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
