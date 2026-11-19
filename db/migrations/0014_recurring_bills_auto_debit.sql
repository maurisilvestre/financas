-- Contas fixas em débito automático (luz, água...): passado o vencimento, contam como
-- pagas mesmo antes de o débito aparecer nos dados do banco, e o valor sai do saldo mostrado (que é
-- da última atualização da Pluggy). Se o banco mandar os dados do dia e o débito não estiver lá,
-- voltam a "atrasada". paid_marked_at: quando o usuário marcou "já paguei"; se foi depois da
-- última atualização do banco, o saldo ainda não mostra esse pagamento.
ALTER TABLE fin.recurring_bills
  ADD COLUMN auto_debit boolean NOT NULL DEFAULT false,
  ADD COLUMN paid_marked_at timestamptz;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') THEN
    GRANT UPDATE (auto_debit, paid_marked_at) ON fin.recurring_bills TO fin_mcp;
  END IF;
END $$;
