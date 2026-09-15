/**
 * Estado de uma call em andamento.
 *
 * Guarda turnos, detecções, custo e a fila de persistência das transcrições
 * (batch a cada 2 s). Falha de persistência é reportada ao closer e contada,
 * e o buffer é mantido para nova tentativa (até 500 linhas).
 */
import type { LinhaTranscricao, RepositorioCopiloto } from "../db/repositorio.js";
import { ContadorCusto } from "../custo/contador.js";
import type { Logger } from "../logger.js";
import type { Metricas } from "../observabilidade/metricas.js";
import type { Briefing, Falante } from "../tipos/protocolo.js";
import type { SugestaoEmitida } from "../motor/pipeline.js";
import { redigirPii } from "../util/pii.js";

export interface Turno {
  seq: number;
  falante: Falante;
  texto: string;
  emMs: number;
  fimMs: number | null;
  confianca: number | null;
}

export interface DeteccaoRegistrada extends SugestaoEmitida {
  retirada: boolean;
  feedback: string | null;
}

export class Sessao {
  readonly iniciadaEm: number;
  encerradaEm: number | null = null;
  readonly turnos: Turno[] = [];
  readonly deteccoes = new Map<string, DeteccaoRegistrada>();
  readonly custo: ContadorCusto;
  readonly errosPersistencia: string[] = [];
  bytesAudio = 0;
  private seq: number;
  private filaTranscricoes: LinhaTranscricao[] = [];
  private timerFlush: NodeJS.Timeout | null = null;
  private flushEmAndamento = false;

  constructor(
    readonly id: string,
    readonly closerId: string,
    readonly leadId: string | null,
    readonly briefing: Briefing | null,
    private readonly repo: Pick<RepositorioCopiloto, "inserirTranscricoes">,
    private readonly log: Logger,
    private readonly metricas: Metricas,
    sttProvedor: string,
    cambioBrl: number,
    private readonly agora: () => number = Date.now,
    private readonly flushIntervaloMs = 2000,
    extras: { seqInicial?: number; iniciadaEm?: number } = {},
  ) {
    // Reidratação (reconexão noutra máquina): continua a numeração e o relógio da call.
    this.iniciadaEm = extras.iniciadaEm ?? agora();
    this.seq = extras.seqInicial ?? 0;
    this.custo = new ContadorCusto(sttProvedor, cambioBrl);
  }

  get duracaoMs(): number {
    return (this.encerradaEm ?? this.agora()) - this.iniciadaEm;
  }

  get emMs(): number {
    return this.agora() - this.iniciadaEm;
  }

  /** Registra turno final; devolve o turno (com PII redigida) para o pipeline. */
  registrarTurno(falante: Falante, textoBruto: string, confianca: number | null, inicioMs: number | null, fimMs: number | null): Turno {
    const texto = redigirPii(textoBruto);
    const turno: Turno = {
      seq: this.seq++,
      falante,
      texto,
      emMs: inicioMs ?? this.emMs,
      fimMs,
      confianca,
    };
    this.turnos.push(turno);
    this.filaTranscricoes.push({
      callId: this.id,
      closerId: this.closerId,
      seq: turno.seq,
      speaker: falante,
      speakerTag: falante === "lead" ? 0 : 1,
      content: texto,
      tsStartMs: Math.max(0, Math.round(turno.emMs)),
      tsEndMs: fimMs != null ? Math.round(fimMs) : null,
      confidence: confianca,
    });
    this.agendarFlush();
    return turno;
  }

  registrarDeteccao(s: SugestaoEmitida): void {
    this.deteccoes.set(s.deteccaoId, { ...s, retirada: false, feedback: null });
    if (s.substitui) {
      const anterior = this.deteccoes.get(s.substitui);
      if (anterior) anterior.retirada = true;
    }
  }

  /** Contexto para a IA: últimos N turnos formatados. */
  contexto(n: number): string[] {
    return this.turnos.slice(-n).map((t) => `${t.falante === "lead" ? "LEAD" : "CLOSER"}: ${t.texto}`);
  }

