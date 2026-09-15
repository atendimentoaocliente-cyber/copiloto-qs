/**
 * Provedor STT de fixture — reproduz uma sessão gravada de forma determinística.
 *
 * Cada evento tem um deslocamento em BYTES de áudio (16 kHz × 2 canais × 2 B
 * = 64 B/ms). Quando o áudio recebido cruza o deslocamento, o evento é emitido
 * — exatamente o fluxo binário→STT→motor de produção, sem rede e sem
 * variação do Deepgram.
 *
 * Eventos com `soAoFinalizar: true` só saem em `finalizar()`: simulam o
 * `is_final` que o Deepgram devolve apenas após `CloseStream` — o teste prova
 * que o gateway espera por eles antes de encerrar.
 */
import { ProvedorStt, type EventoTranscricao, type OpcoesStt } from "../../src/stt/provedor.js";

export interface EventoFixture {
  aoMs: number;
  canal: 0 | 1;
  texto: string;
  final: boolean;
  soAoFinalizar?: boolean;
}

export const BYTES_POR_MS = (16000 * 2 * 2) / 1000; // 64

export class ProvedorSttFixture extends ProvedorStt {
  readonly nome = "fixture";
  readonly modelo = "fixture-v1";
  private bytes = 0;
  private proximo = 0;
  private readonly eventos: EventoFixture[];
  private primeiraEmitida = false;
  conectado = false;
  finalizado = false;
  destruido = false;

  constructor(eventos: EventoFixture[], _opcoes?: OpcoesStt) {
    super();
    this.eventos = [...eventos].sort((a, b) => a.aoMs - b.aoMs);
  }

  get bytesDescartados(): number {
    return 0;
  }

  async conectar(): Promise<void> {
    this.conectado = true;
    this.emit("estado", { estado: "conectado", tentativa: 0 });
  }

  enviar(pcm: Buffer): void {
    this.bytes += pcm.length;
    const ms = this.bytes / BYTES_POR_MS;
    while (this.proximo < this.eventos.length) {
      const ev = this.eventos[this.proximo]!;
      if (ev.soAoFinalizar || ev.aoMs > ms) break;
      this.proximo++;
      this.emitirEvento(ev);
    }
  }

  async finalizar(): Promise<void> {
    this.finalizado = true;
    // Simula o CloseStream: tudo o que faltava vira final agora.
    for (; this.proximo < this.eventos.length; this.proximo++) {
      const ev = this.eventos[this.proximo]!;
      this.emitirEvento({ ...ev, final: true });
    }
  }

  destruir(): void {
    this.destruido = true;
  }

  private emitirEvento(ev: EventoFixture): void {
    if (!this.primeiraEmitida) {
      this.primeiraEmitida = true;
      this.emit("primeira_palavra", 1255); // valor medido em produção
    }
    const e: EventoTranscricao = {
      texto: ev.texto,
      canal: ev.canal,
      final: ev.final,
      confianca: 0.93,
      inicioMs: ev.aoMs,
      fimMs: ev.final ? ev.aoMs + 1500 : null,
    };
    this.emit("transcricao", e);
  }
}
