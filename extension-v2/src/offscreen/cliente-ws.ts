/**
 * Cliente WebSocket com o gateway — a parte que não pode falhar em silêncio.
 *
 *   • Reconexão com recuo progressivo (500 ms → 10 s, com jitter).
 *   • Fila de áudio durante a queda (30 s), reenviada ao voltar com a flag
 *     `reenviado`.
 *   • Heartbeat a cada 5 s; watchdog derruba e reabre se o gateway ficar
 *     mudo por 15 s enquanto estamos mandando áudio (Wi-Fi que cai sem FIN
 *     não dispara `onclose`).
 *   • Retomada de sessão (`sessao.retomar`) em vez de abrir sessão nova.
 *   • Cada mudança de estado é reportada — o painel NUNCA fica "ativo" sem estar.
 */

import { RESILIENCIA, VERSAO_EXTENSAO } from "@/compartilhado/config";
import type { EventoAudio, ParametrosCaptura } from "@/compartilhado/mensagens";
import {
  FECHAMENTO,
  lerMensagemGateway,
  montarFrame,
  SUBPROTOCOLO,
  type MensagemCliente,
  type MensagemGateway,
} from "@/compartilhado/protocolo";
import type { ValorFeedback } from "@/compartilhado/tipos";
import { FilaAudio } from "./fila-audio";

const MS_POR_PACOTE = 64; // 1024 frames a 16 kHz

export interface OpcoesCliente {
  parametros: ParametrosCaptura;
  temMicrofone: boolean;
  aoEvento: (evento: EventoAudio) => void;
}

export class ClienteWs {
  private socket: WebSocket | null = null;
  private tentativas = 0;
  private timerReconexao: ReturnType<typeof setTimeout> | null = null;
  private timerHeartbeat: ReturnType<typeof setInterval> | null = null;
  private timerWatchdog: ReturnType<typeof setTimeout> | null = null;
  private timerSilencio: ReturnType<typeof setTimeout> | null = null;
  private ultimoFrameGateway = 0;
  private enviandoAudio = false;
  private encerrando = false;
  private pronto = false;
  private jaIniciou = false;
  private seq = 0;
  private degradado = false;
  private readonly fila = new FilaAudio(RESILIENCIA.filaAudioSegundos, MS_POR_PACOTE);

  constructor(private readonly op: OpcoesCliente) {}

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  conectar(): void {
    if (this.encerrando) return;
    const { gateway, token } = this.op.parametros;
    const url = gateway.replace(/^http/, "ws") + `/v1/stream?token=${encodeURIComponent(token)}`;

    try {
      this.socket = new WebSocket(url, SUBPROTOCOLO);
    } catch (err) {
      this.op.aoEvento({ tipo: "erro", texto: `URL do gateway inválida: ${(err as Error).message}`, fatal: true });
      return;
    }
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => this.aoAbrir();
    this.socket.onmessage = (e) => this.aoMensagem(e);
    this.socket.onclose = (e) => this.aoFechar(e);
    this.socket.onerror = () => {
      /* onclose vem em seguida e decide */
    };
  }

