/**
 * Contabilidade de custo por call.
 *
 * Acumula Deepgram (por segundo de áudio enviado), Anthropic (por modelo,
 * com tokens de cache separados) e embeddings. Expõe totais em USD e BRL e
 * o cache hit ratio — métrica de saúde de primeira classe: se cair abaixo
 * de 70%, algum timestamp/UUID entrou no prefixo do prompt e o custo
 * triplicou em silêncio.
 */
import { PRECO_EMBEDDING_USD_POR_MTOK, PRECO_STT_USD_POR_MIN, precoDoModelo } from "./precos.js";

export interface UsoLlm {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface TotaisCusto {
  sttUsd: number;
  llmUsd: number;
  embeddingsUsd: number;
  totalUsd: number;
  totalBrl: number;
  audioSegundos: number;
  chamadasLlm: number;
  porModelo: Record<string, { chamadas: number; entrada: number; saida: number; cacheLeitura: number; cacheEscrita: number; usd: number }>;
  tokensEmbedding: number;
  cacheHitRatio: number | null;
}

export class ContadorCusto {
  private audioSegundos = 0;
  private embeddingsTokens = 0;
  private readonly porModelo = new Map<string, { chamadas: number; entrada: number; saida: number; cacheLeitura: number; cacheEscrita: number; usd: number }>();

  constructor(
    private readonly sttProvedor: string,
    private readonly cambioBrl: number,
  ) {}

  registrarAudio(segundos: number): void {
    if (segundos > 0) this.audioSegundos += segundos;
  }

  registrarEmbedding(tokens: number): void {
    if (tokens > 0) this.embeddingsTokens += tokens;
  }

  /** Devolve o custo em USD desta chamada (útil para log/métrica). */
  registrarLlm(modelo: string, uso: UsoLlm | null | undefined): number {
    if (!uso) return 0;
    const p = precoDoModelo(modelo);
    const entrada = uso.input_tokens ?? 0;
    const saida = uso.output_tokens ?? 0;
    const cacheLeitura = uso.cache_read_input_tokens ?? 0;
    const cacheEscrita = uso.cache_creation_input_tokens ?? 0;
    const usd =
      (entrada / 1e6) * p.entradaPorMTok +
      (saida / 1e6) * p.saidaPorMTok +
      (cacheLeitura / 1e6) * p.cacheLeituraPorMTok +
      (cacheEscrita / 1e6) * p.cacheEscritaPorMTok;
    const acc = this.porModelo.get(modelo) ?? { chamadas: 0, entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0, usd: 0 };
    acc.chamadas++;
    acc.entrada += entrada;
    acc.saida += saida;
    acc.cacheLeitura += cacheLeitura;
    acc.cacheEscrita += cacheEscrita;
    acc.usd += usd;
    this.porModelo.set(modelo, acc);
    return usd;
  }

  totais(): TotaisCusto {
    const precoMin = PRECO_STT_USD_POR_MIN[this.sttProvedor] ?? 0.0092;
    const sttUsd = (this.audioSegundos / 60) * precoMin;
    let llmUsd = 0;
    let chamadas = 0;
    let entradaTotal = 0;
    let cacheLeituraTotal = 0;
    const porModelo: TotaisCusto["porModelo"] = {};
    for (const [m, v] of this.porModelo) {
      llmUsd += v.usd;
      chamadas += v.chamadas;
      entradaTotal += v.entrada + v.cacheLeitura + v.cacheEscrita;
      cacheLeituraTotal += v.cacheLeitura;
      porModelo[m] = { ...v };
    }
    const embeddingsUsd = (this.embeddingsTokens / 1e6) * PRECO_EMBEDDING_USD_POR_MTOK;
    const totalUsd = sttUsd + llmUsd + embeddingsUsd;
    return {
      sttUsd,
      llmUsd,
      embeddingsUsd,
      totalUsd,
      totalBrl: totalUsd * this.cambioBrl,
      audioSegundos: this.audioSegundos,
      chamadasLlm: chamadas,
      porModelo,
      tokensEmbedding: this.embeddingsTokens,
      cacheHitRatio: entradaTotal > 0 ? cacheLeituraTotal / entradaTotal : null,
    };
  }

  excedeu(limiteBrl: number): boolean {
    return this.totais().totalBrl > limiteBrl;
  }
}