  transcricaoCompleta(): string {
    return this.turnos.map((t) => `${t.falante === "lead" ? "LEAD" : "CLOSER"}: ${t.texto}`).join("\n");
  }

  briefingTexto(): string | null {
    const b = this.briefing;
    if (!b) return null;
    const linhas: string[] = [];
    if (b.leadNome) linhas.push(`Lead: ${b.leadNome}${b.empresa ? ` (${b.empresa})` : ""}${b.cidade ? ` — ${b.cidade}` : ""}`);
    if (b.valorEstimado) linhas.push(`Valor estimado: R$ ${b.valorEstimado.toLocaleString("pt-BR")}`);
    if (b.handover) linhas.push(`Handover do SDR: ${b.handover}`);
    if (b.notas.length) linhas.push(`Notas recentes: ${b.notas.join(" | ")}`);
    return linhas.length ? linhas.join("\n") : null;
  }

  /** Estatísticas de conversa para o resumo. */
  estatisticas(): { talkRatioCloser: number | null; perguntasCloser: number; monologoMaxSeg: number } {
    let palavrasCloser = 0;
    let palavrasLead = 0;
    let perguntas = 0;
    let monologoMax = 0;
    let monologoAtual = 0;
    let falanteAnterior: Falante | null = null;
    let inicioMonologo = 0;
    for (const t of this.turnos) {
      const n = t.texto.split(/\s+/).filter(Boolean).length;
      if (t.falante === "closer") {
        palavrasCloser += n;
        if (t.texto.includes("?")) perguntas++;
      } else palavrasLead += n;
      if (t.falante === "closer") {
        if (falanteAnterior !== "closer") inicioMonologo = t.emMs;
        monologoAtual = (t.fimMs ?? t.emMs) - inicioMonologo;
        monologoMax = Math.max(monologoMax, monologoAtual);
      }
      falanteAnterior = t.falante;
    }
    const total = palavrasCloser + palavrasLead;
    return {
      talkRatioCloser: total ? Math.round((palavrasCloser / total) * 1000) / 10 : null,
      perguntasCloser: perguntas,
      monologoMaxSeg: Math.round(monologoMax / 1000),
    };
  }

  encerrar(): void {
    if (this.encerradaEm === null) this.encerradaEm = this.agora();
    this.custo.registrarAudio(this.duracaoMs / 1000);
    if (this.timerFlush) clearTimeout(this.timerFlush);
    this.timerFlush = null;
  }

  // ── persistência em lote ──────────────────────────────────────────────────

  private agendarFlush(): void {
    if (this.timerFlush || this.encerradaEm !== null) return;
    this.timerFlush = setTimeout(() => {
      this.timerFlush = null;
      void this.flush();
    }, this.flushIntervaloMs);
  }

  /** Grava a fila. Devolve o erro (se houver) para quem chamou decidir. */
  async flush(): Promise<Error | null> {
    if (this.flushEmAndamento || !this.filaTranscricoes.length) return null;
    this.flushEmAndamento = true;
    const lote = this.filaTranscricoes;
    this.filaTranscricoes = [];
    const fim = this.metricas.cronometro("persistencia");
    try {
      await this.repo.inserirTranscricoes(lote);
      fim();
      return null;
    } catch (err) {
      fim();
      this.metricas.erro("persistencia_transcricao");
      // Devolve ao buffer (limite 500 linhas) para a próxima tentativa.
      this.filaTranscricoes = [...lote, ...this.filaTranscricoes].slice(-500);
      const e = err instanceof Error ? err : new Error(String(err));
      this.errosPersistencia.push(e.message);
      this.log.error({ err: e, linhas: lote.length }, "falha ao persistir transcrições; mantidas em buffer");
      return e;
    } finally {
      this.flushEmAndamento = false;
      if (this.filaTranscricoes.length && this.encerradaEm === null) this.agendarFlush();
    }
  }

  get pendentesPersistencia(): number {
    return this.filaTranscricoes.length;
  }
}
