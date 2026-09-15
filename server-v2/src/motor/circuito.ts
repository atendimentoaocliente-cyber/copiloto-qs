/**
 * Circuit breaker para a Anthropic: 5 falhas em 60 s → aberto por 30 s.
 * Aberto = L2/L3 não são chamados; L0/L1 continuam. A UI não trava.
 */
export type EstadoCircuito = "fechado" | "aberto" | "meio_aberto";

export class CircuitBreaker {
  private falhas: number[] = [];
  private abertoAte = 0;
  private testando = false;

  constructor(
    private readonly limite = 5,
    private readonly janelaMs = 60_000,
    private readonly esfriamentoMs = 30_000,
    private readonly agora: () => number = Date.now,
  ) {}

  get estado(): EstadoCircuito {
    const t = this.agora();
    if (t < this.abertoAte) return "aberto";
    if (this.abertoAte > 0 && !this.testando) return "meio_aberto";
    return "fechado";
  }

  /** Verdadeiro se a chamada deve ser BLOQUEADA agora. */
  bloqueado(): boolean {
    const e = this.estado;
    if (e === "aberto") return true;
    if (e === "meio_aberto") {
      // Deixa passar UMA chamada de teste.
      if (this.testando) return true;
      this.testando = true;
    }
    return false;
  }

  registrarSucesso(): void {
    this.falhas = [];
    this.abertoAte = 0;
    this.testando = false;
  }

  registrarFalha(): void {
    const t = this.agora();
    this.falhas = this.falhas.filter((f) => t - f < this.janelaMs);
    this.falhas.push(t);
    this.testando = false;
    if (this.falhas.length >= this.limite) {
      this.abertoAte = t + this.esfriamentoMs;
      this.falhas = [];
    }
  }
}
