-- ═══════════════════════════════════════════════════════════════════════════
-- 007_seed_objecoes.sql — 30 objeções de venda de viagem internacional
--                         de alto ticket (R$ 15k–80k por família)
-- Depende de: 001_schema.sql
-- Idempotente: ON CONFLICT (org_id, titulo) DO NOTHING + resposta v1 só se
--              a objeção ainda não tiver nenhuma resposta.
--
-- Conteúdo original, escrito para o funil da Se Tu For Eu Vou / Inovvatur.
-- Cada objeção tem:
--   · categoria (13 categorias do produto)
--   · exemplo_lead: como o cliente realmente fala
--   · 3 a 6 gatilhos de fala (camada L0, match literal)
--   · 1 resposta primária: ≤ 20 palavras, falável em voz alta, em tom
--     consultivo — a resposta abre a conversa, não "vence" o cliente
--
-- embedding fica NULL. Depois de aplicar, o gateway lê
-- qs_copilot_vw_embeddings_pendentes e gera os vetores (ver README).
--
-- Cuidado com gatilho de uma palavra só: "visto" também é "já tinha visto".
-- Por isso os gatilhos aqui têm sempre 2+ palavras ou termo inequívoco.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

set local search_path = public, extensions;

create temp table seed_objecoes (
  titulo        text,
  categoria     text,
  exemplo_lead  text,
  gatilhos      text[],
  severidade    text,
  momento       text,
  resposta      text
) on commit drop;

insert into seed_objecoes (titulo, categoria, exemplo_lead, gatilhos, severidade, momento, resposta) values

-- ───────── PREÇO ─────────
('Achei caro', 'preco',
 'Nossa, achei bem salgado. Esperava algo mais em conta.',
 array['tá caro','muito caro','achei caro','salgado','fora do orçamento','não cabe no bolso'],
 'alta', 'proposta',
 'Caro em relação a quê? Deixa eu abrir item por item o que está dentro desse valor.'),

('Não sei se vale o investimento', 'preco',
 'É bastante coisa. Não sei se vale tudo isso.',
 array['vale a pena','não sei se vale','compensa','é bastante coisa','muito dinheiro por uma viagem','vale o investimento'],
 'alta', 'proposta',
 'O que faria valer pra você? Me diz isso e eu te mostro onde está.'),

('Quer tirar itens para baixar o valor', 'preco',
 'Se tirar os passeios fica quanto?',
 array['tira o passeio','sem o seguro','só aéreo e hotel','se tirar','dá pra enxugar','reduzir o pacote'],
 'media', 'proposta',
 'Dá pra enxugar, sim. Antes, me diz o que não pode faltar nessa viagem.'),

-- ───────── CONCORRENTE ─────────
('Achou mais barato em site de reservas', 'concorrente',
 'Vi no site bem mais barato que isso.',
 array['mais barato','vi no site','na internet','no booking','na decolar','direto no hotel'],
 'alta', 'proposta',
 'Me manda o print. Vou comparar item por item com você agora, na tela.'),

('Está cotando com outra agência', 'concorrente',
 'Já pedi cotação em outra agência também.',
 array['outra agência','minha agente','já pedi cotação','estou cotando','um conhecido que vende','outra proposta'],
 'alta', 'apresentacao',
 'Ótimo, compara. Me diz o que ela incluiu e eu te aponto as diferenças.'),

('Prefere montar a viagem sozinho', 'concorrente',
 'Eu mesmo consigo montar isso pela internet.',
 array['eu mesmo monto','monto sozinho','faço por conta','não preciso de agência','reservo direto','compro direto'],
 'media', 'apresentacao',
 'Dá pra montar, sim. Quem resolve pra você se o voo cancelar lá fora?'),

-- ───────── DECISOR / CÔNJUGE ─────────
('Precisa falar com o cônjuge', 'decisor',
 'Preciso ver com meu marido antes.',
 array['falar com meu marido','falar com minha esposa','ver com ele','ver com ela','decidir juntos','minha mulher'],
 'alta', 'fechamento',
 'Faz sentido. O que ele precisa ouvir pra ficar tão seguro quanto você?'),

