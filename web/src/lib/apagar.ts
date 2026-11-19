// Textos da tela "A pagar".
import { dataCurta } from './format.ts';

interface ItemSituacao {
  situacao: 'paga' | 'a_pagar' | 'atrasada' | 'a_confirmar';
  vencimento: string;
  pago_em: string | null;
  estimado: boolean;
  presumida?: boolean;
  fora_do_saldo?: boolean;
}

/** Dias de `de` até `ate` (AAAA-MM-DD), sem fuso. */
function dias(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000);
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** "Vence amanhã", "Atrasada há 2 dias", "Paga em 12/11"... */
export function situacaoTexto(item: ItemSituacao, hoje: string): string {
  if (item.situacao === 'paga') {
    if (item.presumida) return `Débito automático em ${dataCurta(item.vencimento)} · ainda não aparece no banco`;
    const texto = item.pago_em ? `Paga em ${dataCurta(item.pago_em)}` : 'Paga (marcada por você)';
    return item.fora_do_saldo ? `${texto} · ainda não aparece no banco` : texto;
  }
  if (item.situacao === 'a_confirmar') return `Venceu em ${dataCurta(item.vencimento)} · a confirmar: o banco ainda não mandou os dados desse dia`;
  if (item.situacao === 'atrasada') return `Atrasada há ${plural(dias(item.vencimento, hoje), 'dia', 'dias')}`;
  const n = dias(hoje, item.vencimento);
  const quando = n <= 0 ? 'Vence hoje' : n === 1 ? 'Vence amanhã' : `Vence em ${n} dias`;
  return item.estimado ? `${quando} · estimativa` : quando;
}
