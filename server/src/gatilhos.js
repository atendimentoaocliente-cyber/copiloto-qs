/**
 * Banco de objeções do spike.
 *
 * No sistema final isso vira tabela no Supabase com busca vetorial.
 * Aqui é só uma lista de gatilhos literais — de propósito: queremos medir
 * a latência REAL do áudio e da transcrição, sem IA no meio do caminho.
 *
 * As respostas são rascunhos para teste. Quem escreve as definitivas é o
 * Everton com os closers.
 */

export const GATILHOS = [
  {
    categoria: "Preço",
    padrao: /\b(t[aá] caro|muito caro|acima do (meu )?or[çc]amento|sai caro|caro demais|n[aã]o cabe no bolso)\b/i,
    resposta:
      "Caro comparado a quê? Deixa eu te mostrar o que entra nesse valor.",
  },
  {
    categoria: "Preço — concorrente",
    padrao: /\b(mais barato|mais em conta|o concorrente|em outro lugar|no site d[oa]|direto no hotel)\b/i,
    resposta:
      "Me manda o que você achou que eu comparo item por item com você agora.",
  },
  {
    categoria: "Decisor",
    padrao: /\b(falar com (meu|minha) (marido|esposa|mulher|s[oó]cio|esposo)|consultar (meu|minha)|decidir junto|ver com ele|ver com ela)\b/i,
    resposta:
      "Faz sentido. O que ele precisa ouvir para ficar tão seguro quanto você?",
  },
  {
    categoria: "Procrastinação",
    padrao: /\b(vou pensar|pensar melhor|preciso pensar|depois eu (te )?(retorno|falo|aviso)|te dou um retorno|deixa eu ver)\b/i,
    resposta: "Claro. O que ainda está te deixando em dúvida?",
  },
  {
    categoria: "Timing",
    padrao: /\b(agora n[aã]o|mais pra frente|ano que vem|semestre que vem|n[aã]o [eé] uma boa hora|talvez depois)\b/i,
    resposta:
      "Entendo. Só lembrando que preço e disponibilidade mudam conforme a data se aproxima.",
  },
  {
    categoria: "Parcelamento",
    padrao: /\b(parcela|parcelar|quantas vezes|dividir|entrada|cart[aã]o|boleto|financiar)\b/i,
    resposta:
      "Dá pra montar do jeito que caiba no seu mês. Quanto você imaginava por parcela?",
  },
  {
    categoria: "Confiança",
    padrao: /\b(nunca ouvi falar|voc[eê]s s[aã]o confi[aá]veis|[eé] seguro|golpe|como eu sei que|voc[eê]s existem mesmo)\b/i,
    resposta:
      "Pergunta justa. Te mando agora CNPJ, contrato e depoimentos de quem já viajou com a gente.",
  },
  {
    categoria: "WhatsApp — fuga",
    padrao: /\b(me manda no (zap|whats)|manda por whatsapp|manda no whatsapp|me envia por mensagem|manda tudo por escrito)\b/i,
    resposta:
      "Mando sim. Antes de desligar: o que precisa estar nessa proposta pra ser um sim?",
  },
  {
    categoria: "Cancelamento",
    padrao: /\b(cancelar|cancelamento|remarcar|desistir|reembolso|se acontecer alguma coisa)\b/i,
    resposta:
      "Tem política de remarcação e seguro. Te explico as duas em trinta segundos.",
  },
  {
    categoria: "Segurança do destino",
    padrao: /\b([eé] perigoso|[eé] seguro (ir|viajar)|viol[eê]ncia|guerra|inst[aá]vel)\b/i,
    resposta:
      "Boa pergunta. Te falo exatamente como funciona a segurança nessa região.",
  },
  {
    categoria: "Documentação",
    padrao: /\b(visto|passaporte|vacina|documenta[çc][aã]o|esta|etias|schengen)\b/i,
    resposta:
      "A gente cuida disso com você, passo a passo. Nunca ninguém ficou sem embarcar.",
  },
  {
    categoria: "Câmbio",
    padrao: /\b(d[oó]lar|c[aâ]mbio|moeda|euro (t[aá]|est[aá]) (alto|caro)|convers[aã]o)\b/i,
    resposta:
      "Por isso a gente trava o valor em real. Você não fica refém da cotação.",
  },
  {
    categoria: "Só pesquisando",
    padrao: /\b(s[oó] (t[oô]|estou) (pesquisando|olhando|vendo)|dando uma olhada|sondando|curiosidade)\b/i,
    resposta: "Tranquilo. Pra quando seria a viagem, se tudo desse certo?",
  },
  {
    categoria: "Sinal de compra",
    padrao: /\b(como (eu )?fa[çc]o (pra|para) (fechar|garantir)|quero fechar|quero garantir|vamos fechar|me manda o contrato|qual (o|é o) pr[oó]ximo passo)\b/i,
    resposta: "Fecha agora comigo. Só preciso de dois dados e garanto sua vaga.",
  },
  {
    categoria: "Sinal de compra",
    padrao: /\b(se a gente fosse em|e se fosse em|d[aá] (pra|para) (ir|viajar)|t[eê]m? vaga|tem disponibilidade)\b/i,
    resposta: "Deixa eu ver a disponibilidade dessa data com você agora.",
  },
];

export function detectar(texto) {
  for (const gatilho of GATILHOS) {
    if (gatilho.padrao.test(texto)) {
      return { categoria: gatilho.categoria, resposta: gatilho.resposta };
    }
  }
  return null;
}
