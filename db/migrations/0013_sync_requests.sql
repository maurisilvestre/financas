-- Botão "Sincronizar" do app. O app (papel fin_mcp) não tem as credenciais da Pluggy: só registra
-- o pedido aqui. O daemon do sync confere a cada 10 s e roda. O pedido está pendente enquanto
-- nenhum sync começou depois dele; o sync não escreve nesta tabela.
CREATE TABLE fin.sync_requests (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_at  timestamptz NOT NULL DEFAULT now()
);

-- As execuções do sync para o app: quando, como terminou, quantas movimentações novas e o erro
-- (que já vem com ids encurtados), sem o resto das estatísticas.
CREATE VIEW fin.v_sync_runs AS
SELECT
  r.id,
  r.trigger,
  r.status,
  r.started_at,
  r.finished_at,
  coalesce((SELECT sum((a ->> 'inserted')::int) FROM jsonb_array_elements(r.stats -> 'accounts') AS a), 0)::int AS inserted,
  coalesce(jsonb_array_length(r.stats -> 'warnings'), 0) AS warnings,
  r.error
FROM fin.sync_runs r;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_mcp') THEN
    GRANT SELECT, INSERT ON fin.sync_requests TO fin_mcp;
  END IF;
END $$;
