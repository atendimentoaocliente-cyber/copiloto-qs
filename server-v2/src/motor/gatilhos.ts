/**
 * L0 — gatilho literal. Instantâneo (< 1 ms), sem rede.
 *
 * Os gatilhos vêm da coluna `gatilhos text[]` de cada objeção aprovada no
 * playbook (editável pelo gestor no QS, sem deploy). O regex é compilado uma
 * vez por versão do playbook. Casamento insensível a acento e caixa.
 *
 * Limite conhecido: pega "achei caro", perde "não sei se vale o investimento".
 * Para isso existem L1/L2. O papel do L0 é colocar o card na tela em 0 ms.
 */
import type { ObjecaoPlaybook } from "../db/repositorio.js";
import { escaparRegex, normalizar } from "../util/texto.js";

export interface AchadoGatilho {
  objecao: ObjecaoPlaybook;
  gatilho: string;
}

interface Regra {
  objecao: ObjecaoPlaybook;
  regex: RegExp;
}

const PESO_SEVERIDADE: Record<ObjecaoPlaybook["severidade"], number> = { alta: 0, media: 1, baixa: 2 };

export class DetectorGatilhos {
  private regras: Regra[] = [];

  constructor(objecoes: ObjecaoPlaybook[]) {
    this.atualizar(objecoes);
  }

  get total(): number {
    return this.regras.length;
  }

  atualizar(objecoes: ObjecaoPlaybook[]): void {
    const regras: Regra[] = [];
    for (const objecao of objecoes) {
      const regex = DetectorGatilhos.compilar(objecao.gatilhos);
      if (regex) regras.push({ objecao, regex });
    }
    // Severidade alta primeiro: "achei caro" ganha de "férias" se ambos casarem.
    regras.sort((a, b) => PESO_SEVERIDADE[a.objecao.severidade] - PESO_SEVERIDADE[b.objecao.severidade]);
    this.regras = regras;
  }

  /** Compila a lista de gatilhos numa única regex sobre texto normalizado. */
  static compilar(gatilhos: string[]): RegExp | null {
    const partes = gatilhos
      .map((g) => normalizar(g))
      .filter((g) => g.length >= 2)
      .map((g) => escaparRegex(g).replace(/ /g, "\\s+"));
    if (!partes.length) return null;
    // Fronteira manual: \b não entende acentos, mas o texto já vem normalizado (ASCII).
    return new RegExp(`(?<![a-z0-9])(?:${partes.join("|")})(?![a-z0-9])`, "i");
  }

  detectar(texto: string): AchadoGatilho | null {
    const alvo = normalizar(texto);
    if (!alvo) return null;
    for (const regra of this.regras) {
      const m = regra.regex.exec(alvo);
      if (m) return { objecao: regra.objecao, gatilho: m[0] };
    }
    return null;
  }
}
