/**
 * Camada de ANÁLISE por IA — o que o Sales Pitch faz.
 *
 * Diferença para os gatilhos:
 *   gatilhos.js  → casa palavra literal. Instantâneo, mas burro.
 *                  "achei caro" dispara. "não sei se vale o investimento" não.
 *   analise.js   → Claude lê a conversa e ENTENDE a intenção, mesmo quando
 *                  o lead não usa nenhuma palavra da lista.
 *
 * Os dois rodam juntos: o gatilho mostra na hora (~0ms) e a IA refina
 * logo atrás (~700ms), trocando o card se discordar.
 */

import Anthropic from "@anthropic-ai/sdk";

const CHAVE = process.env.ANTHROPIC_API_KEY;
const MODELO = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

export const IA_ATIVA = Boolean(CHAVE);

const cliente = CHAVE ? new Anthropic({ apiKey: CHAVE }) : null;

const INSTRUCOES = `Você é o copiloto de um closer que vende viagens internacionais de alto ticket (R$ 15 mil a R$ 80 mil por família) numa call de vídeo ao vivo.

Sua função: ler o que o LEAD acabou de dizer, no contexto da conversa, e decidir se o closer precisa de ajuda AGORA.

Responda SEMPRE em JSON puro, sem markdown, neste formato:
{"agir": true|false, "categoria": "...", "resposta": "...", "temperatura": "frio|morno|quente"}

Regras:
- "agir": true SÓ quando houver objeção real, hesitação relevante ou sinal de compra. Conversa normal = false.
- "categoria": rótulo curto em português (ex.: "Preço", "Decisor ausente", "Medo de cancelar", "Sinal de compra").
- "resposta": UMA frase, no máximo 20 palavras, pronta para o closer FALAR EM VOZ ALTA agora. Tom direto e consultivo. Nunca liste, nunca explique, nunca use bullet.
- "temperatura": como o lead está em relação à compra.

A objeção quase nunca vem com as palavras óbvias. "Vou ver com calma", "é bastante coisa", "preciso organizar as contas" são objeção de preço. Entenda a intenção, não a palavra.`;

/**
 * @param {string} turnoDoLead  o que o lead acabou de falar
 * @param {string[]} contexto   últimos turnos da conversa
 */
export async function analisar(turnoDoLead, contexto = []) {
  if (!cliente) return null;

  const historico = contexto.slice(-8).join("\n");
  const inicio = Date.now();

  try {
    const resposta = await cliente.messages.create({
      model: MODELO,
      max_tokens: 200,
      system: [{ type: "text", text: INSTRUCOES, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Conversa até aqui:\n${historico || "(início da call)"}\n\nO LEAD acabou de dizer: "${turnoDoLead}"`,
        },
      ],
    });

    const texto = resposta.content?.[0]?.text?.trim() ?? "";
    const json = texto.replace(/^```(?:json)?|```$/g, "").trim();
    const dados = JSON.parse(json);

    return {
      ...dados,
      latenciaIaMs: Date.now() - inicio,
      tokens: resposta.usage,
    };
  } catch (err) {
    console.error("  ✗ IA:", err.message);
    return null;
  }
}


// ── Resumo pós-call ─────────────────────────────────────────────────────────

const INSTRUCOES_RESUMO = `Você analisa calls de venda de viagens internacionais de alto ticket.

Leia a transcrição e devolva JSON puro, sem markdown:
{
  "resumo": "3 a 4 frases sobre o que aconteceu na call",
  "perfil": "o que descobrimos sobre o lead: quem viaja, quando, para onde, orçamento",
  "objecoes": ["objeção que apareceu", "..."],
  "temperatura": "frio|morno|quente",
  "proximoPasso": "a próxima ação concreta, com prazo se houver",
  "oQueFuncionou": "o que o closer fez bem",
  "oQueMelhorar": "o erro mais caro que o closer cometeu, em uma frase"
}

Seja específico e use os dados reais da conversa. Nada de generalidade.
Se a transcrição for curta ou não for uma call de venda, diga isso no resumo.`;

export async function resumirCall(transcricao) {
  if (!cliente) return null;
  if (!transcricao || transcricao.length < 80) {
    return { resumo: "Call curta demais para análise.", objecoes: [], temperatura: "frio" };
  }

  const inicio = Date.now();
  try {
    const r = await cliente.messages.create({
      model: process.env.ANTHROPIC_MODEL_RESUMO ?? "claude-sonnet-5",
      max_tokens: 1200,
      system: INSTRUCOES_RESUMO,
      messages: [{ role: "user", content: `Transcrição da call:\n\n${transcricao}` }],
    });
    const texto = r.content?.[0]?.text?.trim() ?? "";
    const json = texto.replace(/^```(?:json)?|```$/g, "").trim();
    return { ...JSON.parse(json), latenciaMs: Date.now() - inicio, tokens: r.usage };
  } catch (err) {
    console.error("  ✗ resumo:", err.message);
    return null;
  }
}

/** Custo aproximado em USD de uma chamada, a partir do usage devolvido */
export function custoUsd(usage, modelo = "haiku") {
  if (!usage) return 0;
  const precos = {
    haiku:  { entrada: 1.00, saida: 5.00,  cache: 0.10 },
    sonnet: { entrada: 3.00, saida: 15.00, cache: 0.30 },
  };
  const p = precos[modelo] ?? precos.haiku;
  const entrada = (usage.input_tokens ?? 0) / 1e6 * p.entrada;
  const cache = (usage.cache_read_input_tokens ?? 0) / 1e6 * p.cache;
  const saida = (usage.output_tokens ?? 0) / 1e6 * p.saida;
  return entrada + cache + saida;
}
