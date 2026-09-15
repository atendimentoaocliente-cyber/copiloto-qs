/**
 * Cache do playbook em memória, recarregado a cada N segundos.
 *
 * O Supabase NÃO está no caminho crítico da call: se cair, o cache continua
 * servindo o L0 e o digest dos prompts. Falha de recarga é logada e contada —
 * nunca derruba o que já está carregado.
 */
import type { ObjecaoPlaybook, RepositorioCopiloto } from "../db/repositorio.js";
import { SEED_OBJECOES } from "../db/seed-objecoes.js";
import type { Logger } from "../logger.js";
import type { Metricas } from "../observabilidade/metricas.js";
import { DetectorGatilhos } from "./gatilhos.js";

export class CachePlaybook {
  readonly gatilhos: DetectorGatilhos;
  private objecoes: ObjecaoPlaybook[] = [];
  private categorias = new Map<string, string>();
  private digestCache = "";
  private timer: NodeJS.Timeout | null = null;
  versao = 0;
  ultimaRecargaOk: number | null = null;

  constructor(
    private readonly repo: Pick<RepositorioCopiloto, "listarObjecoesAtivas" | "listarCategorias">,
    private readonly log: Logger,
    private readonly metricas: Metricas,
    private readonly intervaloMs: number,
  ) {
    this.gatilhos = new DetectorGatilhos([]);
  }

  async iniciar(): Promise<void> {
    await this.recarregar();
    if (!this.objecoes.length) {
      this.log.error("playbook vazio no banco (ou banco indisponível); usando seed estático até a próxima recarga");
      this.aplicar(SEED_OBJECOES, new Map(SEED_OBJECOES.map((o) => [o.categoriaId, o.categoria])));
    }
    this.timer = setInterval(() => void this.recarregar(), this.intervaloMs);
    this.timer.unref();
  }

  parar(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async recarregar(): Promise<void> {
    try {
      const [objecoes, categorias] = await Promise.all([this.repo.listarObjecoesAtivas(), this.repo.listarCategorias()]);
      const mapa = new Map(categorias.map((c) => [c.id, c.label]));
      if (!mapa.has("sinal_compra")) mapa.set("sinal_compra", "Sinal de compra");
      if (!mapa.has("outro")) mapa.set("outro", "Outro");
      this.aplicar(objecoes, mapa);
      this.ultimaRecargaOk = Date.now();
      this.log.info({ objecoes: objecoes.length, versao: this.versao }, "playbook recarregado");
    } catch (err) {
      this.metricas.erro("playbook_recarga");
      this.log.error({ err }, "falha ao recarregar playbook; mantendo versão em memória");
    }
  }

  private aplicar(objecoes: ObjecaoPlaybook[], categorias: Map<string, string>): void {
    this.objecoes = objecoes;
    this.categorias = categorias;
    this.gatilhos.atualizar(objecoes);
    this.digestCache = montarDigest(objecoes, categorias);
    this.versao++;
  }

  get todas(): ObjecaoPlaybook[] {
    return this.objecoes;
  }

  rotulo(categoriaId: string): string {
    return this.categorias.get(categoriaId) ?? categoriaId;
  }

  categoriaConhecida(id: string): boolean {
    return this.categorias.has(id);
  }

  listaCategorias(): Array<{ id: string; label: string }> {
    return [...this.categorias].map(([id, label]) => ({ id, label }));
  }

  /**
   * Digest ESTÁVEL do playbook para o prompt de sistema (cacheável na Anthropic).
   * Só muda quando o playbook muda — nunca por call, nunca por timestamp.
   */
  get digest(): string {
    return this.digestCache;
  }
}

function montarDigest(objecoes: ObjecaoPlaybook[], categorias: Map<string, string>): string {
  const cats = [...categorias].map(([id, label]) => `- ${id}: ${label}`).join("\n");
  const objs = objecoes
    .map((o) => `- [${o.categoriaId}] ${o.titulo} — como o lead fala: "${o.exemploLead}"`)
    .join("\n");
  return `CATEGORIAS DE OBJEÇÃO (use exatamente estes ids):\n${cats}\n\nOBJEÇÕES CATALOGADAS NO PLAYBOOK:\n${objs}`;
}
