/**
 * Offscreen Document — onde o áudio realmente é capturado.
 *
 * MV3: o service worker não tem AudioContext e morre por inatividade.
 * Este documento vive enquanto a call durar e concentra:
 *
 *   grafo de áudio (grafo-audio.ts)  →  PCM 16 kHz 2 canais (pcm-worklet.js)
 *                                    →  cliente WS resiliente (cliente-ws.ts)
 *
 * Só recebe ordens do service worker e devolve eventos tipados
 * (`AUDIO_EVENTO`) — o painel nunca fala direto com este contexto.
 */

import { ehPara, type EventoAudio, type ParametrosCaptura } from "@/compartilhado/mensagens";
import { ClienteWs } from "./cliente-ws";
import { montarGrafo, type GrafoAudio } from "./grafo-audio";

let grafo: GrafoAudio | null = null;
let cliente: ClienteWs | null = null;

function avisar(evento: EventoAudio): void {
  chrome.runtime.sendMessage({ destino: "background", tipo: "AUDIO_EVENTO", evento }).catch(() => {});
}

async function iniciar(p: ParametrosCaptura): Promise<void> {
  if (grafo || cliente) parar("erro");

  try {
    grafo = await montarGrafo({
      streamId: p.streamId,
      aoReceberPcm: (pcm) => cliente?.enviarAudio(pcm),
      aoAvisar: (texto) => avisar({ tipo: "aviso", texto }),
    });
  } catch (err) {
    console.error("[Copiloto] erro ao montar o grafo de áudio:", err);
    avisar({ tipo: "erro", texto: `Não consegui capturar o áudio: ${(err as Error).message}`, fatal: true });
    parar("erro");
    return;
  }

  avisar({
    tipo: "capturando",
    taxaNativa: grafo.contexto.sampleRate,
    temMicrofone: Boolean(grafo.streamMic),
  });

  cliente = new ClienteWs({
    parametros: p,
    temMicrofone: Boolean(grafo.streamMic),
    aoEvento: avisar,
  });
  cliente.conectar();
}

function parar(motivo: "closer" | "aba_fechada" | "erro"): void {
  cliente?.encerrar(motivo);
  cliente = null;
  grafo?.desmontar();
  grafo = null;
  avisar({ tipo: "parado" });
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (!ehPara(msg, "offscreen")) return;
  switch (msg.tipo) {
    case "INICIAR":
      void iniciar(msg.parametros);
      break;
    case "PAUSAR":
      grafo?.pausar(true);
      cliente?.pausar(true);
      break;
    case "RETOMAR":
      grafo?.pausar(false);
      cliente?.pausar(false);
      break;
    case "FEEDBACK":
      cliente?.feedback(msg.sugestaoId, msg.valor);
      break;
    case "RECONECTAR":
      cliente?.reconectarManual();
      break;
    case "PARAR":
      parar("closer");
      break;
  }
});

export {};
