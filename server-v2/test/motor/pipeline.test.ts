import { describe, expect, it, vi } from "vitest";
import type { Candidato } from "../../src/db/repositorio.js";
import { SEED_OBJECOES } from "../../src/db/seed-objecoes.js";
import { DetectorGatilhos } from "../../src/motor/gatilhos.js";
import { Pipeline, type SaidaPipeline, type SugestaoEmitida } from "../../src/motor/pipeline.js";
import type { BuscaVetorial } from "../../src/motor/vetorial.js";
import { logTeste, metricasTeste } from "../apoio/ambiente.js";
import { IaFalsa } from "../apoio/ia-falsa.js";

function candidato(cat: string, id: string, sim: number): Candidato {
  return { objecaoId: id, categoriaId: cat, categoria: cat, titulo: `t-${id}`, resposta: `resposta ${id}`, respostaCurta: `curta ${id}`, similaridade: sim, rrf: 0.01 };
}

function montar(opts: { candidatos?: Candidato[]; vetorialFalha?: Error; ia?: IaFalsa | null; buscarAsync?: () => Promise<Candidato[]> } = {}) {
  const emitidas: SugestaoEmitida[] = [];
  const retiradas: string[] = [];
  const erros: string[] = [];
  const estados: string[] = [];
  const saida: SaidaPipeline = {
    emitir: (s) => emitidas.push(s),
    retirar: (id) => retiradas.push(id),
    erro: (origem) => erros.push(origem),
    custo: () => undefined,
    estadoIa: (e) => estados.push(e),
  };
  const vetorial = {
    buscar: vi.fn(async () => {
      if (opts.vetorialFalha) throw opts.vetorialFalha;
      const c = opts.buscarAsync ? await opts.buscarAsync() : (opts.candidatos ?? []);
      return { candidatos: c, tokens: 10, embeddingMs: 1, buscaMs: 1 };
    }),
  } as unknown as BuscaVetorial;
  const ia = opts.ia === undefined ? new IaFalsa() : opts.ia;
  let t = 1000;
  const pipeline = new Pipeline({
    gatilhos: new DetectorGatilhos(SEED_OBJECOES),
    vetorial,
    ia,
    rotuloCategoria: (id) => id.toUpperCase(),
    categoriaConhecida: (id) => ["preco", "autoridade", "pagamento", "confianca", "concorrente", "timing", "sinal_compra", "outro"].includes(id),
    metricas: metricasTeste(),
    log: logTeste(),
    saida,
    opcoes: { limiarSimilaridade: 0.78, cooldownMs: 20_000, minPalavrasSemantica: 4, maxPalavrasResposta: 20, categoriasAtivas: new Set() },
    agora: () => (t += 10),
    gerarId: (() => { let n = 0; return () => `det-${++n}`; })(),
  });
  return { pipeline, emitidas, retiradas, erros, estados, vetorial, ia };
}

const ctx = (texto: string) => ({ texto, historico: [], briefing: null, emMs: 5000 });

