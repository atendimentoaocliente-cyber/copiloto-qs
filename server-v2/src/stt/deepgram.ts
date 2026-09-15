/**
 * Provedor Deepgram — streaming multicanal.
 *
 * DESCOBERTAS VALIDADAS EM PRODUÇÃO (não regredir):
 *   • `language=pt-BR` NÃO funciona. nova-2 devolve nada; nova-3 decodifica
 *     português como inglês. O combo que funciona é `model=nova-3&language=multi`.
 *   • `multichannel=true&channels=2`: canal 0 = lead, canal 1 = closer.
 *     `channel_index[0]` identifica o falante. Diarização perfeita sem IA.
 *   • O Deepgram só marca `is_final` depois de silêncio ou de `CloseStream`.
 *     `finalizar()` manda CloseStream e espera o `close` do socket (prazo 5s).
 *   • Latência medida: ~1.255 ms até a primeira palavra.
 *
 * Resiliência:
 *   • Reconexão com recuo progressivo (500ms → 8s, com jitter), até 6 tentativas.
 *   • Fila de áudio durante a queda (30 s de PCM). Ao reconectar, drena a fila —
 *     o Deepgram aceita áudio atrasado e a transcrição recupera o ritmo.
 *   • KeepAlive a cada 8 s sem áudio (o Deepgram fecha após ~10 s de silêncio).
 */
import WebSocket from "ws";
import { ProvedorStt, type EventoTranscricao, type OpcoesStt } from "./provedor.js";
import type { Logger } from "../logger.js";

export interface ConfigDeepgram {
  apiKey: string;
  modelo: string;
  idioma: string;
  log: Logger;
  /** Injetável nos testes. */
  criarSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  maxTentativas?: number;
  filaMaxBytes?: number;
  prazoFinalizacaoMs?: number;
}

const TERMOS_PADRAO = [
  "Maldivas", "Bora Bora", "Punta Cana", "Capadócia", "Phuket", "Krabi",
  "Fernando de Noronha", "all inclusive", "half board", "transfer",
  "Universal", "Epcot", "Magic Kingdom", "overwater", "seguro viagem",
  "eSIM", "Schengen", "ETIAS", "taxa de embarque", "pacote", "roteiro",
  "parcelamento", "sinal", "embarque", "cruzeiro", "traslado", "Porto Rico", "Tailândia",
];

export class ProvedorDeepgram extends ProvedorStt {
  readonly nome = "deepgram";
  readonly modelo: string;

  private socket: WebSocket | null = null;
  private pronto = false;
  private encerrando = false;
  private destruido = false;
  private tentativas = 0;
  private fila: Buffer[] = [];
  private filaBytes = 0;
  private descartados = 0;
  private primeiroEnvioEm: number | null = null;
  private primeiraPalavraEmitida = false;
  private keepAlive: NodeJS.Timeout | null = null;
  private ultimoEnvio = 0;
  private timerReconexao: NodeJS.Timeout | null = null;

  private readonly maxTentativas: number;
  private readonly filaMaxBytes: number;
  private readonly prazoFinalizacaoMs: number;

  constructor(
    private readonly cfg: ConfigDeepgram,
    private readonly opcoes: OpcoesStt,
  ) {
    super();
    this.modelo = cfg.modelo;
    this.maxTentativas = cfg.maxTentativas ?? 6;
    // 30 s de PCM linear16 @ taxa × canais × 2 bytes
    this.filaMaxBytes = cfg.filaMaxBytes ?? 30 * opcoes.taxaAmostragem * opcoes.canais * 2;
    this.prazoFinalizacaoMs = cfg.prazoFinalizacaoMs ?? 5000;
  }

  get bytesDescartados(): number {
    return this.descartados;
  }

  /** Monta a URL. Exportada para o teste garantir que ninguém volte para pt-BR. */
  static montarUrl(modelo: string, idioma: string, opcoes: OpcoesStt): string {
    const p = new URLSearchParams({
      model: modelo,
      language: idioma,
      encoding: "linear16",
      sample_rate: String(opcoes.taxaAmostragem),
      channels: String(opcoes.canais),
      multichannel: "true",
      interim_results: "true",
      endpointing: "200",
      utterance_end_ms: "1000",
      punctuate: "true",
      smart_format: "true",
      vad_events: "true",
    });
    const chave = modelo.startsWith("nova-3") ? "keyterm" : "keywords";
    for (const t of opcoes.termos ?? TERMOS_PADRAO) p.append(chave, t);
    return `wss://api.deepgram.com/v1/listen?${p.toString()}`;
  }

  conectar(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destruido) return reject(new Error("provedor destruído"));
      const url = ProvedorDeepgram.montarUrl(this.cfg.modelo, this.cfg.idioma, this.opcoes);
      const headers = { Authorization: `Token ${this.cfg.apiKey}` };
      const ws = this.cfg.criarSocket ? this.cfg.criarSocket(url, headers) : new WebSocket(url, { headers });
      this.socket = ws;
      let resolvido = false;

      ws.on("open", () => {
        this.pronto = true;
        this.tentativas = 0;
        this.cfg.log.info({ modelo: this.cfg.modelo, idioma: this.cfg.idioma }, "deepgram conectado");
        this.emit("estado", { estado: "conectado", tentativa: this.tentativas });
        this.drenarFila();
        this.iniciarKeepAlive();
        if (!resolvido) {
          resolvido = true;
          resolve();
        }
      });

      ws.on("message", (bruto) => this.tratarMensagem(bruto));

      ws.on("error", (err) => {
        this.cfg.log.error({ err }, "deepgram erro no socket");
        this.emit("erro", new Error(`transcrição: ${err.message}`));
        if (!resolvido) {
          resolvido = true;
          reject(err);
        }
      });

