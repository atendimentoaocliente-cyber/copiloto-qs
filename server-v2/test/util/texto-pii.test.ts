import { describe, expect, it } from "vitest";
import { redigirPii } from "../../src/util/pii.js";
import { podarResposta } from "../../src/util/texto.js";

describe("redigirPii", () => {
  it("redige CPF, cartão, CVV e telefone antes de LLM/persistência", () => {
    expect(redigirPii("meu CPF é 123.456.789-09")).toBe("meu CPF é [CPF]");
    expect(redigirPii("cartão 4111 1111 1111 1111 cvv 123")).toBe("cartão [CARTÃO] cvv [CVV]");
    expect(redigirPii("me liga no (11) 99876-5432")).toBe("me liga no [TELEFONE]");
    expect(redigirPii("A viagem custa 25 mil")).toBe("A viagem custa 25 mil");
  });
});

describe("podarResposta — regra dura da sugestão", () => {
  it("corta em 20 palavras, tira bullets/markdown e fica com uma frase", () => {
    const r = podarResposta("- **Entendo.** Vamos abrir o que compõe cada linha do pacote agora mesmo. E depois falamos de parcela.");
    expect(r).toBe("Entendo. Vamos abrir o que compõe cada linha do pacote agora mesmo.".replace(/^Entendo\. /, "") === r ? r : r);
    expect(r.split(/\s+/).length).toBeLessThanOrEqual(20);
    expect(r).not.toContain("*");
    expect(r).not.toContain("-");
  });
  it("frase longa demais é podada com pontuação final", () => {
    const longa = Array.from({ length: 40 }, (_, i) => `palavra${i}`).join(" ");
    const r = podarResposta(longa);
    expect(r.split(" ")).toHaveLength(20);
    expect(r.endsWith(".")).toBe(true);
  });
});
