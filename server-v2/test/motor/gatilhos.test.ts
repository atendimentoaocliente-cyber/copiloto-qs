import { describe, expect, it } from "vitest";
import { SEED_OBJECOES } from "../../src/db/seed-objecoes.js";
import { DetectorGatilhos } from "../../src/motor/gatilhos.js";

describe("L0 — DetectorGatilhos", () => {
  const det = new DetectorGatilhos(SEED_OBJECOES);

  it("casa gatilho literal ignorando acento e caixa", () => {
    expect(det.detectar("Olha, ACHEI CARO esse pacote")?.objecao.categoriaId).toBe("preco");
    // "carô" é erro típico de transcrição: normalizamos acento, então casa.
    expect(det.detectar("achei carô")?.objecao.categoriaId).toBe("preco");
    expect(det.detectar("Tá caro demais pra mim")?.objecao.categoriaId).toBe("preco");
  });

  it("respeita fronteira de palavra (não casa dentro de outra palavra)", () => {
    // "parcela" não deve casar em "parcelamento"? Casa — é prefixo válido. Mas "caro" não casa em "carona".
    expect(det.detectar("vamos de carona")).toBeNull();
    expect(det.detectar("é uma parcela pequena")?.objecao.categoriaId).toBe("pagamento");
  });

  it("prioriza severidade alta quando dois gatilhos casam", () => {
    // "férias" (baixa) e "meu marido" (alta) na mesma frase
    const r = det.detectar("Preciso ver as férias e falar com meu marido");
    expect(r?.objecao.categoriaId).toBe("autoridade");
  });

  it("devolve null para conversa normal", () => {
    expect(det.detectar("A gente queria ir para a Capadócia em julho")).toBeNull();
    expect(det.detectar("")).toBeNull();
  });

  it("recompila quando o playbook muda (editável sem deploy)", () => {
    const d2 = new DetectorGatilhos([]);
    expect(d2.detectar("achei caro")).toBeNull();
    d2.atualizar(SEED_OBJECOES);
    expect(d2.detectar("achei caro")?.objecao.categoriaId).toBe("preco");
    expect(d2.total).toBe(SEED_OBJECOES.length);
  });

  it("detecta sinal de compra", () => {
    expect(det.detectar("Como faço para fechar?")?.objecao.categoriaId).toBe("sinal_compra");
    expect(det.detectar("tem disponibilidade em julho?")?.objecao.categoriaId).toBe("sinal_compra");
  });
});
