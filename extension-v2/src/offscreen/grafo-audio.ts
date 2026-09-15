/**
 * Grafo de áudio — duas fontes, dois canais, um loopback obrigatório.
 *
 *   canal 0 = áudio da ABA (o LEAD)
 *   canal 1 = MICROFONE   (o CLOSER)
 *
 * ⚠️ INVARIANTE DE PRODUÇÃO: `chrome.tabCapture` SILENCIA a aba capturada.
 * Sem religar a fonte da aba em `contexto.destination`, o closer para de
 * ouvir o lead e a call morre. Está em `fonteAba.connect(contexto.destination)`
 * e nunca pode ser removido.
 *
 * O AudioContext roda na taxa NATIVA da placa (48 kHz em geral) porque o
 * mesmo contexto devolve o som ao fone. O downsample para 16 kHz acontece
 * dentro do AudioWorklet (public/pcm-worklet.js).
 */

export interface GrafoAudio {
  contexto: AudioContext;
  streamAba: MediaStream;
  streamMic: MediaStream | null;
  worklet: AudioWorkletNode;
  /** Silencia/reativa a saída do worklet sem derrubar a captura. */
  pausar(pausado: boolean): void;
  desmontar(): void;
}

export interface OpcoesGrafo {
  streamId: string;
  aoReceberPcm: (pcm: ArrayBuffer) => void;
  aoAvisar: (texto: string) => void;
}

export async function montarGrafo(op: OpcoesGrafo): Promise<GrafoAudio> {
  // ── 1. Áudio da aba (o lead) — o streamId expira em segundos, então esta
  //      chamada precisa ser a primeira coisa a acontecer.
  const streamAba = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: op.streamId,
      },
    },
    video: false,
  });

  // ── 2. Microfone (o closer) — opcional. Sem ele, seguimos só com o lead.
  let streamMic: MediaStream | null = null;
  try {
    streamMic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.warn("[Copiloto] microfone indisponível:", (err as Error).name);
    op.aoAvisar(
      "Microfone não autorizado — transcrevendo só o lead. Libere na página de opções da extensão.",
    );
  }

  // ── 3. Grafo
  const contexto = new AudioContext();
  const fonteAba = contexto.createMediaStreamSource(streamAba);
  const fonteMic = streamMic ? contexto.createMediaStreamSource(streamMic) : null;

  // ⚠️ CRÍTICO: devolve o áudio do lead ao fone do closer. NUNCA remover.
  fonteAba.connect(contexto.destination);

  await contexto.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  const worklet = new AudioWorkletNode(contexto, "processador-pcm", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "discrete",
  });

  // Junta as duas fontes num sinal de 2 canais discretos.
  const combinador = contexto.createChannelMerger(2);
  fonteAba.connect(combinador, 0, 0); // canal 0 = lead
  if (fonteMic) fonteMic.connect(combinador, 0, 1); // canal 1 = closer
  combinador.connect(worklet);

  // O worklet precisa estar ligado à saída para processar, mas não deve soar.
  const mudo = contexto.createGain();
  mudo.gain.value = 0;
  worklet.connect(mudo).connect(contexto.destination);

  let pausado = false;
  worklet.port.onmessage = (evento: MessageEvent<ArrayBuffer>) => {
    if (!pausado) op.aoReceberPcm(evento.data);
  };

  // Se o Chrome derrubar uma das faixas (fone desconectado, aba mudou de
  // dispositivo…), avisamos em vez de ficar mudo.
  for (const faixa of streamAba.getAudioTracks()) {
    faixa.addEventListener("ended", () => op.aoAvisar("O áudio da aba parou de chegar."));
  }

  return {
    contexto,
    streamAba,
    streamMic,
    worklet,
    pausar(valor) {
      pausado = valor;
    },
    desmontar() {
      try {
        worklet.port.close();
        worklet.disconnect();
      } catch {
        /* já desconectado */
      }
      streamAba.getTracks().forEach((t) => t.stop());
      streamMic?.getTracks().forEach((t) => t.stop());
      void contexto.close();
    },
  };
}
