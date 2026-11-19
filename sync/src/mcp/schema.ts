// Subconjunto de JSON Schema usado pelo MCP e pela API: o mesmo objeto é anunciado ao
// cliente do MCP (inputSchema) e usado aqui para validar os argumentos antes de chegar ao banco.
import { UserError } from '../errors.ts';

/** Erro esperado de uma ferramenta: vira resultado com isError e esta mensagem, para o modelo corrigir. */
export { UserError as ToolError };

export interface PropSchema {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  enum?: readonly string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
}

export interface ObjectSchema {
  type: 'object';
  properties: Readonly<Record<string, PropSchema>>;
  required?: readonly string[];
  additionalProperties: false;
}

export type Args = Record<string, string | number | boolean | undefined>;

/**
 * Argumentos vindos da URL (API): tudo chega como texto. Converte números e booleanos
 * conforme o schema e valida. Parâmetro vazio vale como ausente; repetido é erro.
 */
export function argsFromQuery(schema: ObjectSchema, params: URLSearchParams): Args {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (values.length > 1) throw new UserError(`Parâmetro "${key}" repetido.`);
    const value = values[0]!;
    if (value === '') continue;
    const prop = schema.properties[key];
    if (prop?.type === 'integer' || prop?.type === 'number') {
      raw[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    } else if (prop?.type === 'boolean') {
      raw[key] = value === 'true' ? true : value === 'false' ? false : value;
    } else {
      raw[key] = value;
    }
  }
  return validateArgs(schema, raw);
}

/** Valida os argumentos e aplica os defaults. Lança ToolError com a mensagem para o modelo. */
export function validateArgs(schema: ObjectSchema, input: unknown): Args {
  const raw = input ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new UserError('Os argumentos devem ser um objeto.');
  const given = raw as Record<string, unknown>;

  for (const key of Object.keys(given)) {
    if (!(key in schema.properties)) {
      throw new UserError(`Parâmetro desconhecido "${key}". Aceitos: ${Object.keys(schema.properties).join(', ') || 'nenhum'}.`);
    }
  }

  const out: Args = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const value = given[key];
    if (value === undefined || value === null) {
      if (schema.required?.includes(key)) throw new UserError(`Parâmetro "${key}" é obrigatório.`);
      if (prop.default !== undefined) out[key] = prop.default;
      continue;
    }
    out[key] = checkProp(key, prop, value);
  }
  return out;
}

function checkProp(key: string, prop: PropSchema, value: unknown): string | number | boolean {
  const fail = (what: string): never => {
    throw new UserError(`Parâmetro "${key}": ${what}.`);
  };
  switch (prop.type) {
    case 'boolean':
      if (typeof value !== 'boolean') fail('deve ser true ou false');
      return value as boolean;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('deve ser um número');
      const num = value as number;
      if (prop.type === 'integer' && !Number.isInteger(num)) fail('deve ser um número inteiro');
      if (prop.minimum !== undefined && num < prop.minimum) fail(`deve ser no mínimo ${prop.minimum}`);
      if (prop.maximum !== undefined && num > prop.maximum) fail(`deve ser no máximo ${prop.maximum}`);
      return num;
    }
    case 'string': {
      if (typeof value !== 'string') fail('deve ser um texto');
      const str = value as string;
      if (prop.minLength !== undefined && str.length < prop.minLength) fail(`deve ter pelo menos ${prop.minLength} caractere(s)`);
      if (prop.maxLength !== undefined && str.length > prop.maxLength) fail(`deve ter no máximo ${prop.maxLength} caracteres`);
      if (prop.enum && !prop.enum.includes(str)) fail(`deve ser um de: ${prop.enum.join(', ')}`);
      if (prop.pattern && !new RegExp(prop.pattern).test(str)) fail(`formato inválido${prop.description ? ` (${prop.description})` : ''}`);
      return str;
    }
  }
}
