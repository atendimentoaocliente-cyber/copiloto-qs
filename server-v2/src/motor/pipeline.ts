/**
 * Pipeline de 4 camadas — orquestração por turno do LEAD.
 *
 *   L0 gatilho literal      → 0 ms      → card na tela AGORA (fonte: gatilho)
 *   L1 busca vetorial       → ~120 ms   → resposta PRÉ-APROVADA do banco (fonte: banco)
 *   L2 Haiku 4.5 classifica → ~400 ms   → confirma/escolhe candidato ou retira falso positivo
 *   L3 Sonnet 5 gera        → ~800 ms   → só quando nada no banco serve (fonte: ia)
 *
 * REGRA DURA: LLM generativo NUNCA no caminho crítico. L0 emite de forma
 * síncrona antes de qualquer `await`. L1/L2/L3 refinam depois e SUBSTITUEM
 * o card (campo `substitui`). Se qualquer camada falhar, as anteriores já
 * estão na tela e a falha é reportada (nunca silenciosa).
 *
 * Fila de profundidade 1: se o lead fala de novo antes de L2/L3 terminarem,
 * o resultado antigo é descartado (sugestão sobre a fala anterior é ruído).
 */
import { randomUUID } from "node:crypto";
import type { Candidato } from "../db/repositorio.js";
import type { UsoLlm } from "../custo/contador.js";
import type { Logger } from "../logger.js";
import type { Metricas } from "../observabilidade/metricas.js";
import { contarPalavras, podarResposta } from "../util/texto.js";
import { mensagemDe } from "../util/erros.js";
import type { DetectorGatilhos } from "./gatilhos.js";
import type { BuscaVetorial } from "./vetorial.js";
import type { ClienteIa, ContextoTurno, ResultadoClassificacao, Sugestao } from "./tipos.js";

export interface SugestaoEmitida extends Sugestao {
  deteccaoId: string;
  substitui: string | null;
  /**
   * Verdadeiro na emissão do L0 quando L1/L2/L3 ainda vão rodar sobre este turno.
   * A saída usa isso para mostrar o card como "pendente" (chip) e completá-lo depois.
   */
  refinamentoPendente: boolean;
  latenciaMs: number;
  trecho: string;
  emMs: number;
}

export type EventoCusto = { tipo: "llm"; modelo: string; uso: UsoLlm } | { tipo: "embedding"; tokens: number };

/** Para onde o pipeline manda o que produz. A sessão implementa. */
export interface SaidaPipeline {
  emitir(s: SugestaoEmitida): void;
  retirar(deteccaoId: string, motivo: string): void;
  erro(origem: string, err: unknown): void;
  custo(evento: EventoCusto): void;
  estadoIa(estado: "ok" | "degradada" | "desligada", motivo: string | null): void;
}

export interface OpcoesPipeline {
  limiarSimilaridade: number;
  cooldownMs: number;
  /** Falas mais curtas que isto ficam só no L0 (embedding de "ok." é desperdício). */
  minPalavrasSemantica: number;
  maxPalavrasResposta: number;
  categoriasAtivas: Set<string>;
}

export interface DependenciasPipeline {
  gatilhos: DetectorGatilhos;
  vetorial: BuscaVetorial | null;
  ia: ClienteIa | null;
  rotuloCategoria: (id: string) => string;
  categoriaConhecida: (id: string) => boolean;
  metricas: Metricas;
  log: Logger;
  saida: SaidaPipeline;
  opcoes: OpcoesPipeline;
  agora?: () => number;
  gerarId?: () => string;
}

export class Pipeline {
  private geracao = 0;
  private iaLigada: boolean;
  private readonly ultimaPorCategoria = new Map<string, number>();
  private readonly agora: () => number;
  private readonly gerarId: () => string;

  constructor(private readonly d: DependenciasPipeline) {
    this.iaLigada = d.ia !== null;
    this.agora = d.agora ?? Date.now;
    this.gerarId = d.gerarId ?? randomUUID;
  }

  get iaAtiva(): boolean {
    return this.iaLigada && this.d.ia !== null;
  }

  /** Circuit breaker financeiro: teto de custo por call desliga L2/L3, mantém L0/L1. */
  desligarIa(motivo: string): void {
    if (!this.iaLigada) return;
    this.iaLigada = false;
    this.d.log.warn({ motivo }, "IA desligada para esta sessão");
    this.d.saida.estadoIa("desligada", motivo);
  }

