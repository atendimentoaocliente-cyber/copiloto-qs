/**
 * Embeddings para a busca vetorial (L1).
 *
 * O schema da Frente A fixa `vector(1536)` + `text-embedding-3-small`
 * (Voyage, recomendado pela Anthropic, não gera 1536 dims). Por isso o
 * cliente fala com um endpoint no formato OpenAI `/v1/embeddings`. Trocar
 * o modelo = trocar a coluna no banco + esta classe; o resto não muda.
 */
import { ErroDependencia } from "../util/erros.js";

export interface ResultadoEmbedding {
  vetor: number[];
  tokens: number;
}

export interface Embedder {
  readonly modelo: string;
  readonly dimensoes: number;
  embed(texto: string): Promise<ResultadoEmbedding>;
}

export interface ConfigEmbedderHttp {
  url: string;
  apiKey: string;
  modelo: string;
  dimensoes: number;
  /** Orçamento de latência do L1 é ~120 ms de busca + embedding. 1,5 s é o teto duro. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class EmbedderHttp implements Embedder {
  readonly modelo: string;
  readonly dimensoes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ConfigEmbedderHttp) {
    this.modelo = cfg.modelo;
    this.dimensoes = cfg.dimensoes;
    this.timeoutMs = cfg.timeoutMs ?? 1500;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async embed(texto: string): Promise<ResultadoEmbedding> {
    let ultimoErro: unknown;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      try {
        const r = await this.fetchImpl(this.cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({ model: this.modelo, input: texto, dimensions: this.dimensoes }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!r.ok) {
          const corpo = await r.text().catch(() => "");
          const err = new Error(`HTTP ${r.status} ${corpo.slice(0, 200)}`);
          if (r.status >= 500 || r.status === 429) {
            ultimoErro = err;
            continue;
          }
          throw new ErroDependencia("embeddings", err.message, err, false);
        }
        const json = (await r.json()) as { data?: Array<{ embedding?: number[] }>; usage?: { total_tokens?: number } };
        const vetor = json.data?.[0]?.embedding;
        if (!Array.isArray(vetor) || vetor.length !== this.dimensoes) {
          throw new ErroDependencia(
            "embeddings",
            `vetor inválido: esperado ${this.dimensoes} dims, veio ${Array.isArray(vetor) ? vetor.length : "nada"}`,
            undefined,
            false,
          );
        }
        return { vetor, tokens: json.usage?.total_tokens ?? 0 };
      } catch (err) {
        if (err instanceof ErroDependencia) throw err;
        ultimoErro = err;
      }
    }
    throw new ErroDependencia("embeddings", `falhou após 2 tentativas: ${ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro)}`, ultimoErro);
  }
}

/**
 * Embedder determinístico (hash) — para DB_MODO=memoria e testes.
 * Não tem semântica; o RepositorioMemoria faz a busca por sobreposição léxica.
 */
export class EmbedderDeterministico implements Embedder {
  readonly modelo = "deterministico";
  constructor(readonly dimensoes = 1536) {}
  async embed(texto: string): Promise<ResultadoEmbedding> {
    const vetor = new Array<number>(this.dimensoes).fill(0);
    let h = 2166136261;
    for (let i = 0; i < texto.length; i++) {
      h ^= texto.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
      vetor[h % this.dimensoes] = (vetor[h % this.dimensoes] ?? 0) + 1;
    }
    const norma = Math.sqrt(vetor.reduce((a, v) => a + v * v, 0)) || 1;
    return { vetor: vetor.map((v) => v / norma), tokens: Math.ceil(texto.length / 4) };
  }
}
