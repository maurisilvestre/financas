/**
 * Erro causado por um pedido inválido (categoria que não existe, transação não encontrada,
 * parâmetro errado). A mensagem é para quem pediu: o MCP a devolve ao modelo e a API, ao
 * front, com o status HTTP informado.
 */
export class UserError extends Error {
  override name = 'UserError';
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
