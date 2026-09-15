/**
 * L1 — busca vetorial + léxica (RRF) no pgvector. Alvo: ~120 ms.
 *
 * Devolve respostas PRÉ-APROVADAS do banco. É a camada que faz o card
 * instantâneo ter conteúdo bom mesmo sem LLM no caminho.
 */
import type { Candidato, RepositorioCopiloto } from "../db/repositorio.js";
import type { Metricas } from "../observabilidade/metricas.js";
import type { Embedder } from "./embeddings.js";

export interface ResultadoBusca {
  candidatos: Candidato[];
  tokens: number;
  embeddingMs: number;
  buscaMs: number;
}

export class BuscaVetorial {
  constructor(
    private readonly embedder: Embedder,
    private readonly repo: Pick<RepositorioCopiloto, "buscarObjecoes">,
    private readonly metricas: Metricas,
  ) {}

  async buscar(texto: string, limiar: number, n: number): Promise<ResultadoBusca> {
    const fimEmb = this.metricas.cronometro("l1_embedding");
    const { vetor, tokens } = await this.embedder.embed(texto);
    const embeddingMs = fimEmb();

    const fimBusca = this.metricas.cronometro("l1_busca");
    const candidatos = await this.repo.buscarObjecoes(vetor, texto, limiar, n);
    const buscaMs = fimBusca();

    return { candidatos, tokens, embeddingMs, buscaMs };
  }
}