describe("Pipeline — 4 camadas", () => {
  it("L0 emite de forma SÍNCRONA, antes de qualquer await (LLM nunca no caminho crítico)", () => {
    const { pipeline, emitidas } = montar({ ia: null });
    const p = pipeline.processarTurnoLead(ctx("achei caro esse pacote"), 900);
    // Ainda não deu tempo de nada assíncrono rodar:
    expect(emitidas).toHaveLength(1);
    expect(emitidas[0]!.camada).toBe("L0");
    expect(emitidas[0]!.fonte).toBe("gatilho");
    expect(emitidas[0]!.categoriaId).toBe("preco");
    expect(emitidas[0]!.latenciaMs).toBeGreaterThanOrEqual(0);
    return p;
  });

  it("L1 substitui o L0 quando o banco devolve objeção diferente acima do limiar", async () => {
    const { pipeline, emitidas } = montar({ ia: null, candidatos: [candidato("preco", "obj-site", 0.91)] });
    await pipeline.processarTurnoLead(ctx("achei caro, vi bem mais barato no site"), 900);
    expect(emitidas.map((e) => e.camada)).toEqual(["L0", "L1"]);
    expect(emitidas[1]!.substitui).toBe(emitidas[0]!.deteccaoId);
    expect(emitidas[1]!.fonte).toBe("banco");
    expect(emitidas[1]!.objecaoId).toBe("obj-site");
  });

  it("L1 não substitui quando confirma a mesma objeção do L0", async () => {
    const idPreco = SEED_OBJECOES[0]!.id;
    const { pipeline, emitidas } = montar({ ia: null, candidatos: [candidato("preco", idPreco, 0.95)] });
    await pipeline.processarTurnoLead(ctx("achei caro esse pacote todo"), 900);
    expect(emitidas).toHaveLength(1);
  });

  it("L2 retira falso positivo do regex quando o contexto é conversa normal", async () => {
    const { pipeline, emitidas, retiradas } = montar();
    await pipeline.processarTurnoLead(ctx("meu marido adorou as fotos do hotel"), 900);
    expect(emitidas).toHaveLength(1); // L0 disparou em "meu marido"
    expect(retiradas).toEqual([emitidas[0]!.deteccaoId]);
  });

  it("L2 escolhe candidato pré-aprovado e NÃO chama o gerador (Sonnet só quando nada serve)", async () => {
    const { pipeline, emitidas, ia } = montar({ candidatos: [candidato("preco", "obj-x", 0.7)] });
    await pipeline.processarTurnoLead(ctx("não sei se vale o investimento agora"), 900);
    // 0.7 < 0.78: L1 não emite; L2 escolhe o candidato → emite como banco/L2
    expect(emitidas).toHaveLength(1);
    expect(emitidas[0]!.camada).toBe("L2");
    expect(emitidas[0]!.fonte).toBe("banco");
    expect(ia!.chamadas.gerar).toBe(0);
  });

  it("L3 gera fallback com UMA frase de até 20 palavras, sem bullet", async () => {
    const { pipeline, emitidas, ia } = montar({ candidatos: [] });
    await pipeline.processarTurnoLead(ctx("não sei se vale o investimento nesse momento"), 900);
    expect(ia!.chamadas.gerar).toBe(1);
    expect(emitidas).toHaveLength(1);
    const s = emitidas[0]!;
    expect(s.camada).toBe("L3");
    expect(s.fonte).toBe("ia");
    expect(s.resposta.split(/\s+/).length).toBeLessThanOrEqual(20);
    expect(s.resposta).not.toMatch(/^[-•]/);
    expect(s.resposta).not.toContain("\n");
    expect(s.resposta.match(/[.!?]/g)?.length).toBe(1);
  });

  it("falha no L1 é reportada (nunca silenciosa) e o pipeline segue para L2/L3", async () => {
    const { pipeline, emitidas, erros } = montar({ vetorialFalha: new Error("pgvector fora") });
    await pipeline.processarTurnoLead(ctx("não sei se vale o investimento nesse momento"), 900);
    expect(erros).toContain("l1_vetorial");
    expect(emitidas.some((e) => e.camada === "L3")).toBe(true);
  });

  it("falha na IA é reportada e marca estado degradado; L0 já está na tela", async () => {
    const ia = new IaFalsa();
    ia.falharEm.classificar = new Error("429");
    const { pipeline, emitidas, erros, estados } = montar({ ia });
    await pipeline.processarTurnoLead(ctx("achei caro demais esse pacote"), 900);
    expect(emitidas).toHaveLength(1);
    expect(erros).toContain("l2_classificador");
    expect(estados).toContain("degradada");
  });

  it("fila de profundidade 1: resultado de turno antigo é descartado quando o lead fala de novo", async () => {
    const ia = new IaFalsa();
    ia.atrasoMs.gerar = 30;
    const { pipeline, emitidas } = montar({ ia, candidatos: [] });
    const p1 = pipeline.processarTurnoLead(ctx("não sei se vale o investimento nesse momento"), 900);
    const p2 = pipeline.processarTurnoLead(ctx("como faço para fechar essa data agora"), 950);
    await Promise.all([p1, p2]);
    // Só o turno 2 pode ter emitido L3; o L3 do turno 1 chegou obsoleto.
    const l3 = emitidas.filter((e) => e.camada === "L3");
    expect(l3).toHaveLength(1);
    expect(l3[0]!.trecho).toContain("fechar");
  });

  it("cooldown por categoria suprime repetição, mas substituição sempre passa", async () => {
    const { pipeline, emitidas } = montar({ ia: null });
    await pipeline.processarTurnoLead(ctx("achei caro"), 900);
    await pipeline.processarTurnoLead(ctx("tá caro"), 950);
    expect(emitidas).toHaveLength(1);
  });

  it("frase curta fica só no L0 (sem gastar embedding/LLM)", async () => {
    const { pipeline, vetorial, ia } = montar();
    await pipeline.processarTurnoLead(ctx("tá caro"), 900);
    expect(vetorial.buscar).not.toHaveBeenCalled();
    expect(ia!.chamadas.classificar).toBe(0);
  });

  it("desligarIa (teto de custo) mantém L0/L1 e corta L2/L3", async () => {
    const { pipeline, emitidas, ia, estados } = montar({ candidatos: [candidato("preco", "obj-x", 0.9)] });
    pipeline.desligarIa("custo");
    await pipeline.processarTurnoLead(ctx("achei caro, vi mais barato no site"), 900);
    expect(emitidas.map((e) => e.camada)).toEqual(["L0", "L1"]);
    expect(ia!.chamadas.classificar).toBe(0);
    expect(estados).toContain("desligada");
  });
});
