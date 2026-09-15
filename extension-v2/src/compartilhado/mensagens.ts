/**
 * Contratos de mensagens entre os contextos da extensão.
 *
 *   content ──► background   (ParaBackground)
 *   background ──► content   (ParaContent)
 *   background ──► offscreen (ParaOffscreen)
 *   offscreen ──► background (ParaBackground, tipo AUDIO_EVENTO)
 *
 * Todo objeto leva `destino` para que cada listener ignore o que não é dele
 * — mesma disciplina do protótipo, agora tipada.
 */

import type {
  AvisoTela,
  Briefing,
  Consentimento,
  EstadoAoVivo,
  Reuniao,
  Sessao,
  Sugestao,
  Transcricao,
  ValorFeedback,
} from "./tipos";

// ── Eventos gerados pelo offscreen (canal de áudio) ─────────────────────────

export type EventoAudio =
  | { tipo: "capturando"; taxaNativa: number; temMicrofone: boolean }
  | { tipo: "conectado" }
  | { tipo: "pronto"; ia: boolean; modelo?: string }
  | { tipo: "reconectando"; tentativa: number; maximo: number; filaSegundos: number }
  | { tipo: "degradado"; motivo: string }
  | { tipo: "recuperado" }
  | { tipo: "transcricao"; dados: Transcricao }
  | { tipo: "sugestao"; dados: Sugestao }
  | { tipo: "sugestao_retirada"; sugestaoId: string; motivo: string }
  | { tipo: "erro"; texto: string; fatal: boolean }
  | { tipo: "aviso"; texto: string }
  | { tipo: "parado" };

// ── content / offscreen → background ────────────────────────────────────────

export type ParaBackground =
  | { destino: "background"; tipo: "PAINEL_PRONTO" }
  | { destino: "background"; tipo: "PARAR" }
  | { destino: "background"; tipo: "ABRIR_OPCOES" }
  | { destino: "background"; tipo: "LEAD_ESCOLHIDO"; reuniaoId: string }
  | { destino: "background"; tipo: "RECARREGAR_REUNIOES" }
  | { destino: "background"; tipo: "CONSENTIMENTO_CONFIRMADO"; confirmadoEm: string }
  | { destino: "background"; tipo: "CONSENTIMENTO_RECUSADO" }
  | { destino: "background"; tipo: "INICIAR_ESCUTA" }
  | { destino: "background"; tipo: "PAUSAR" }
  | { destino: "background"; tipo: "RETOMAR" }
  | { destino: "background"; tipo: "RECONECTAR" }
  | { destino: "background"; tipo: "FEEDBACK"; sugestaoId: string; valor: ValorFeedback; categoria: string }
  | { destino: "background"; tipo: "TELA"; aviso: AvisoTela }
  | { destino: "background"; tipo: "AUDIO_EVENTO"; evento: EventoAudio };

// ── background → content ────────────────────────────────────────────────────

export type TelaPreCall =
  | { tela: "carregando"; texto: string }
  | { tela: "sem_pareamento" }
  | { tela: "reunioes"; reunioes: Reuniao[]; erro?: string }
  | { tela: "consentimento"; reuniao: Reuniao; texto: string }
  | { tela: "briefing"; reuniao: Reuniao; briefing: Briefing | null; erroBriefing?: string }
  | { tela: "recusado" }
  | { tela: "erro"; texto: string; acao?: "reinvocar" };

export type ParaContent =
  | { destino: "content"; tipo: "PING" }
  | { destino: "content"; tipo: "MOSTRAR_PAINEL"; sessao: Sessao }
  | { destino: "content"; tipo: "MOSTRAR_TELA"; dados: TelaPreCall }
  | { destino: "content"; tipo: "ESCUTA_INICIADA"; sessao: Sessao }
  | { destino: "content"; tipo: "AUDIO_EVENTO"; evento: EventoAudio }
  | { destino: "content"; tipo: "ATALHO"; comando: "marcar-usei" | "marcar-nao-serviu" | "silenciar" }
  | { destino: "content"; tipo: "PARAR_PAINEL" };

// ── background → offscreen ──────────────────────────────────────────────────

export interface ParametrosCaptura {
  streamId: string;
  gateway: string;
  token: string;
  sessaoId: string;
  reuniaoId: string;
  leadId: string;
  consentimentoId: string;
  plataforma: string;
}

export type ParaOffscreen =
  | { destino: "offscreen"; tipo: "INICIAR"; parametros: ParametrosCaptura }
  | { destino: "offscreen"; tipo: "PAUSAR" }
  | { destino: "offscreen"; tipo: "RETOMAR" }
  | { destino: "offscreen"; tipo: "RECONECTAR" }
  | { destino: "offscreen"; tipo: "FEEDBACK"; sugestaoId: string; valor: ValorFeedback }
  | { destino: "offscreen"; tipo: "PARAR" };

export type Mensagem = ParaBackground | ParaContent | ParaOffscreen;

/**
 * `Omit` distributivo: preserva a união discriminada ao tirar `destino`.
 * (`Omit<A | B, K>` comum colapsa a união numa interseção de chaves comuns.)
 */
export type SemDestino<T> = T extends unknown ? Omit<T, "destino"> : never;

/** Utilitário: identifica o destino sem precisar de cast em todo listener. */
export function ehPara<D extends Mensagem["destino"]>(
  msg: unknown,
  destino: D,
): msg is Extract<Mensagem, { destino: D }> {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { destino?: string }).destino === destino
  );
}

/** Envia para o service worker e ignora a ausência de resposta. */
export function enviarParaBackground(msg: SemDestino<ParaBackground>): void {
  chrome.runtime
    .sendMessage({ destino: "background", ...msg } as ParaBackground)
    .catch(() => {});
}

/** Consulta/despacho do estado ao vivo — usado só pelo painel. */
export type { EstadoAoVivo, Consentimento };