  /**
   * Turno FINAL do lead. `inicioFalaMs` é o instante (mesma base de `agora`)
   * do primeiro parcial dessa fala — a latência exibida é fala→card.
   */
  async processarTurnoLead(ctx: ContextoTurno, inicioFalaMs: number): Promise<void> {
    const geracao = ++this.geracao;
    const obsoleto = () => geracao !== this.geracao;
    let atual: SugestaoEmitida | null = null;

    const semantico = contarPalavras(ctx.texto) >= this.d.opcoes.minPalavrasSemantica;
    const refinamento = semantico && (this.d.vetorial !== null || this.iaAtiva);

    // ── L0: síncrono. Nenhum await antes daqui. ───────────────────────────
    const fimL0 = this.d.metricas.cronometro("l0_gatilho");
    const l0 = this.d.gatilhos.detectar(ctx.texto);
    fimL0();
    if (l0 && this.categoriaAtiva(l0.objecao.categoriaId)) {
      atual = this.emitir(
        {
          categoriaId: l0.objecao.categoriaId,
          categoria: l0.objecao.categoria,
          resposta: l0.objecao.respostaCurta,
          fonte: "gatilho",
          camada: "L0",
          objecaoId: l0.objecao.id,
          similaridade: 1,
          temperatura: null,
          modelo: null,
        },
        ctx,
        inicioFalaMs,
        null,
        refinamento,
      );
    }

    if (!semantico) return;

    // ── L1: banco (pré-aprovado). ──────────────────────────────────────────
    let candidatos: Candidato[] = [];
    if (this.d.vetorial) {
      try {
        // Busca um pouco abaixo do limiar para dar candidatos ao L2; a EMISSÃO respeita o limiar.
        const r = await this.d.vetorial.buscar(ctx.texto, Math.max(0, this.d.opcoes.limiarSimilaridade - 0.15), 3);
        if (obsoleto()) return;
        this.d.saida.custo({ tipo: "embedding", tokens: r.tokens });
        candidatos = r.candidatos;
        const melhor = candidatos[0];
        if (melhor && melhor.similaridade >= this.d.opcoes.limiarSimilaridade && this.categoriaAtiva(melhor.categoriaId)) {
          if (!atual || atual.objecaoId !== melhor.objecaoId) {
            atual = this.emitir(candidatoParaSugestao(melhor, "L1", null), ctx, inicioFalaMs, atual?.deteccaoId ?? null) ?? atual;
          }
        }
      } catch (err) {
        this.d.metricas.erro("l1_vetorial");
        this.d.saida.erro("l1_vetorial", err);
      }
    }

    if (!this.iaAtiva || !this.d.ia) return;

    // ── L2: classificação (Haiku). ─────────────────────────────────────────
    let classif: ResultadoClassificacao;
    try {
      const r = await this.d.ia.classificar(ctx, candidatos);
      if (obsoleto()) return;
      this.d.saida.custo({ tipo: "llm", modelo: r.modelo, uso: r.uso });
      classif = r.dado;
    } catch (err) {
      this.d.metricas.erro("l2_classificador");
      this.d.saida.erro("l2_classificador", err);
      this.d.saida.estadoIa("degradada", mensagemDe(err));
      return;
    }
    this.d.saida.estadoIa("ok", null);

    if (!classif.agir) {
      // O classificador é quem tem o contexto da conversa: se ele diz que não
      // há objeção, o card sai da tela — não importa qual camada o emitiu.
      //
      // Antes isto exigia `camada === "L0"`, e bastava o L1 substituir o card
      // para o falso positivo ficar na tela. "Meu marido adorou as fotos" casa
      // o gatilho "meu marido" e o closer leria como objeção de cônjuge.
      if (atual) {
        this.d.saida.retirar(atual.deteccaoId, `classificador: ${classif.motivo}`);
        atual = null;
      }
      return;
    }

    const escolhido = classif.candidatoEscolhido != null ? candidatos[classif.candidatoEscolhido] : undefined;
    if (escolhido && this.categoriaAtiva(escolhido.categoriaId)) {
      if (!atual || atual.objecaoId !== escolhido.objecaoId) {
        this.emitir(candidatoParaSugestao(escolhido, "L2", classif.temperatura, this.d.ia.modelos.classificador), ctx, inicioFalaMs, atual?.deteccaoId ?? null);
      }
      return; // resposta pré-aprovada resolve: não gasta Sonnet.
    }

    // ── L3: geração (Sonnet) — nada no banco serve. ────────────────────────
    await this.gerar(ctx, classif, candidatos, inicioFalaMs, atual, obsoleto);
  }