('Depende do grupo ou da família', 'decisor',
 'Tenho que ver se o pessoal topa.',
 array['ver com o grupo','o pessoal ainda não confirmou','depende da minha irmã','todo mundo tem que topar','a família decide','ver com os outros'],
 'media', 'fechamento',
 'Quem já está dentro? Vamos garantir esses lugares e deixar os outros abertos.'),

('Vai mostrar a proposta em casa', 'decisor',
 'Vou mandar pra ela ver e te retorno.',
 array['mando pra ela ver','mostro pra ele','vou encaminhar','apresentar em casa','levar pra casa','mostrar em casa'],
 'alta', 'pos_proposta',
 'Melhor ainda: chama ele agora, ou marcamos quinze minutos com os dois hoje?'),

-- ───────── PROCRASTINAÇÃO ─────────
('Vou pensar', 'procrastinacao',
 'Deixa eu pensar com calma e te falo.',
 array['vou pensar','pensar melhor','preciso pensar','deixa eu ver','com calma','depois te falo'],
 'alta', 'fechamento',
 'Claro. Me ajuda: o que exatamente ainda está te deixando em dúvida?'),

('Pede tudo por WhatsApp', 'procrastinacao',
 'Me manda tudo no WhatsApp que eu vejo depois.',
 array['manda no whatsapp','manda no zap','por escrito','me envia por mensagem','manda o material','manda a proposta'],
 'media', 'pos_proposta',
 'Mando agora. Antes de desligar: o que essa proposta precisa ter pra ser um sim?'),

('Precisa organizar as contas', 'procrastinacao',
 'Preciso organizar minhas finanças primeiro.',
 array['organizar as contas','ver minhas finanças','fechar o mês','ver como fica','fazer as contas','organizar a vida'],
 'alta', 'fechamento',
 'Faz sentido. Se a parcela couber no seu mês, a viagem sai?'),

-- ───────── TIMING ─────────
('Agora não é o momento', 'timing',
 'Acho que ano que vem é melhor.',
 array['agora não','ano que vem','mais pra frente','não é uma boa hora','semestre que vem','talvez depois'],
 'alta', 'fechamento',
 'Entendo. O que muda até lá? Porque preço e vaga mudam contra você.'),

('Datas ainda indefinidas', 'timing',
 'Não sei quando vou conseguir tirar férias.',
 array['não sei a data','ainda não defini','depende das férias','não tenho data','sem data','quando der'],
 'media', 'diagnostico',
 'Sem problema. Qual mês seria o ideal, se tudo desse certo?'),

-- ───────── PARCELAMENTO ─────────
('Quer parcelar em mais vezes', 'parcelamento',
 'Dá pra dividir em mais vezes?',
 array['parcelar','quantas vezes','dividir','em mais vezes','cabe no cartão','sem juros'],
 'media', 'proposta',
 'Dá pra montar do jeito que caiba. Quanto por mês fica confortável pra você?'),

('Sem limite no cartão ou entrada alta', 'parcelamento',
 'Meu cartão não tem esse limite todo.',
 array['não tenho limite','limite do cartão','entrada alta','dois cartões','no boleto','no pix'],
 'media', 'proposta',
 'Resolvemos isso: entrada menor, dois cartões ou boleto. Qual combina com você?'),

-- ───────── CONFIANÇA / MEDO DE GOLPE ─────────
('Nunca ouviu falar da agência', 'confianca',
 'Como sei que isso não é golpe?',
 array['nunca ouvi falar','é golpe','vocês existem','é confiável','como eu sei','é seguro pagar'],
 'alta', 'abertura',
 'Pergunta justa. Te mando agora CNPJ, contrato e quem já viajou com a gente.'),

('Já foi enganado por agência', 'confianca',
 'Já perdi dinheiro com agência que sumiu.',
 array['já caí em golpe','me enganaram','fui lesado','agência sumiu','perdi dinheiro','já me queimei'],
 'alta', 'abertura',
 'Sinto muito. Por isso tudo é por contrato, com voucher em seu nome.'),

