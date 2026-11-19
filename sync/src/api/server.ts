// API e front do app web, em node:http, sem framework.
//
// É uma API local e sem login, então a defesa é não deixar outro site falar com ela:
//  * só responde se o Host for 127.0.0.1, localhost ou [::1] (contra DNS rebinding), ou um nome
//    de WEB_ALLOWED_HOSTS, para quem chega por um proxy HTTPS da própria rede (tailscale serve);
//  * escrita só com Content-Type JSON e Origin igual ao do próprio app (contra CSRF): http://<Host>
//    no acesso local, https://<Host> (com a porta) pelos nomes do proxy;
//  * sem CORS: OPTIONS (preflight) responde 405, então outra origem não lê nada;
//  * corpo limitado a 64 KB; arquivos estáticos só de dentro da pasta do front;
//  * a leitura usa fin_readonly e a escrita, o papel restrito fin_mcp (ver queries.ts).
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { UserError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { type Args, argsFromQuery, type ObjectSchema, validateArgs } from '../mcp/schema.ts';
import * as q from '../queries.ts';

const MAX_BODY = 64 * 1024;
const DEFAULT_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const COMMON_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  schema: ObjectSchema;
  /** Parâmetros que vêm do caminho (ex.: o id da transação). */
  fromPath?: (match: RegExpMatchArray) => Record<string, unknown>;
  run: (args: Args) => Promise<unknown>;
}

