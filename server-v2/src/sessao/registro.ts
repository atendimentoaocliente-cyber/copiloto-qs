/**
 * Registro das sessões ativas nesta instância + drenagem.
 *
 * Drenagem: `/health` passa a 503 (o proxy do Fly para de mandar conexões
 * novas), sessões novas são recusadas, as ativas continuam até acabar.
 * Prazo máximo: 45 min (uma call de 40 + margem).
 */
import type { Metricas } from "../observabilidade/metricas.js";
import type { Logger } from "../logger.js";

export interface SessaoAtiva {
  id: string;
  closerId: string;
  iniciadaEm: number;
  avisarDrenagem: (graceMs: number) => void;
}

export class RegistroSessoes {
  private readonly ativas = new Map<string, SessaoAtiva>();
  private drenando = false;

  constructor(
    private readonly metricas: Metricas,
    private readonly log: Logger,
  ) {}

  get emDrenagem(): boolean {
    return this.drenando;
  }

  get total(): number {
    return this.ativas.size;
  }

  listar(): Array<{ id: string; closerId: string; duracaoMs: number }> {
    const t = Date.now();
    return [...this.ativas.values()].map((s) => ({ id: s.id, closerId: s.closerId, duracaoMs: t - s.iniciadaEm }));
  }

  contarDoCloser(closerId: string): number {
    let n = 0;
    for (const s of this.ativas.values()) if (s.closerId === closerId) n++;
    return n;
  }

  adicionar(s: SessaoAtiva): void {
    this.ativas.set(s.id, s);
    this.metricas.sessoesAtivas.set(this.ativas.size);
  }

  remover(id: string): void {
    this.ativas.delete(id);
    this.metricas.sessoesAtivas.set(this.ativas.size);
  }

  /** Entra em drenagem e resolve quando não houver mais sessão (ou no prazo). */
  async drenar(prazoMs: number): Promise<{ restantes: number }> {
    this.drenando = true;
    this.metricas.drenando.set(1);
    this.log.warn({ ativas: this.ativas.size, prazoMs }, "instância em drenagem");
    for (const s of this.ativas.values()) s.avisarDrenagem(prazoMs);
    const limite = Date.now() + prazoMs;
    while (this.ativas.size > 0 && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { restantes: this.ativas.size };
  }
}