-- ───────── CANCELAMENTO / SEGURO ─────────
('E se precisar cancelar', 'cancelamento_seguro',
 'E se acontecer alguma coisa e eu não puder ir?',
 array['cancelar','cancelamento','desistir','reembolso','se acontecer alguma coisa','remarcar'],
 'media', 'proposta',
 'Tem política de remarcação e seguro. Te explico as duas em trinta segundos.'),

('Questiona o seguro viagem', 'cancelamento_seguro',
 'Precisa mesmo desse seguro?',
 array['precisa de seguro','seguro é obrigatório','tirar o seguro','não quero seguro','seguro caro','sem seguro'],
 'baixa', 'proposta',
 'É o item mais barato da viagem e o único que você agradece se precisar.'),

-- ───────── SEGURANÇA DO DESTINO ─────────
('Medo de o destino ser perigoso', 'seguranca_destino',
 'Lá não é perigoso?',
 array['é perigoso','é seguro ir','violência','assalto','tem guerra','instável'],
 'media', 'diagnostico',
 'Boa pergunta. Te falo exatamente como é a região onde você vai ficar.'),

('Medo de não falar o idioma', 'seguranca_destino',
 'Não falo inglês, como vou me virar?',
 array['não falo inglês','não falo a língua','o idioma','me perder','me virar sozinho','não entendo nada'],
 'baixa', 'diagnostico',
 'Você não vai sozinho. Tem assistência em português o tempo todo da viagem.'),

-- ───────── DOCUMENTAÇÃO / VISTO ─────────
('Dúvida sobre visto e documentos', 'documentacao',
 'E o visto? Vai dar tempo?',
 array['o visto','visto americano','passaporte vencido','vai dar tempo','documentação','autorização eletrônica'],
 'media', 'diagnostico',
 'A gente cuida disso passo a passo com você. Ninguém fica sem embarcar.'),

-- ───────── CÂMBIO ─────────
('Dólar está alto', 'cambio',
 'Com o dólar desse jeito fica inviável.',
 array['dólar alto','dólar caro','câmbio','euro alto','a moeda','cotação'],
 'media', 'proposta',
 'Por isso travamos em reais hoje. Você não fica refém da cotação.'),

('Quer esperar o dólar cair', 'cambio',
 'Vou esperar o dólar baixar um pouco.',
 array['esperar o dólar','dólar cair','quando baixar','esperar a cotação','se o dólar cair','dólar baixar'],
 'media', 'fechamento',
 'Ninguém acerta o câmbio. Travar hoje te dá previsibilidade; esperar te dá risco.'),

-- ───────── SÓ PESQUISANDO ─────────
('Só está pesquisando', 'pesquisando',
 'Tô só dando uma olhada por enquanto.',
 array['só pesquisando','dando uma olhada','só olhando','sondando','curiosidade','por enquanto'],
 'media', 'abertura',
 'Tranquilo. Pra quando seria a viagem, se tudo desse certo?'),

('Quer comparar mais opções', 'pesquisando',
 'Quero ver outras opções antes de decidir.',
 array['comparar mais','outras opções','ver outros destinos','mais cotações','pesquisar mais','antes de decidir'],
 'media', 'pos_proposta',
 'Faz sentido. O que precisa aparecer numa opção pra ela ganhar de todas?'),

-- ───────── SINAL DE COMPRA ─────────
('Pergunta como fechar', 'sinal_compra',
 'Como faço pra garantir?',
 array['como faço pra fechar','quero fechar','vamos fechar','manda o contrato','próximo passo','quero garantir'],
 'alta', 'fechamento',
 'Fecha agora comigo. Preciso de dois dados e garanto a sua vaga.'),

('Pergunta disponibilidade de data', 'sinal_compra',
 'Tem vaga pra julho?',
 array['tem vaga','tem disponibilidade','se fosse em','dá pra ir em','ainda tem lugar','pra essa data'],
 'alta', 'apresentacao',
 'Deixa eu conferir a disponibilidade dessa data com você agora mesmo.'),

