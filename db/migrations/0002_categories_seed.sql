-- Categorias iniciais e regras básicas. São só um ponto de partida: renomeie,
-- apague ou crie as suas. A categoria automática da Pluggy exige plano Pro,
-- então no Meu Pluggy a categorização é feita por estas regras.
--
-- kind:
--   expense  -> entra nos gastos
--   income   -> entra nas receitas
--   transfer -> fica fora de gastos e receitas (pagamento de fatura, aplicações,
--               transferência entre contas suas). Evita contar o mesmo gasto duas vezes:
--               a compra no cartão já é o gasto; o pagamento da fatura na conta não é.

INSERT INTO fin.categories (name, kind, color, sort_order) VALUES
  ('Moradia',                  'expense',  '#7c6f64', 10),
  ('Mercado',                  'expense',  '#689d6a', 20),
  ('Alimentação fora',         'expense',  '#d65d0e', 30),
  ('Transporte',               'expense',  '#458588', 40),
  ('Saúde',                    'expense',  '#cc241d', 50),
  ('Educação',                 'expense',  '#b16286', 60),
  ('Lazer',                    'expense',  '#d79921', 70),
  ('Assinaturas',              'expense',  '#8f3f71', 80),
  ('Compras',                  'expense',  '#076678', 90),
  ('Casa e reforma',           'expense',  '#79740e', 100),
  ('Pets',                     'expense',  '#af3a03', 110),
  ('Viagem',                   'expense',  '#427b58', 120),
  ('Impostos, tarifas e juros','expense',  '#9d0006', 130),
  ('Outros gastos',            'expense',  '#928374', 190),
  ('Salário',                  'income',   '#98971a', 200),
  ('Rendimentos',              'income',   '#b8bb26', 210),
  ('Outras receitas',          'income',   '#a89984', 290),
  ('Pagamento de fatura',      'transfer', '#665c54', 300),
  ('Investimentos',            'transfer', '#504945', 310),
  ('Transferência entre contas','transfer','#3c3836', 320);

-- Regras por tipo de operação informado pelo banco (Open Finance). Prioridade alta (número baixo).
INSERT INTO fin.category_rules (category_id, match_type, pattern, priority)
SELECT c.id, 'operation_type', r.pattern, 10
FROM (VALUES
  ('Pagamento de fatura',       'PAGAMENTO_FATURA'),
  ('Rendimentos',               'RENDIMENTO_APLIC_FINANCEIRA'),
  ('Investimentos',             'RESGATE_APLIC_FINANCEIRA'),
  ('Salário',                   'FOLHA_PAGAMENTO'),
  ('Salário',                   'PORTABILIDADE_SALARIO'),
  ('Impostos, tarifas e juros', 'TARIFA'),
  ('Impostos, tarifas e juros', 'PACOTE_TARIFA_SERVICOS'),
  ('Impostos, tarifas e juros', 'TARIFA_SERVICOS_AVULSOS'),
  ('Impostos, tarifas e juros', 'ENCARGOS_JUROS_CHEQUE_ESPECIAL'),
  ('Outras receitas',           'CASHBACK')
) AS r(category, pattern)
JOIN fin.categories c ON c.name = r.category;

-- Regras por descrição (case/acento-insensitive). Ajuste à vontade.
INSERT INTO fin.category_rules (category_id, match_type, pattern, priority)
SELECT c.id, r.match_type, r.pattern, r.priority
FROM (VALUES
  ('Pagamento de fatura',       'regex',    'pagamento (de |da )?fatura|pagto\.? ?fatura|pagamento recebido', 20),
  ('Investimentos',             'regex',    '\m(aplicacao|resgate|cdb|tesouro direto|lci|lca)\M',             30),
  ('Impostos, tarifas e juros', 'regex',    '\m(iof|anuidade|juros|multa|tarifa)\M',                          40),
  ('Assinaturas',               'regex',    'netflix|spotify|youtube|disney|amazon prime|prime video|hbo ?max|\mmax\.com|globoplay|deezer|apple\.com|google one|icloud|claude\.ai|anthropic|openai|chatgpt', 50),
  ('Alimentação fora',          'regex',    'ifood|rappi|restaurante|lanchonete|padaria|pizzaria|burger|mcdonald|starbucks|cafe ', 60),
  ('Mercado',                   'regex',    'supermercado|mercado(?! ?livre| ?pago)|atacad|assai|carrefour|pao de acucar|hortifruti|sacolao', 60),
  ('Transporte',                'regex',    '\muber\M|\m99 ?(app|pop|taxi)?\M|posto|combustivel|shell|ipiranga|petrobras|estacionamento|pedagio|sem parar|veloe|conectcar', 60),
  ('Saúde',                     'regex',    'farmacia|drogaria|droga ?raia|drogasil|pague ?menos|laboratorio|clinica|hospital|unimed|odonto', 60),
  ('Pets',                      'regex',    'petz|cobasi|petlove|pet ?shop|veterinari|agropet', 60),
  ('Casa e reforma',            'regex',    'leroy|telhanorte|tok ?& ?stok|tokstok|camicado|etna|madeira ?madeira|casa ?show|c&c', 60),
  ('Compras',                   'regex',    'mercado ?livre|mercadolivre|shopee|amazon|magalu|magazine luiza|americanas|aliexpress|shein|kabum', 70),
  ('Moradia',                   'regex',    'aluguel|condominio|energia|saneamento|internet|vivo|claro|\mtim\M|oi fibra', 70),
  ('Viagem',                    'regex',    'latam|gol linhas|azul linhas|booking|airbnb|hotel|decolar|123milhas', 70)
) AS r(category, match_type, pattern, priority)
JOIN fin.categories c ON c.name = r.category;
