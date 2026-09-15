import { describe, expect, it } from "vitest";
import { ContadorCusto } from "../../src/custo/contador.js";
import { precoDoModelo } from "../../src/custo/precos.js";

describe("ContadorCusto", () => {
  it("soma Deepgram por minuto, LLM por modelo com cache e embeddings", () => {
    const c = new ContadorCusto("deepgram", 5.4);
    c.registrarAudio(40 * 60); // 40 min
    // 50 chamadas Haiku: 2500 fresh + 4000 cache read + 150 out
    for (let i = 0; i < 50; i++) c.registrarLlm("claude-haiku-4-5", { input_tokens: 2500, output_tokens: 150, cache_read_input_tokens: 4000 });
    // resumo Sonnet
    c.registrarLlm("claude-sonnet-5", { input_tokens: 8000, output_tokens: 1500 });
    c.registrarEmbedding(8000);
    const t = c.totais();
    expect(t.sttUsd).toBeCloseTo(0.368, 4);
    // Haiku: 50 × (2500e-6×1 + 150e-6×5 + 4000e-6×0.1) = 50 × (0.0025+0.00075+0.0004) = 0.1825
    // Sonnet 5: 8000e-6×2 + 1500e-6×10 = 0.016 + 0.015 = 0.031
    expect(t.llmUsd).toBeCloseTo(0.1825 + 0.031, 4);
    expect(t.embeddingsUsd).toBeCloseTo(0.00016, 6);
    expect(t.totalBrl).toBeCloseTo(t.totalUsd * 5.4, 6);
    expect(t.totalBrl).toBeLessThan(5); // critério de pronto #10: < R$ 5/call
    expect(t.chamadasLlm).toBe(51);
    expect(t.cacheHitRatio).toBeGreaterThan(0.5);
  });

  it("modelo desconhecido é cobrado como o mais caro (nunca subestima)", () => {
    expect(precoDoModelo("claude-nova-9").entradaPorMTok).toBe(5);
    expect(precoDoModelo("claude-haiku-4-5-20251001").entradaPorMTok).toBe(1);
  });

  it("excedeu() dispara o breaker financeiro", () => {
    const c = new ContadorCusto("deepgram", 5.4);
    expect(c.excedeu(25)).toBe(false);
    c.registrarLlm("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(c.excedeu(25)).toBe(true);
  });
});