  /** Closer apertou "me ajuda aqui": pula L2 e vai direto ao gerador com o contexto atual. */
  async pedirAjuda(ctx: ContextoTurno): Promise<void> {
    if (!this.iaAtiva || !this.d.ia) {
      this.d.saida.erro("ajuda", new Error("IA desligada nesta sessão; sem gerador disponível"));
      return;
    }
    const geracao = ++this.geracao;
    const inicio = this.agora();
    let candidatos: Candidato[] = [];
    if (this.d.vetorial && contarPalavras(ctx.texto) >= 2) {
      try {
        candidatos = (await this.d.vetorial.buscar(ctx.texto, 0.5, 3)).candidatos;
      } catch (err) {
        this.d.saida.erro("l1_vetorial", err);
      }
    }
    const classif: ResultadoClassificacao = {
      agir: true,
      categoriaId: candidatos[0]?.categoriaId ?? "outro",
      candidatoEscolhido: null,
      sinalDeCompra: false,
      temperatura: "morno",
      motivo: "pedido explícito do closer",
    };
    await this.gerar(ctx, classif, candidatos, inicio, null, () => geracao !== this.geracao);
  }

  // ── internos ──────────────────────────────────────────────────────────────

  private async gerar(
    ctx: ContextoTurno,
    classif: ResultadoClassificacao,
    candidatos: Candidato[],
    inicioFalaMs: number,
    atual: SugestaoEmitida | null,
    obsoleto: () => boolean,
  ): Promise<void> {
    if (!this.d.ia) return;
    try {
      const r = await this.d.ia.gerar(ctx, classif, candidatos);
      if (obsoleto()) return;
      this.d.saida.custo({ tipo: "llm", modelo: r.modelo, uso: r.uso });
      const resposta = podarResposta(r.dado.resposta, this.d.opcoes.maxPalavrasResposta);
      if (!resposta) {
        this.d.saida.erro("l3_gerador", new Error("gerador devolveu resposta vazia"));
        return;
      }
      const categoriaId = this.d.categoriaConhecida(classif.categoriaId) ? classif.categoriaId : "outro";
      this.emitir(
        {
          categoriaId,
          categoria: this.d.rotuloCategoria(categoriaId),
          resposta,
          fonte: "ia",
          camada: "L3",
          objecaoId: null,
          similaridade: candidatos[0]?.similaridade ?? 0,
          temperatura: classif.temperatura,
          modelo: r.modelo,
        },
        ctx,
        inicioFalaMs,
        atual?.deteccaoId ?? null,
      );
    } catch (err) {
      this.d.metricas.erro("l3_gerador");
      this.d.saida.erro("l3_gerador", err);
      this.d.saida.estadoIa("degradada", mensagemDe(err));
    }
  }

  private categoriaAtiva(id: string): boolean {
    return this.d.opcoes.categoriasAtivas.size === 0 || this.d.opcoes.categoriasAtivas.has(id);
  }

  /** Emite respeitando o cooldown por categoria (substituição sempre passa). */
  private emitir(s: Sugestao, ctx: ContextoTurno, inicioFalaMs: number, substitui: string | null, refinamentoPendente = false): SugestaoEmitida | null {
    const t = this.agora();
    // O cooldown mede tempo DE CONVERSA (ctx.emMs), não relógio de parede.
    // A regra de produto é "não repetir a mesma categoria em N segundos de
    // call"; com relógio real, reprocessar uma call gravada suprimiria tudo,
    // e o card que o classificador deveria retirar nunca chegaria a existir.
    if (!substitui) {
      const ultima = this.ultimaPorCategoria.get(s.categoriaId);
      if (ultima !== undefined && ctx.emMs - ultima < this.d.opcoes.cooldownMs) {
        this.d.log.debug({ categoria: s.categoriaId }, "sugestão suprimida por cooldown");
        return null;
      }
    }
    this.ultimaPorCategoria.set(s.categoriaId, ctx.emMs);
    // A latência continua no relógio real: é tempo de processamento.
    const latenciaMs = Math.max(0, t - inicioFalaMs);
    const emitida: SugestaoEmitida = {
      ...s,
      deteccaoId: this.gerarId(),
      substitui,
      refinamentoPendente,
      latenciaMs,
      trecho: ctx.texto,
      emMs: ctx.emMs,
    };
    this.d.metricas.observar("e2e_sugestao", latenciaMs);
    this.d.metricas.sugestoes.inc({ fonte: s.fonte, camada: s.camada });
    this.d.saida.emitir(emitida);
    return emitida;
  }
}

function candidatoParaSugestao(c: Candidato, camada: "L1" | "L2", temperatura: Sugestao["temperatura"], modelo: string | null = null): Sugestao {
  return {
    categoriaId: c.categoriaId,
    categoria: c.categoria,
    resposta: c.respostaCurta,
    fonte: "banco",
    camada,
    objecaoId: c.objecaoId,
    similaridade: c.similaridade,
    temperatura,
    modelo,
  };
}
