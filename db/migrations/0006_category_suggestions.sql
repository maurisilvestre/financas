-- Sugestões de categoria feitas por IA (Claude Haiku) para o que nenhuma regra pegou.
--
-- É uma terceira camada, separada dos dados da Pluggy e das decisões do usuário: a sugestão
-- não muda nenhum relatório. Só vale quando o usuário aplica (vira override) ou cria uma
-- regra a partir dela. Para a IA vão só descrição, valor e data (ver sync/src/classify.ts).
--
-- Uma sugestão por "estabelecimento": a chave é a descrição normalizada, sem números nem
-- barras ("Eletrorastro 4/6" e "Eletrorastro 5/6" têm a mesma chave).

CREATE FUNCTION fin.suggestion_key(description text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT trim(regexp_replace(regexp_replace(fin.norm_text(description), '[0-9/]+', ' ', 'g'), '\s+', ' ', 'g')) $$;

GRANT EXECUTE ON FUNCTION fin.suggestion_key(text) TO fin_readonly;

CREATE TABLE fin.category_suggestions (
  key          text PRIMARY KEY,
  example      text NOT NULL,                       -- uma descrição como veio do banco
  category_id  bigint REFERENCES fin.categories(id) ON DELETE CASCADE, -- NULL = a IA não soube
  confidence   numeric(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason       text,
  model        text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);

-- Sugestões que ainda servem: com categoria, não recusadas e com transações sem categoria
-- (que não foram ignoradas). Uma linha por estabelecimento.
CREATE VIEW fin.v_suggestions AS
SELECT
  s.key,
  s.example,
  s.category_id,
  c.name                      AS category,
  c.color                     AS color,
  s.confidence,
  s.reason,
  s.model,
  s.status,
  count(t.id)::int            AS transactions,
  sum(t.signed_amount)        AS total,
  max(t.local_date)           AS last_date
FROM fin.category_suggestions s
JOIN fin.categories c ON c.id = s.category_id
JOIN fin.v_transactions t
  ON fin.suggestion_key(t.bank_description) = s.key AND t.category_id IS NULL AND NOT t.ignored
WHERE s.status <> 'rejected'
GROUP BY s.key, s.example, s.category_id, c.name, c.color, s.confidence, s.reason, s.model, s.status;

-- O app web e o MCP (papel fin_mcp) só marcam a sugestão como aplicada ou recusada.
-- Quem grava sugestões é o classificador, com fin_app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') THEN
    GRANT SELECT ON fin.category_suggestions TO fin_mcp;
    GRANT UPDATE (status, decided_at) ON fin.category_suggestions TO fin_mcp;
  END IF;
END $$;
