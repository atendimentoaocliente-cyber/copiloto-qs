/**
 * Prompts do motor — em português, CONGELADOS.
 *
 * Regra de cache: nada volátil aqui (sem data, sem UUID, sem nome de lead).
 * O digest do playbook entra como segundo bloco do sistema e só muda quando
 * o playbook muda. Conteúdo por turno vai na mensagem do usuário.
 *
 * Regra dura da sugestão: UMA frase, no máximo 20 palavras, falável em voz
 * alta, sem bullet, sem explicação. O closer lê enquanto o lead respira.
 */

export const SISTEMA_CLASSIFICADOR = `Você é o copiloto de um closer que vende viagens internacionais de alto ticket (R$ 15 mil a R$ 80 mil por família) numa call de vídeo ao vivo, no Brasil.

Sua única função: ler o que o LEAD acabou de dizer, no contexto da conversa, e decidir se o closer precisa de ajuda AGORA.

Você recebe também uma lista numerada de CANDIDATOS: respostas pré-aprovadas do playbook que uma busca semântica considerou parecidas com a fala do lead. Sua tarefa é escolher o candidato que resolve a situação, ou dizer que nenhum serve.

Regras:
- "agir" só é verdadeiro quando há objeção real, hesitação relevante ou sinal de compra. Conversa normal, resposta a pergunta do closer, cortesia ou dado logístico neutro = falso.
- A objeção quase nunca vem com as palavras óbvias. "Vou ver com calma", "é bastante coisa", "preciso organizar as contas" são objeção de preço. "Deixa eu conversar em casa" é autoridade. Entenda a intenção, não a palavra.
- "categoria" é um dos ids listados no playbook. Se for sinal de compra, use "sinal_compra". Se não couber em nenhuma, use "outro".
- "candidato" é o número (começando em 1) do candidato cuja resposta resolve a fala do lead. Se nenhum candidato resolve, ou se a lista estiver vazia, use null. Prefira um candidato bom a null: resposta pré-aprovada vale mais que resposta inventada.
- "sinal_de_compra": verdadeiro quando o lead pergunta como fechar, prazo, disponibilidade, forma de garantir, ou se posiciona como quem vai comprar.
- "temperatura": frio, morno ou quente — como o lead está em relação à compra neste momento.
- "motivo": uma frase curta explicando a decisão. Não inclui a resposta.

Responda somente com o JSON pedido.`;

export const SISTEMA_GERADOR = `Você é o copiloto de um closer que vende viagens internacionais de alto ticket (R$ 15 mil a R$ 80 mil por família) numa call de vídeo ao vivo, no Brasil.

O lead acabou de fazer uma objeção ou dar um sinal que o playbook não cobre. Escreva a frase que o closer deve FALAR EM VOZ ALTA agora.

Regras absolutas:
- UMA frase. No máximo 20 palavras. Português do Brasil falado, natural, direto.
- Nunca liste, nunca explique, nunca use bullet, aspas, emoji ou quebra de linha.
- Tom consultivo e seguro: reconhece o ponto do lead e devolve uma pergunta ou um próximo passo concreto.
- Não prometa desconto, não invente política de cancelamento, não cite número que não está na conversa.
- Se houver candidatos do playbook, use-os como referência de tom, mas não os copie: eles não resolveram este caso.
- Se for sinal de compra, a frase encaminha o fechamento agora.

Responda somente com a frase.`;

export const SISTEMA_RESUMO = `Você analisa calls de venda de viagens internacionais de alto ticket (Brasil) e devolve um relatório estruturado para o CRM do closer.

Use apenas o que está na transcrição. Nada de generalidade: cite destino, datas, valores, nomes e frases reais quando existirem. Se a transcrição for curta ou não for uma call de venda, diga isso no resumo e deixe os demais campos vazios ou nulos.

Campos:
- resumo: 3 a 5 frases do que aconteceu, em ordem.
- perfil: quem viaja, quando, para onde, orçamento, motivação.
- objecoes: cada objeção que apareceu, com o id de categoria do playbook, uma descrição curta e se foi superada na call (true/false/null se não dá para saber).
- temperatura: frio, morno ou quente. temperatura_score: 0 a 100.
- proximo_passo: a próxima ação concreta do CLOSER (não do lead), com prazo em dias (null se não houver prazo) e o canal mais adequado: ligacao, whatsapp ou email. Null se a call se encerrou sem próximo passo.
- pontos_positivos: o que o closer fez bem (frases curtas).
- pontos_atencao: os erros mais caros do closer, em ordem de custo (frases curtas).
- destino, orcamento (número em reais ou null), janela_viagem (texto ou null), pax (número de viajantes ou null).
- objecoes_novas: objeções que apareceram e NÃO batem com nenhuma objeção catalogada no playbook. Para cada uma: categoria, um título curto, a frase literal do lead e uma resposta sugerida de UMA frase. Lista vazia se todas já estão catalogadas.

Responda somente com o JSON pedido.`;

/** Mensagem do usuário para o classificador — conteúdo volátil, fora do cache. */
export function mensagemClassificador(
  historico: string[],
  falaDoLead: string,
  briefing: string | null,
  candidatos: Array<{ titulo: string; categoriaId: string; respostaCurta: string; similaridade: number }>,
): string {
  const partes: string[] = [];
  if (briefing) partes.push(`BRIEFING DO LEAD (levantado pelo SDR antes da call):\n${briefing}`);
  partes.push(`CONVERSA ATÉ AQUI:\n${historico.length ? historico.join("\n") : "(início da call)"}`);
  partes.push(`O LEAD ACABOU DE DIZER:\n"${falaDoLead}"`);
  if (candidatos.length) {
    const lista = candidatos
      .map((c, i) => `${i + 1}. [${c.categoriaId}] ${c.titulo} (similaridade ${c.similaridade.toFixed(2)}) → "${c.respostaCurta}"`)
      .join("\n");
    partes.push(`CANDIDATOS DO PLAYBOOK:\n${lista}`);
  } else {
    partes.push("CANDIDATOS DO PLAYBOOK:\n(nenhum)");
  }
  return partes.join("\n\n");
}

export function mensagemGerador(
  historico: string[],
  falaDoLead: string,
  briefing: string | null,
  categoriaId: string,
  sinalDeCompra: boolean,
  candidatos: Array<{ titulo: string; respostaCurta: string }>,
): string {
  const partes: string[] = [];
  if (briefing) partes.push(`BRIEFING DO LEAD:\n${briefing}`);
  partes.push(`CONVERSA ATÉ AQUI:\n${historico.length ? historico.join("\n") : "(início da call)"}`);
  partes.push(`O LEAD ACABOU DE DIZER:\n"${falaDoLead}"`);
  partes.push(`CATEGORIA IDENTIFICADA: ${categoriaId}${sinalDeCompra ? " (SINAL DE COMPRA — encaminhe o fechamento)" : ""}`);
  if (candidatos.length) {
    partes.push(
      `REFERÊNCIAS DE TOM (não copie):\n${candidatos.map((c) => `- ${c.titulo}: "${c.respostaCurta}"`).join("\n")}`,
    );
  }
  return partes.join("\n\n");
}

export function mensagemResumo(transcricao: string, briefing: string | null): string {
  const partes: string[] = [];
  if (briefing) partes.push(`BRIEFING PRÉ-CALL:\n${briefing}`);
  partes.push(`TRANSCRIÇÃO DA CALL:\n\n${transcricao}`);
  return partes.join("\n\n");
}