      ws.on("close", (codigo, motivo) => {
        this.pronto = false;
        this.pararKeepAlive();
        if (this.encerrando || this.destruido) return;
        this.agendarReconexao(codigo, motivo.toString());
      });
    });
  }

  enviar(pcm: Buffer): void {
    if (this.destruido || this.encerrando) return;
    if (this.primeiroEnvioEm === null) this.primeiroEnvioEm = Date.now();
    if (this.pronto && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(pcm);
      this.ultimoEnvio = Date.now();
      return;
    }
    // Caído: enfileira. Se estourar 30 s, descarta o mais antigo (e conta).
    this.fila.push(pcm);
    this.filaBytes += pcm.length;
    while (this.filaBytes > this.filaMaxBytes && this.fila.length) {
      const velho = this.fila.shift()!;
      this.filaBytes -= velho.length;
      this.descartados += velho.length;
    }
  }

  /**
   * Manda CloseStream e espera o Deepgram devolver os finais pendentes.
   * Sem isso as últimas falas da call se perdem. Prazo máximo: 5 s.
   */
  finalizar(): Promise<void> {
    this.encerrando = true;
    this.pararKeepAlive();
    if (this.timerReconexao) clearTimeout(this.timerReconexao);
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();

    return new Promise((resolve) => {
      let concluido = false;
      const concluir = () => {
        if (concluido) return;
        concluido = true;
        clearTimeout(prazo);
        resolve();
      };
      const prazo = setTimeout(() => {
        this.cfg.log.warn("deepgram não fechou no prazo após CloseStream; fechando à força");
        try {
          ws.close();
        } catch {
          /* já fechado */
        }
        concluir();
      }, this.prazoFinalizacaoMs);
      ws.once("close", concluir);
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch (err) {
        this.cfg.log.warn({ err }, "falha ao enviar CloseStream");
        concluir();
      }
    });
  }

  destruir(): void {
    this.destruido = true;
    this.encerrando = true;
    this.pararKeepAlive();
    if (this.timerReconexao) clearTimeout(this.timerReconexao);
    try {
      this.socket?.terminate();
    } catch {
      /* já fechado */
    }
    this.fila = [];
    this.filaBytes = 0;
  }

  // ── internos ──────────────────────────────────────────────────────────────

  private tratarMensagem(bruto: WebSocket.RawData): void {
    let msg: DeepgramMensagem;
    try {
      msg = JSON.parse(bruto.toString()) as DeepgramMensagem;
    } catch (err) {
      this.emit("erro", new Error(`transcrição: mensagem ilegível do Deepgram (${String(err)})`));
      return;
    }
    if (msg.type === "Results") {
      const alternativa = msg.channel?.alternatives?.[0];
      const texto = alternativa?.transcript?.trim();
      if (!texto) return;
      if (!this.primeiraPalavraEmitida && this.primeiroEnvioEm !== null) {
        this.primeiraPalavraEmitida = true;
        this.emit("primeira_palavra", Date.now() - this.primeiroEnvioEm);
      }
      const canal = (msg.channel_index?.[0] ?? 0) === 0 ? 0 : 1;
      const ev: EventoTranscricao = {
        texto,
        canal,
        final: Boolean(msg.is_final),
        confianca: typeof alternativa?.confidence === "number" ? alternativa.confidence : null,
        inicioMs: typeof msg.start === "number" ? Math.round(msg.start * 1000) : null,
        fimMs:
          typeof msg.start === "number" && typeof msg.duration === "number"
            ? Math.round((msg.start + msg.duration) * 1000)
            : null,
      };
      this.emit("transcricao", ev);
      return;
    }
    if (msg.type === "Error") {
      this.emit("erro", new Error(`transcrição: ${msg.message ?? "erro do Deepgram"}`));
      return;
    }
    // Metadata, UtteranceEnd, SpeechStarted: informativos; não geram ação.
  }

  private drenarFila(): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (this.fila.length) {
      const pedaco = this.fila.shift()!;
      this.filaBytes -= pedaco.length;
      ws.send(pedaco);
    }
    this.ultimoEnvio = Date.now();
  }

  private agendarReconexao(codigo: number, motivo: string): void {
    this.tentativas++;
    if (this.tentativas > this.maxTentativas) {
      const msg = `transcrição caiu e não reconectou após ${this.maxTentativas} tentativas (código ${codigo})`;
      this.cfg.log.error({ codigo, motivo }, msg);
      this.emit("estado", { estado: "caiu", motivo: msg });
      this.emit("erro", new Error(msg));
      return;
    }
    const base = Math.min(500 * 2 ** (this.tentativas - 1), 8000);
    const espera = base + Math.floor(Math.random() * 200);
    this.cfg.log.warn({ codigo, motivo, tentativa: this.tentativas, esperaMs: espera }, "deepgram caiu; reconectando");
    this.emit("estado", { estado: "reconectando", tentativa: this.tentativas, esperaMs: espera });
    this.timerReconexao = setTimeout(() => {
      this.conectar().catch((err) => {
        // O `close` do socket que falhou vai agendar a próxima tentativa.
        this.cfg.log.warn({ err }, "tentativa de reconexão falhou");
      });
    }, espera);
  }

  private iniciarKeepAlive(): void {
    this.pararKeepAlive();
    this.keepAlive = setInterval(() => {
      const ws = this.socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.ultimoEnvio < 8000) return;
      try {
        ws.send(JSON.stringify({ type: "KeepAlive" }));
      } catch (err) {
        this.cfg.log.warn({ err }, "falha no KeepAlive");
      }
    }, 4000);
  }

  private pararKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }
}

interface DeepgramMensagem {
  type: string;
  channel_index?: number[];
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
  message?: string;
}