('Pede para incluir algo a mais', 'sinal_compra',
 'Dá pra colocar mais um dia em Bangkok?',
 array['dá pra incluir','pode colocar','e se eu adicionar','upgrade','mais um dia','mais uma noite'],
 'media', 'proposta',
 'Dá, sim. Vou te mostrar quanto muda e já deixo reservado.');

-- ───────────────────────────────────────────────────────────────────────────
-- Auto-verificação do seed: 30 linhas, ≤ 20 palavras, 3–6 gatilhos,
-- 13 categorias cobertas. Se algo falhar, a transação inteira aborta.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_n bigint;
  v_bad text;
begin
  select count(*) into v_n from seed_objecoes;
  if v_n <> 30 then
    raise exception '[007] esperado 30 objeções no seed, encontrado %', v_n;
  end if;

  select string_agg(titulo, '; ') into v_bad
  from seed_objecoes
  where array_length(regexp_split_to_array(btrim(resposta), '\s+'), 1) > 20;
  if v_bad is not null then
    raise exception '[007] resposta com mais de 20 palavras: %', v_bad;
  end if;

  select string_agg(titulo, '; ') into v_bad
  from seed_objecoes
  where cardinality(gatilhos) not between 3 and 6;
  if v_bad is not null then
    raise exception '[007] objeção fora de 3–6 gatilhos: %', v_bad;
  end if;

  select count(distinct categoria) into v_n from seed_objecoes;
  if v_n <> 13 then
    raise exception '[007] esperado 13 categorias, encontrado %', v_n;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Objeções (idempotente por (org_id, titulo))
-- ───────────────────────────────────────────────────────────────────────────
insert into public.qs_copilot_objections
  (org_id, categoria, titulo, exemplo_lead, gatilhos, severidade, momento, fonte, is_active)
select
  public.qs_default_org_id(), s.categoria, s.titulo, s.exemplo_lead, s.gatilhos,
  s.severidade, s.momento, 'curadoria', true
from seed_objecoes s
on conflict (org_id, titulo) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- Resposta v1 (primária, aprovada) — só para objeção que ainda não tem resposta
-- ───────────────────────────────────────────────────────────────────────────
insert into public.qs_copilot_objection_responses
  (objection_id, versao, texto, tom, status, is_primary)
select
  o.id, 1, s.resposta, 'consultivo', 'aprovada', true
from seed_objecoes s
join public.qs_copilot_objections o
  on o.org_id = public.qs_default_org_id() and o.titulo = s.titulo
where not exists (
  select 1 from public.qs_copilot_objection_responses r where r.objection_id = o.id
);

do $$
declare
  v_obj bigint;
  v_resp bigint;
begin
  select count(*) into v_obj from public.qs_copilot_objections
  where org_id = public.qs_default_org_id() and fonte = 'curadoria';
  select count(*) into v_resp from public.qs_copilot_objection_responses r
  join public.qs_copilot_objections o on o.id = r.objection_id
  where o.org_id = public.qs_default_org_id() and r.is_primary;
  raise notice '[007] objeções na org padrão: % · com resposta primária: %', v_obj, v_resp;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO:
--   select categoria, count(*) from public.qs_copilot_objections group by 1 order by 1;  -- 13 linhas
--   select o.titulo, r.texto from public.qs_copilot_objections o
--     join public.qs_copilot_objection_responses r on r.objection_id = o.id and r.is_primary
--     order by o.categoria, o.titulo;                                                 -- 30 linhas
--   select count(*) from public.qs_copilot_vw_embeddings_pendentes;                  -- 30 (até rodar o backfill)
--
-- ROLLBACK:
--   delete from public.qs_copilot_objections where fonte = 'curadoria'
--     and org_id = public.qs_default_org_id();   -- respostas caem em cascata
-- ═══════════════════════════════════════════════════════════════════════════
