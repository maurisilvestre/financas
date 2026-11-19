-- Permissões do papel do MCP (fin_mcp).
--
-- O MCP lê com fin_readonly e escreve com fin_mcp, que só pode o necessário para as duas
-- ferramentas de escrita: definir a categoria de uma transação (transaction_overrides) e
-- criar uma regra (category_rules). Sem DELETE e sem acesso às tabelas da Pluggy.
-- (SELECT nessas duas tabelas é exigido pelo ON CONFLICT DO UPDATE e pelo RETURNING.)
--
-- O papel é criado por db/init/02-mcp-role.sh, que roda como superusuário. Se ele ainda
-- não existir, esta migration não faz nada, e o script aplica as mesmas permissões depois.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') THEN
    GRANT USAGE ON SCHEMA fin TO fin_mcp;
    GRANT SELECT, INSERT, UPDATE ON fin.transaction_overrides TO fin_mcp;
    GRANT SELECT, INSERT ON fin.category_rules TO fin_mcp;
  ELSE
    RAISE NOTICE 'Papel fin_mcp não existe: permissões do MCP ficam para db/init/02-mcp-role.sh';
  END IF;
END $$;
