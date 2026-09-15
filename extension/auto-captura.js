/**
 * Captura automática — sem clique nenhum.
 *
 * Por que não usa chrome.tabCapture: aquela API exige que o usuário invoque a
 * extensão (clique no ícone ou atalho). É uma trava do Chrome e não tem volta.
 *
 * Caminho alternativo: o Google Meet toca a voz de cada participante em
 * elementos <audio> da própria página. `HTMLMediaElement.captureStream()`
 * devolve o áudio desses elementos sem pedir permissão nenhuma — e o content
 * script já roda automaticamente em meet.google.com.
 *
 *   elementos <audio> do Meet  → canal 0 (LEAD)
 *   getUserMedia(microfone)    → canal 1 (CLOSER)
 *
 * O microfone continua precisando de permissão, mas ela é concedida uma única
 * vez (permissao.html) e vale para sempre.
 */

const TAXA_ALVO = 16000;

export class AutoCaptura {
  constructor({ servidor, aoEvento }) {
    this.servidor = servidor;
    this.aoEvento = aoEvento;
    this.contexto = null;
    this.socket = null;
    this.worklet = null;
    this.combinador = null;
    this.streamMic = null;
    this.capturados = new WeakSet();
    this.observador = null;
    this.ativa = false;
    this.tentativas = 0;
    this.timerReconexao = null;
  }

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  async iniciar() {
    if (this.ativa) return;
    this.ativa = true;

    this.contexto = new AudioContext();
    this.combinador = this.contexto.createChannelMerger(2);

    await this.contexto.audioWorklet.addModule(
      chrome.runtime.getURL("pcm-worklet.js")
    );
    this.worklet = new AudioWorkletNode(this.contexto, "processador-pcm", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    this.combinador.connect(this.worklet);

    // O worklet precisa estar conectado para rodar, mas não deve soar.
    const mudo = this.contexto.createGain();
    mudo.gain.value = 0;
    this.worklet.connect(mudo).connect(this.contexto.destination);

    this.worklet.port.onmessage = (e) => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(e.data);
    };

    await this.ligarMicrofone();
    this.vigiarElementosDeAudio();
    this.conectar();

    this.aoEvento({ tipo: "INICIADA", taxa: this.contexto.sampleRate });
  }

  parar() {
    this.ativa = false;
    clearTimeout(this.timerReconexao);
    this.observador?.disconnect();
    this.observador = null;

    try {
      this.worklet?.port.close();
      this.worklet?.disconnect();
    } catch {}
    this.worklet = null;

    this.streamMic?.getTracks().forEach((t) => t.stop());
    this.streamMic = null;

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ tipo: "encerrar" }));
    }
    this.socket?.close();
    this.socket = null;

    this.contexto?.close();
    this.contexto = null;
    this.aoEvento({ tipo: "PARADA" });
  }

  // ── Áudio do lead: elementos <audio> do Meet ──────────────────────────────

  /**
   * O Meet cria e destrói elementos de áudio conforme gente entra, sai e
   * liga a câmera. Por isso não basta varrer uma vez: observamos a página
   * inteira e capturamos cada elemento novo que aparecer.
   */
  vigiarElementosDeAudio() {
    const varrer = () => {
      for (const el of document.querySelectorAll("audio, video")) {
        this.capturarElemento(el);
      }
    };

    varrer();
    this.observador = new MutationObserver(varrer);
    this.observador.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    // Rede de segurança: o Meet às vezes troca a fonte sem mexer no DOM.
    this.timerVarredura = setInterval(varrer, 3000);
  }

  capturarElemento(el) {
    if (this.capturados.has(el)) return;
    if (!el.srcObject && !el.src) return;

    try {
      const stream = el.captureStream?.() ?? el.mozCaptureStream?.();
      if (!stream || stream.getAudioTracks().length === 0) return;

      const fonte = this.contexto.createMediaStreamSource(stream);
      fonte.connect(this.combinador, 0, 0); // canal 0 = lead
      this.capturados.add(el);
      this.aoEvento({ tipo: "PARTICIPANTE", total: this.contarCapturados() });
    } catch {
      /* elemento ainda não pronto — a próxima varredura pega */
    }
  }

  contarCapturados() {
    return document.querySelectorAll("audio, video").length;
  }

  // ── Áudio do closer: microfone ────────────────────────────────────────────

  async ligarMicrofone() {
    try {
      this.streamMic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const fonte = this.contexto.createMediaStreamSource(this.streamMic);
      fonte.connect(this.combinador, 0, 1); // canal 1 = closer
    } catch (err) {
      this.streamMic = null;
      this.aoEvento({
        tipo: "AVISO",
        texto: "Microfone bloqueado — só o cliente será transcrito.",
      });
    }
  }

  // ── Servidor ──────────────────────────────────────────────────────────────

  conectar() {
    if (!this.ativa) return;
    const url = this.servidor.replace(/^http/, "ws") + "/ws";
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      this.tentativas = 0;
      this.socket.send(JSON.stringify({
        tipo: "config",
        taxaAmostragem: TAXA_ALVO,
        canais: 2,
        temMicrofone: Boolean(this.streamMic),
      }));
      this.aoEvento({ tipo: "CONECTADA" });
    };

    this.socket.onmessage = (e) => {
      try {
        this.aoEvento({ tipo: "SERVIDOR", payload: JSON.parse(e.data) });
      } catch {}
    };

    this.socket.onclose = () => {
      if (!this.ativa) return;
      this.tentativas++;
      if (this.tentativas > 8) {
        this.aoEvento({ tipo: "ERRO", texto: "Servidor fora do ar." });
        return;
      }
      const espera = Math.min(500 * 2 ** (this.tentativas - 1), 8000);
      this.aoEvento({ tipo: "RECONECTANDO", tentativa: this.tentativas });
      this.timerReconexao = setTimeout(() => this.conectar(), espera);
    };
  }
}
