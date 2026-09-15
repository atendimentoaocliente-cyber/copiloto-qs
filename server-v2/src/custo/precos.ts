/**
 * Tabela de preços (USD) — fonte: referência oficial da API Anthropic e
 * Deepgram PAYG. Atualizar aqui quando mudar; nada de número mágico solto.
 *
 * Cache: leitura a 0,1× do input, escrita a 1,25× (TTL 5 min) — por isso
 * o prompt de sistema estável fica ANTES de qualquer conteúdo volátil.
 */
export interface PrecoModelo {
  entradaPorMTok: number;
  saidaPorMTok: number;
  cacheLeituraPorMTok: number;
  cacheEscritaPorMTok: number;
}

export const PRECOS_LLM: Record<string, PrecoModelo> = {
  "claude-haiku-4-5": { entradaPorMTok: 1.0, saidaPorMTok: 5.0, cacheLeituraPorMTok: 0.1, cacheEscritaPorMTok: 1.25 },
  "claude-sonnet-5": { entradaPorMTok: 2.0, saidaPorMTok: 10.0, cacheLeituraPorMTok: 0.2, cacheEscritaPorMTok: 2.5 },
  "claude-sonnet-4-6": { entradaPorMTok: 3.0, saidaPorMTok: 15.0, cacheLeituraPorMTok: 0.3, cacheEscritaPorMTok: 3.75 },
  "claude-opus-5": { entradaPorMTok: 5.0, saidaPorMTok: 25.0, cacheLeituraPorMTok: 0.5, cacheEscritaPorMTok: 6.25 },
};

/** Deepgram nova-3 streaming, tier multilingual, PAYG. */
export const PRECO_STT_USD_POR_MIN: Record<string, number> = {
  deepgram: 0.0092,
};

/** text-embedding-3-small. */
export const PRECO_EMBEDDING_USD_POR_MTOK = 0.02;

/** Resolve o preço por prefixo (ex.: "claude-haiku-4-5-20251001" → haiku). */
export function precoDoModelo(modelo: string): PrecoModelo {
  const direto = PRECOS_LLM[modelo];
  if (direto) return direto;
  const chave = Object.keys(PRECOS_LLM).find((k) => modelo.startsWith(k));
  if (chave) return PRECOS_LLM[chave]!;
  // Desconhecido: cobra como o mais caro da tabela para nunca subestimar.
  return PRECOS_LLM["claude-opus-5"]!;
}