function buildRoutes(pools: q.Pools): Route[] {
  const { read } = pools;
  const S = q.SCHEMAS;
  const txId = (m: RegExpMatchArray) => ({ transacao_id: Number(m[1]) });
  const id = (m: RegExpMatchArray) => ({ id: Number(m[1]) });
  return [
    { method: 'GET', pattern: /^\/api\/visao$/, schema: S.visaoDoMes, run: (a) => q.visaoDoMes(read, a) },
    { method: 'GET', pattern: /^\/api\/resumo$/, schema: S.resumoMensal, run: (a) => q.resumoMensal(read, a) },
    { method: 'GET', pattern: /^\/api\/gastos-por-categoria$/, schema: S.gastosPorCategoria, run: (a) => q.gastosPorCategoria(read, a) },
    { method: 'GET', pattern: /^\/api\/transacoes$/, schema: S.buscarTransacoes, run: (a) => q.buscarTransacoes(read, a) },
    { method: 'GET', pattern: /^\/api\/recorrentes$/, schema: S.gastosRecorrentes, run: (a) => q.gastosRecorrentes(read, a) },
    { method: 'GET', pattern: /^\/api\/compromissos$/, schema: S.compromissosFuturos, run: () => q.compromissosFuturos(read) },
    { method: 'GET', pattern: /^\/api\/contas$/, schema: S.contas, run: () => q.contas(read) },
    { method: 'GET', pattern: /^\/api\/faturas$/, schema: S.faturas, run: (a) => q.faturas(read, a) },
    { method: 'GET', pattern: /^\/api\/categorias$/, schema: S.categorias, run: () => q.categorias(read) },
    { method: 'GET', pattern: /^\/api\/regras\/previa$/, schema: S.previaRegra, run: (a) => q.previaRegra(read, a) },
    { method: 'POST', pattern: /^\/api\/regras$/, schema: S.criarRegra, run: (a) => q.criarRegra(pools, a) },
    { method: 'GET', pattern: /^\/api\/meta$/, schema: S.meta, run: () => q.meta(read) },
    { method: 'POST', pattern: /^\/api\/meta$/, schema: S.definirMeta, run: (a) => q.definirMeta(pools, a) },
    { method: 'GET', pattern: /^\/api\/meta\/acompanhamento$/, schema: S.acompanhamentoMeta, run: (a) => q.acompanhamentoMeta(read, a) },
    { method: 'GET', pattern: /^\/api\/parcelamentos\/novos$/, schema: S.parcelamentosNovos, run: (a) => q.parcelamentosNovos(read, a) },
    { method: 'GET', pattern: /^\/api\/previsao$/, schema: S.previsao, run: (a) => q.previsao(read, a) },
    { method: 'POST', pattern: /^\/api\/previsao\/exclusoes$/, schema: S.excluirDaPrevisao, run: (a) => q.excluirDaPrevisao(pools, a) },
    { method: 'POST', pattern: /^\/api\/previsao\/exclusoes\/(\d{1,12})\/remover$/, schema: S.removerExclusao, fromPath: id, run: (a) => q.removerExclusao(pools, a) },
    { method: 'POST', pattern: /^\/api\/planejados$/, schema: S.planejarGasto, run: (a) => q.planejarGasto(pools, a) },
    { method: 'POST', pattern: /^\/api\/planejados\/(\d{1,12})\/status$/, schema: S.atualizarPlanejado, fromPath: id, run: (a) => q.atualizarPlanejado(pools, a) },
    { method: 'GET', pattern: /^\/api\/sync$/, schema: S.statusSync, run: (a) => q.statusSync(read, a) },
    { method: 'POST', pattern: /^\/api\/sync$/, schema: S.pedirSync, run: (a) => q.pedirSync(pools, a) },
    { method: 'GET', pattern: /^\/api\/a-pagar$/, schema: S.aPagar, run: (a) => q.aPagar(read, a) },
    { method: 'POST', pattern: /^\/api\/contas-fixas$/, schema: S.criarContaFixa, run: (a) => q.criarContaFixa(pools, a) },
    { method: 'POST', pattern: /^\/api\/contas-fixas\/(\d{1,12})$/, schema: S.atualizarContaFixa, fromPath: id, run: (a) => q.atualizarContaFixa(pools, a) },
    { method: 'POST', pattern: /^\/api\/objetivos$/, schema: S.criarObjetivo, run: (a) => q.criarObjetivo(pools, a) },
    { method: 'POST', pattern: /^\/api\/objetivos\/(\d{1,12})$/, schema: S.atualizarObjetivo, fromPath: id, run: (a) => q.atualizarObjetivo(pools, a) },
    { method: 'GET', pattern: /^\/api\/sugestoes$/, schema: S.sugestoes, run: () => q.sugestoes(read) },
    { method: 'POST', pattern: /^\/api\/sugestoes\/aplicar$/, schema: S.aplicarSugestao, run: (a) => q.aplicarSugestao(pools, a) },
    { method: 'POST', pattern: /^\/api\/sugestoes\/recusar$/, schema: S.recusarSugestao, run: (a) => q.recusarSugestao(pools, a) },
    { method: 'POST', pattern: /^\/api\/sugestoes\/aplicar-confiaveis$/, schema: S.aplicarConfiaveis, run: (a) => q.aplicarConfiaveis(pools, a) },
    { method: 'POST', pattern: /^\/api\/transacoes\/(\d{1,12})\/categoria$/, schema: S.definirCategoria, fromPath: txId, run: (a) => q.definirCategoria(pools, a) },
    { method: 'POST', pattern: /^\/api\/transacoes\/(\d{1,12})\/ignorar$/, schema: S.ignorarTransacao, fromPath: txId, run: (a) => q.ignorarTransacao(pools, a) },
  ];
}

function sendJson(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...COMMON_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

const notFound = (res: ServerResponse) => sendJson(res, 404, { erro: 'Não encontrado' });

const NOME_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * WEB_ALLOWED_HOSTS: nomes separados por vírgula, aceitos além dos locais, para o acesso por um
 * proxy HTTPS (ex.: tailscale serve). Sem curinga, esquema ou caminho; a porta é ignorada.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((h) => h.trim()).filter(Boolean).map((h) => {
    const nome = hostnameOf(h);
    if (!NOME_HOST.test(nome) || /[/\s*]/.test(h) || h.includes('://')) {
      throw new Error(`WEB_ALLOWED_HOSTS: "${h}" não é um nome de host (ex.: servidor.tail0000.ts.net).`);
    }
    if (DEFAULT_HOSTNAMES.includes(nome)) throw new Error(`WEB_ALLOWED_HOSTS: "${h}" já é aceito; deixe só os nomes do proxy.`);
    return nome;
  });
}

/** "127.0.0.1:8080" → "127.0.0.1"; "[::1]:8080" → "[::1]". */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? '';
}

