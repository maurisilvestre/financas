// Servidor MCP mínimo: JSON-RPC 2.0, uma mensagem por linha no stdin/stdout.
// Implementa só o que este servidor usa (ferramentas e prompts), sem o SDK oficial,
// que traria ~90 pacotes (express, hono...) para um servidor que só fala por stdio.
// Especificação: https://modelcontextprotocol.io/specification
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { errorMessage, log } from '../log.ts';
import { type Args, type ObjectSchema, ToolError, validateArgs } from './schema.ts';

/** Da mais nova para a mais antiga. Se o cliente pedir outra, respondemos com a primeira. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: ObjectSchema;
  annotations?: ToolAnnotations;
  /** Recebe os argumentos já validados (com defaults). O retorno vai para o modelo como JSON. */
  handler: (args: Args) => Promise<unknown>;
}

export interface PromptDef {
  name: string;
  title?: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  render: (args: Record<string, string>) => string;
}

export interface ServerSpec {
  name: string;
  version: string;
  instructions?: string;
  tools: ToolDef[];
  prompts?: PromptDef[];
}

type Id = string | number | null;
interface JsonRpcError { code: number; message: string }
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: JsonRpcError };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Trata uma mensagem já decodificada. Devolve a resposta, ou null para notificações. */
export function createMcpHandler(spec: ServerSpec): (message: unknown) => Promise<JsonRpcResponse | null> {
  const tools = new Map(spec.tools.map((t) => [t.name, t]));
  const prompts = new Map((spec.prompts ?? []).map((p) => [p.name, p]));

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    initialize: async (params) => {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ?? LATEST_PROTOCOL_VERSION;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: spec.name, version: spec.version },
        ...(spec.instructions ? { instructions: spec.instructions } : {}),
      };
    },
    ping: async () => ({}),
    'tools/list': async () => ({
      tools: spec.tools.map(({ handler: _handler, ...tool }) => tool),
    }),
    'tools/call': async (params) => {
      const tool = tools.get(String(params.name));
      if (!tool) throw new RpcError(INVALID_PARAMS, `Ferramenta desconhecida: ${String(params.name)}`);
      const started = Date.now();
      try {
        const args = validateArgs(tool.inputSchema, params.arguments);
        const data = await tool.handler(args);
        log.info(`Ferramenta ${tool.name}`, { ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (err) {
        if (!(err instanceof ToolError)) log.error(`Ferramenta ${tool.name} falhou`, { error: errorMessage(err) });
        const text = err instanceof ToolError ? err.message : `Erro ao executar ${tool.name}: ${errorMessage(err)}`;
        return { content: [{ type: 'text', text }], isError: true };
      }
    },
    'prompts/list': async () => ({
      prompts: (spec.prompts ?? []).map(({ render: _render, ...prompt }) => prompt),
    }),
    'prompts/get': async (params) => {
      const prompt = prompts.get(String(params.name));
      if (!prompt) throw new RpcError(INVALID_PARAMS, `Prompt desconhecido: ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Record<string, string>;
      return {
        description: prompt.description,
        messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }],
      };
    },
  };

  return async (message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Requisição inválida' } };
    }
    const msg = message as Record<string, unknown>;
    const id = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    const isRequest = 'id' in msg && typeof msg.method === 'string';

    if (msg.jsonrpc !== '2.0') {
      return 'id' in msg ? { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Esperado jsonrpc "2.0"' } } : null;
    }
    // Notificações (sem id) e respostas a pedidos nossos (sem method): nada a responder.
    if (!isRequest) return null;

    const method = methods[msg.method as string];
    if (!method) return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Método não suportado: ${String(msg.method)}` } };
    try {
      const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<string, unknown>;
      return { jsonrpc: '2.0', id, result: await method(params) };
    } catch (err) {
      const code = err instanceof RpcError ? err.code : INTERNAL_ERROR;
      return { jsonrpc: '2.0', id, error: { code, message: errorMessage(err) } };
    }
  };
}

/** Lê mensagens do input (uma por linha) e escreve as respostas no output até o input fechar. */
export async function serveStdio(spec: ServerSpec, input: Readable, output: Writable): Promise<void> {
  const handle = createMcpHandler(spec);
  const send = (response: JsonRpcResponse) => {
    output.write(`${JSON.stringify(response)}\n`);
  };
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const work = (async () => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'JSON inválido' } });
        return;
      }
      const response = await handle(message);
      if (response) send(response);
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
}
