/**
 * Protocolo entre a extensão e o gateway (Frente B).
 *
 * Evolução direta do protótipo (`tipo: "config"`, `tipo: "transcricao"`…):
 * mesmos nomes onde já existiam, campos novos onde a produção exige
 * (sessão, lead, consentimento, feedback, retomada).
 *
 * WebSocket: `${gateway}/v1/stream?token=<JWT>`  (subprotocolo "qscopilot.v1")
 *
 * ── Frames binários (cliente → gateway) ────────────────────────────────────
 *
 *   byte 0      versao  uint8  = 0x01
 *   byte 1      flags   uint8  bit0 = reenviado_da_fila (chegou atrasado,
 *                                     não gerar sugestão ao vivo)
 *   bytes 2..3  reservado
 *   bytes 4..7  seq     uint32 LE, monotônico desde o início da sessão
 *   bytes 8..N  PCM s16le 16 kHz, 2 canais INTERCALADOS: [lead, closer, lead, closer…]
 *
 * Canal 0 = lead (aba) · canal 1 = closer (microfone). Diarização de graça.
 */

import type { Sugestao, Transcricao, ValorFeedback } from "./tipos";

export const SUBPROTOCOLO = "qscopilot.v1";
export const TAMANHO_CABECALHO = 8;
export const VERSAO_FRAME = 0x01;
export const FLAG_REENVIADO = 0b0000_0001;

// ── JSON cliente → gateway ──────────────────────────────────────────────────

export type MensagemCliente =
  | {
      /** PRIMEIRA mensagem, obrigatória. Sem ela o gateway fecha com 4401. */
      tipo: "sessao.iniciar";
      versao: 1;
      sessaoId: string;
      reuniaoId: string;
      leadId: string;
      consentimentoId: string;
      plataforma: string;
      audio: { codificacao: "linear16"; taxaAmostragem: 16000; canais: 2; temMicrofone: boolean };
      cliente: { versaoExtensao: string; chrome: string; so: string };
    }
  | {
      /** Reconexão no meio da call. O gateway responde `sessao.retomada`. */
      tipo: "sessao.retomar";
      versao: 1;
      sessaoId: string;
      ultimoSeq: number;
    }
  | { tipo: "ping"; ts: number }
  | { tipo: "captura.pausar"; sessaoId: string }
  | { tipo: "captura.retomar"; sessaoId: string }
  | { tipo: "feedback"; sessaoId: string; sugestaoId: string; valor: ValorFeedback; em: string }
  | { tipo: "encerrar"; sessaoId: string; motivo: "closer" | "aba_fechada" | "erro" };

// ── JSON gateway → cliente ──────────────────────────────────────────────────

export type MensagemGateway =
  | { tipo: "pronto"; sessaoId: string; ia: boolean; modelo?: string; heartbeatMs?: number }
  | { tipo: "sessao.retomada"; sessaoId: string; aPartirDoSeq: number }
  | { tipo: "pong"; ts: number; ultimoSeq?: number }
  | ({ tipo: "transcricao" } & Transcricao)
  | ({ tipo: "sugestao" } & Sugestao)
  | { tipo: "sugestao.retirar"; sugestaoId: string; motivo: string }
  | { tipo: "degradado"; motivo: string; niveisDesligados?: string[]; ateTs?: number }
  | { tipo: "recuperado" }
  | { tipo: "reconectando"; tentativa: number }
  | { tipo: "erro"; codigo?: string; texto: string; fatal?: boolean };

/** Códigos de fechamento que a extensão trata de forma diferente. */
export const FECHAMENTO = {
  naoAutorizado: 4401,
  sessaoInvalida: 4404,
  tetoDeDuracao: 4408,
} as const;

/** Monta o frame binário com cabeçalho de 8 bytes. */
export function montarFrame(pcm: ArrayBuffer, seq: number, reenviado: boolean): ArrayBuffer {
  const saida = new ArrayBuffer(TAMANHO_CABECALHO + pcm.byteLength);
  const visao = new DataView(saida);
  visao.setUint8(0, VERSAO_FRAME);
  visao.setUint8(1, reenviado ? FLAG_REENVIADO : 0);
  visao.setUint16(2, 0, true);
  visao.setUint32(4, seq >>> 0, true);
  new Uint8Array(saida, TAMANHO_CABECALHO).set(new Uint8Array(pcm));
  return saida;
}

/** Faz o parse defensivo de um frame de texto do gateway. */
export function lerMensagemGateway(bruto: unknown): MensagemGateway | null {
  if (typeof bruto !== "string") return null;
  try {
    const obj = JSON.parse(bruto) as { tipo?: unknown };
    if (!obj || typeof obj.tipo !== "string") return null;
    return obj as MensagemGateway;
  } catch {
    return null;
  }
}