function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY) return Promise.reject(new UserError('Corpo da requisição grande demais.', 413));
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk); // passou do limite: só drena
    });
    req.on('end', () => (size > MAX_BODY
      ? reject(new UserError('Corpo da requisição grande demais.', 413))
      : resolveBody(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

export interface WebOptions {
  pools: q.Pools;
  /** Pasta com o front compilado (index.html + assets). null = só a API. */
  staticDir: string | null;
  allowedHostnames?: string[];
  /** Nomes aceitos além dos locais, atrás de um proxy HTTPS (WEB_ALLOWED_HOSTS): exigem Origin https. */
  proxyHostnames?: string[];
}

export function createWebHandler(opts: WebOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = buildRoutes(opts.pools);
  const proxy = new Set(opts.proxyHostnames ?? []);
  const hostnames = new Set([...(opts.allowedHostnames ?? DEFAULT_HOSTNAMES), ...proxy]);
  const staticRoot = opts.staticDir ? resolve(opts.staticDir) : null;

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const matching = routes.filter((r) => r.pattern.test(url.pathname));
    if (matching.length === 0) return notFound(res);
    const route = matching.find((r) => r.method === req.method);
    if (!route) return sendJson(res, 405, { erro: 'Método não permitido' }, { allow: matching.map((r) => r.method).join(', ') });

    let args: Args;
    if (route.method === 'POST') {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return sendJson(res, 415, { erro: 'Envie JSON (Content-Type: application/json).' });
      // Origem = o próprio app: http no acesso local; https pelos nomes do proxy (TLS termina nele).
      const esquema = proxy.has(hostnameOf(req.headers.host ?? '')) ? 'https' : 'http';
      if (req.headers.origin !== `${esquema}://${req.headers.host}`) return sendJson(res, 403, { erro: 'Origem não permitida.' });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err instanceof UserError) throw err;
        throw new UserError('JSON inválido.');
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new UserError('O corpo deve ser um objeto JSON.');
      args = validateArgs(route.schema, { ...body, ...route.fromPath?.(url.pathname.match(route.pattern)!) });
    } else {
      args = argsFromQuery(route.schema, url.searchParams);
    }
    sendJson(res, 200, await route.run(args));
  }

  async function serveStatic(res: ServerResponse, pathname: string, headOnly: boolean): Promise<void> {
    if (!staticRoot) return notFound(res);
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return notFound(res);
    }
    if (rel.includes('\0')) return notFound(res);
    if (rel === '/') rel = '/index.html';
    const file = resolve(staticRoot, `.${rel}`);
    if (!file.startsWith(staticRoot + sep)) return notFound(res);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return notFound(res);

    const body = await readFile(file);
    const ext = extname(file);
    const headers: Record<string, string | number> = {
      ...COMMON_HEADERS,
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': body.length,
    };
    if (ext === '.html') {
      headers['content-security-policy'] = CSP;
      headers['x-frame-options'] = 'DENY';
      headers['cache-control'] = 'no-cache';
    } else {
      // Os arquivos de /assets têm hash no nome (Vite): podem ficar em cache para sempre.
      headers['cache-control'] = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(headOnly ? undefined : body);
  }

  return async (req, res) => {
    const started = Date.now();
    let pathname = '?';
    try {
      if (!hostnames.has(hostnameOf(req.headers.host ?? ''))) {
        sendJson(res, 403, { erro: 'Host não permitido.' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://app.local');
      pathname = url.pathname;
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(res, pathname, req.method === 'HEAD');
      } else {
        sendJson(res, 405, { erro: 'Método não permitido' });
      }
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
      } else if (err instanceof UserError) {
        sendJson(res, err.status, { erro: err.message }, err.status === 413 ? { connection: 'close' } : {});
      } else {
        log.error('Erro na API', { path: pathname, error: errorMessage(err) });
        sendJson(res, 500, { erro: 'Erro interno. Veja os logs do serviço web.' });
      }
    } finally {
      log.debug(`${req.method} ${pathname} ${res.statusCode}`, { ms: Date.now() - started });
    }
  };
}

export async function startWebServer(opts: WebOptions & { host: string; port: number }): Promise<Server> {
  const handler = createWebHandler(opts);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  return server;
}