  encerrar(motivo: "closer" | "aba_fechada" | "erro"): void {
    this.encerrando = true;
    this.limparTimers();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.enviarJson({ tipo: "encerrar", sessaoId: this.op.parametros.sessaoId, motivo });
    }
    this.socket?.close(1000, "encerrado pelo closer");
    this.socket = null;
    this.fila.limpar();
  }

  /** Botão "Tentar de novo" do painel: zera o recuo e reabre. */
  reconectarManual(): void {
    if (this.encerrando) return;
    this.limparTimers();
    try {
      this.socket?.close(4001, "reconexão manual");
    } catch {
      /* ignora */
    }
    this.socket = null;
    this.tentativas = 0;
    this.conectar();
  }

  // ── Áudio ─────────────────────────────────────────────────────────────────

  enviarAudio(pcm: ArrayBuffer): void {
    const seq = this.seq++;
    this.enviandoAudio = true;
    if (this.pronto && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(montarFrame(pcm, seq, false));
      return;
    }
    // Sem conexão: guarda para reenviar. Nada da call se perde.
    this.fila.empurrar({ seq, pcm });
  }

  pausar(pausado: boolean): void {
    const sessaoId = this.op.parametros.sessaoId;
    this.enviarJson(pausado ? { tipo: "captura.pausar", sessaoId } : { tipo: "captura.retomar", sessaoId });
    this.enviandoAudio = !pausado;
  }

  feedback(sugestaoId: string, valor: ValorFeedback): void {
    this.enviarJson({
      tipo: "feedback",
      sessaoId: this.op.parametros.sessaoId,
      sugestaoId,
      valor,
      em: new Date().toISOString(),
    });
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private aoAbrir(): void {
    const p = this.op.parametros;
    this.tentativas = 0;
    this.ultimoFrameGateway = Date.now();

    if (!this.jaIniciou) {
      const inicio: MensagemCliente = {
        tipo: "sessao.iniciar",
        versao: 1,
        sessaoId: p.sessaoId,
        reuniaoId: p.reuniaoId,
        leadId: p.leadId,
        consentimentoId: p.consentimentoId,
        plataforma: p.plataforma,
        audio: {
          codificacao: "linear16",
          taxaAmostragem: 16000,
          canais: 2,
          temMicrofone: this.op.temMicrofone,
        },
        cliente: {
          versaoExtensao: VERSAO_EXTENSAO,
          chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "?",
          so: navigator.platform,
        },
      };
      this.enviarJson(inicio);
    } else {
      this.enviarJson({ tipo: "sessao.retomar", versao: 1, sessaoId: p.sessaoId, ultimoSeq: this.seq - 1 });
    }

    this.op.aoEvento({ tipo: "conectado" });
    this.iniciarHeartbeat();
  }

  private aoMensagem(evento: MessageEvent): void {
    this.ultimoFrameGateway = Date.now();
    const msg = lerMensagemGateway(evento.data);
    if (!msg) return;
    this.tratar(msg);
  }

  private tratar(msg: MensagemGateway): void {
    switch (msg.tipo) {
      case "pronto":
      case "sessao.retomada":
        this.pronto = true;
        this.jaIniciou = true;
        this.drenarFila();
        if (msg.tipo === "pronto") {
          this.op.aoEvento({ tipo: "pronto", ia: msg.ia, modelo: msg.modelo });
        } else {
          this.op.aoEvento({ tipo: "recuperado" });
        }
        this.reiniciarSilencio();
        break;
      case "pong":
        break;
      case "transcricao":
        this.reiniciarSilencio();
        if (this.degradado) {
          this.degradado = false;
          this.op.aoEvento({ tipo: "recuperado" });
        }
        this.op.aoEvento({ tipo: "transcricao", dados: { texto: msg.texto, falante: msg.falante, final: msg.final } });
        break;
      case "sugestao": {
        const { tipo: _t, ...dados } = msg;
        this.op.aoEvento({ tipo: "sugestao", dados });
        break;
      }
      case "sugestao.retirar":
        this.op.aoEvento({ tipo: "sugestao_retirada", sugestaoId: msg.sugestaoId, motivo: msg.motivo });
        break;
      case "degradado":
        this.degradado = true;
        this.op.aoEvento({ tipo: "degradado", motivo: msg.motivo });
        break;
      case "recuperado":
        this.degradado = false;
        this.op.aoEvento({ tipo: "recuperado" });
        break;
      case "reconectando":
        // O gateway perdeu o Deepgram e está religando: para o closer é "degradado".
        this.op.aoEvento({ tipo: "degradado", motivo: "Transcrição religando no servidor" });
        break;
      case "erro":
        this.op.aoEvento({ tipo: "erro", texto: msg.texto, fatal: Boolean(msg.fatal) });
        break;
    }
  }

  private aoFechar(e: CloseEvent): void {
    this.pronto = false;
    this.limparTimers();
    if (this.encerrando) return;

    if (e.code === FECHAMENTO.naoAutorizado) {
      this.op.aoEvento({ tipo: "erro", texto: "O gateway não aceitou a credencial. Pareie a extensão de novo.", fatal: true });
      return;
    }
    if (e.code === FECHAMENTO.sessaoInvalida) {
      this.op.aoEvento({ tipo: "erro", texto: "O gateway não reconhece esta sessão.", fatal: true });
      return;
    }
    if (e.code === FECHAMENTO.tetoDeDuracao) {
      this.op.aoEvento({ tipo: "erro", texto: "A call passou do tempo máximo. Encerre e inicie de novo.", fatal: true });
      return;
    }

    // Oscilação de internet não pode matar a call: reconecta sozinho.
    this.tentativas++;
    if (this.tentativas > RESILIENCIA.tentativasMaximas) {
      this.op.aoEvento({ tipo: "erro", texto: "Perdi o gateway e não consegui voltar.", fatal: false });
      return;
    }
    const base = Math.min(
      RESILIENCIA.recuoInicialMs * 2 ** (this.tentativas - 1),
      RESILIENCIA.recuoMaximoMs,
    );
    const jitter = Math.random() * base * 0.3;
    this.op.aoEvento({
      tipo: "reconectando",
      tentativa: this.tentativas,
      maximo: RESILIENCIA.tentativasVisiveis,
      filaSegundos: this.fila.segundos(MS_POR_PACOTE),
    });
    this.timerReconexao = setTimeout(() => this.conectar(), base + jitter);
  }

  private drenarFila(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const p of this.fila.drenar()) {
      this.socket.send(montarFrame(p.pcm, p.seq, true));
    }
  }

  private enviarJson(msg: MensagemCliente): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private iniciarHeartbeat(): void {
    this.limparTimers();
    this.timerHeartbeat = setInterval(() => {
      this.enviarJson({ tipo: "ping", ts: Date.now() });
      // Watchdog: gateway mudo com áudio saindo = conexão morta sem FIN.
      const mudoHa = Date.now() - this.ultimoFrameGateway;
      if (this.enviandoAudio && mudoHa > RESILIENCIA.watchdogMs) {
        console.warn("[Copiloto] watchdog: gateway mudo há", mudoHa, "ms — reabrindo");
        try {
          this.socket?.close(4000, "watchdog");
        } catch {
          /* ignora */
        }
      }
    }, RESILIENCIA.heartbeatMs);
  }

  /**
   * Sem nenhuma transcrição por 45 s enquanto há áudio saindo, algo está
   * errado no servidor (Deepgram fora, fila travada). Avisamos como
   * "degradado" em vez de deixar o painel parecer vivo.
   */
  private reiniciarSilencio(): void {
    if (this.timerSilencio) clearTimeout(this.timerSilencio);
    this.timerSilencio = setTimeout(() => {
      if (this.enviandoAudio && this.pronto && !this.degradado) {
        this.degradado = true;
        this.op.aoEvento({ tipo: "degradado", motivo: "Sem transcrição há mais de 45 s" });
      }
    }, RESILIENCIA.silencioDegradadoMs);
  }

  private limparTimers(): void {
    if (this.timerReconexao) clearTimeout(this.timerReconexao);
    if (this.timerHeartbeat) clearInterval(this.timerHeartbeat);
    if (this.timerWatchdog) clearTimeout(this.timerWatchdog);
    if (this.timerSilencio) clearTimeout(this.timerSilencio);
    this.timerReconexao = this.timerHeartbeat = this.timerWatchdog = this.timerSilencio = null;
  }
}
