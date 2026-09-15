/**
 * Offscreen Document — onde o áudio realmente é capturado.
 *
 * Duas fontes, dois canais:
 *   canal 0 = áudio da ABA do Meet  -> a voz do LEAD
 *   canal 1 = MICROFONE             -> a voz do CLOSER
 *
 * Capturar em canais separados dá diarização perfeita de graça:
 * não precisamos adivinhar quem falou, sabemos pela origem do sinal.
 */

let contexto = null;
let socket = null;
let streamAba = null;
let streamMic = null;
let noWorklet = null;
let heartbeat = null;
let parando = false;
let tentativasWs = 0;
let timerReconexao = null;
let servidorAtual = null;

function avisar(tipo, dados = {}) {
  chrome.runtime.sendMessage({ destino: "content", tipo, ...dados });
}

async function iniciar(streamId, servidor) {
  try {
    // ── 1. Áudio da aba (o lead) ────────────────────────────────────────────
    streamAba = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    // ── 2. Microfone (o closer) — opcional ──────────────────────────────────
    // Se a permissão não tiver sido concedida ainda, seguimos só com o lead.
    try {
      streamMic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      console.warn("[Copiloto] microfone indisponível:", err.name);
      streamMic = null;
      avisar("AVISO", {
        texto:
          "Microfone não autorizado — transcrevendo só o lead. Abra a página de permissão da extensão para liberar.",
      });
    }

    // ── 3. Grafo de áudio ───────────────────────────────────────────────────
    // Taxa NATIVA (não força 16 kHz) porque este mesmo contexto devolve
    // o som do lead para o fone do closer. O downsample é feito no worklet.
    contexto = new AudioContext();

    const fonteAba = contexto.createMediaStreamSource(streamAba);
    const fonteMic = streamMic
      ? contexto.createMediaStreamSource(streamMic)
      : null;

    // ⚠️ CRÍTICO: chrome.tabCapture SILENCIA a aba.
    // Sem esta linha, o closer para de ouvir o lead e a call morre.
    fonteAba.connect(contexto.destination);

    await contexto.audioWorklet.addModule(
      chrome.runtime.getURL("pcm-worklet.js")
    );
    noWorklet = new AudioWorkletNode(contexto, "processador-pcm", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });

    // Junta as duas fontes em um sinal de 2 canais discretos
    const combinador = contexto.createChannelMerger(2);
    fonteAba.connect(combinador, 0, 0); // canal 0 = lead
    if (fonteMic) fonteMic.connect(combinador, 0, 1); // canal 1 = closer
    combinador.connect(noWorklet);

    // O worklet precisa estar conectado para processar, mas não deve soar.
    const mudo = contexto.createGain();
    mudo.gain.value = 0;
    noWorklet.connect(mudo).connect(contexto.destination);

    // Áudio -> servidor. Sobrevive à reconexão porque consulta o socket atual.
    noWorklet.port.onmessage = (evento) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(evento.data);
    };

    // ── 4. Conexão com o servidor ───────────────────────────────────────────
    servidorAtual = servidor;
    conectarServidor(servidor);
  } catch (err) {
    console.error("[Copiloto] erro ao iniciar captura:", err);
    avisar("ERRO", { texto: err.message });
    parar();
  }
}

function conectarServidor(servidor) {
  try {
    const url = servidor.replace(/^http/, "ws") + "/ws";
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      tentativasWs = 0;
      socket.send(
        JSON.stringify({
          tipo: "config",
          taxaAmostragem: 16000,
          canais: 2,
          temMicrofone: Boolean(streamMic),
        })
      );
      avisar("CONECTADO");
      heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ tipo: "ping" }));
        }
      }, 5000);
    };

    socket.onmessage = (evento) => {
      try {
        const msg = JSON.parse(evento.data);
        avisar("SERVIDOR", { payload: msg });
      } catch {
        /* ignora */
      }
    };

    socket.onerror = () => {
      avisar("ERRO", {
        texto: "Não consegui falar com o servidor. Ele está rodando?",
      });
    };

    socket.onclose = () => {
      if (parando) return;
      // Oscilação de internet não pode matar a call: reconecta sozinho.
      tentativasWs++;
      if (tentativasWs > 8) {
        avisar("ERRO", { texto: "Perdi o servidor e não consegui voltar." });
        return;
      }
      const espera = Math.min(500 * 2 ** (tentativasWs - 1), 8000);
      avisar("RECONECTANDO", { tentativa: tentativasWs });
      clearTimeout(timerReconexao);
      timerReconexao = setTimeout(() => conectarServidor(servidorAtual), espera);
    };

    avisar("CAPTURANDO", { taxaNativa: contexto?.sampleRate });
  } catch (err) {
    console.error("[Copiloto] erro ao conectar:", err);
    avisar("ERRO", { texto: err.message });
  }
}

function parar() {
  parando = true;
  clearTimeout(timerReconexao);
  clearInterval(heartbeat);
  heartbeat = null;

  try {
    noWorklet?.port.close();
    noWorklet?.disconnect();
  } catch {}
  noWorklet = null;

  streamAba?.getTracks().forEach((t) => t.stop());
  streamMic?.getTracks().forEach((t) => t.stop());
  streamAba = null;
  streamMic = null;

  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ tipo: "encerrar" }));
  }
  socket?.close();
  socket = null;

  contexto?.close();
  contexto = null;

  avisar("PARADO");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.destino !== "offscreen") return;
  if (msg.tipo === "INICIAR") { parando = false; tentativasWs = 0; iniciar(msg.streamId, msg.servidor); }
  if (msg.tipo === "PARAR") parar();
});
