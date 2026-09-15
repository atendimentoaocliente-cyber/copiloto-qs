/**
 * Protocolo WebSocket extensão ⇄ gateway — contrato `qscopilot.v1`.
 *
 * FONTE DA VERDADE: `extension-v2/src/compartilhado/protocolo.ts` e `tipos.ts`.
 * Este arquivo espelha aquele contrato do lado do servidor. Mudou lá, muda aqui.
 *
 *   WebSocket: `${gateway}/v1/stream?token=<JWT>` (subprotocolo "qscopilot.v1")
 *
 * ── Frames binários (extensão → gateway) ───────────────────────────────────
 *   byte 0      versao  uint8  = 0x01
 *   byte 1      flags   uint8  bit0 = reenviado_da_fila (chegou atrasado:
 *                                     transcreve, mas NÃO gera sugestão ao vivo)
 *   bytes 2..3  reservado
 *   bytes 4..7  seq     uint32 LE, monotônico desde o início da sessão
 *   bytes 8..N  PCM s16le 16 kHz, 2 canais intercalados [lead, closer, …]
 *
 * Canal 0 = lead (aba) · canal 1 = closer (microfone).
 */
import { z } from "zod";
import { ErroValidacao } from "../util/erros.js";

export const SUBPROTOCOLO = "qscopilot.v1";
export const VERSAO_PROTOCOLO = 1 as const;
export const TAMANHO_CABECALHO = 8;
export const VERSAO_FRAME = 0x01;
export const FLAG_REENVIADO = 0b0000_0001;

/** Códigos de fechamento que a extensão trata de forma diferente (fatais, sem reconexão). */
export const FECHAMENTO = {
  naoAutorizado: 4401,
  sessaoInvalida: 4404,
  tetoDeDuracao: 4408,
} as const;

// ── Frame binário ────────────────────────────────────────────────────────────

export interface Frame {
  seq: number;
  reenviado: boolean;
  pcm: Buffer;
}

/** Lê o cabeçalho de 8 bytes. Lança ErroValidacao em frame malformado — nunca ignora em silêncio. */
export function lerFrame(buf: Buffer): Frame {
  if (buf.length < TAMANHO_CABECALHO) throw new ErroValidacao(`frame com ${buf.length} bytes (< ${TAMANHO_CABECALHO})`);
  const versao = buf.readUInt8(0);
  if (versao !== VERSAO_FRAME) throw new ErroValidacao(`versão de frame ${versao} não suportada (esperado ${VERSAO_FRAME})`);
  const flags = buf.readUInt8(1);
  const seq = buf.readUInt32LE(4);
  const pcm = buf.subarray(TAMANHO_CABECALHO);
  if (pcm.length % 4 !== 0) throw new ErroValidacao(`PCM com ${pcm.length} bytes não fecha em amostras estéreo s16le`);
  return { seq, reenviado: (flags & FLAG_REENVIADO) !== 0, pcm };
}

// ── JSON extensão → gateway (validado com Zod) ───────────────────────────────

export const ValorFeedback = z.enum(["usei", "nao_serviu", "ignorou"]);
export type ValorFeedback = z.infer<typeof ValorFeedback>;

/** Feedback da extensão → `outcome` de qs_copilot_detections. */
export const OUTCOME_POR_FEEDBACK: Record<ValorFeedback, "usada" | "nao_util" | "ignorada"> = {
  usei: "usada",
  nao_serviu: "nao_util",
  ignorou: "ignorada",
};

export const MsgSessaoIniciar = z.object({
  tipo: z.literal("sessao.iniciar"),
  versao: z.literal(1),
  /** UUID gerado no cliente. Vira o id de qs_call_sessions. */
  sessaoId: z.uuid(),
  reuniaoId: z.uuid(),
  leadId: z.uuid(),
  consentimentoId: z.uuid(),
  plataforma: z.string().max(40),
  audio: z.object({
    codificacao: z.literal("linear16"),
    taxaAmostragem: z.literal(16000),
    canais: z.literal(2),
    temMicrofone: z.boolean(),
  }),
  cliente: z.object({ versaoExtensao: z.string().max(40), chrome: z.string().max(40), so: z.string().max(80) }),
});
export type MsgSessaoIniciar = z.infer<typeof MsgSessaoIniciar>;

export const MsgSessaoRetomar = z.object({
  tipo: z.literal("sessao.retomar"),
  versao: z.literal(1),
  sessaoId: z.uuid(),
  ultimoSeq: z.number().int().min(-1),
});
export type MsgSessaoRetomar = z.infer<typeof MsgSessaoRetomar>;

export const MensagemCliente = z.discriminatedUnion("tipo", [
  MsgSessaoIniciar,
  MsgSessaoRetomar,
  z.object({ tipo: z.literal("ping"), ts: z.number() }),
  z.object({ tipo: z.literal("captura.pausar"), sessaoId: z.uuid() }),
  z.object({ tipo: z.literal("captura.retomar"), sessaoId: z.uuid() }),
  z.object({ tipo: z.literal("feedback"), sessaoId: z.uuid(), sugestaoId: z.uuid(), valor: ValorFeedback, em: z.iso.datetime() }),
  z.object({ tipo: z.literal("encerrar"), sessaoId: z.uuid(), motivo: z.enum(["closer", "aba_fechada", "erro"]) }),
]);
export type MensagemCliente = z.infer<typeof MensagemCliente>;

// ── JSON gateway → extensão ──────────────────────────────────────────────────

export type Falante = "lead" | "closer";
export type NivelSugestao = "sugestao" | "atencao";
/** Como a extensão rotula a origem. gatilho/banco → playbook; L3 → ia. */
export type FonteCard = "playbook" | "ia" | "gestor";

/** Card que o painel mostra. UMA frase. Nunca bullets. */
export interface SugestaoCard {
  id: string;
  categoria: string;
  /** ≤ 68 caracteres no painel (ele trunca). Aqui: ≤ 20 palavras. */
  frase: string;
  nivel: NivelSugestao;
  /** Trecho da fala do lead que disparou. ≤ 52 caracteres. */
  eco?: string;
  ancora?: { rotulo: "PROVA" | "CONDIÇÃO" | "DADO"; texto: string };
  alternativa?: string;
  fonte: FonteCard;
  /**
   * Chip já conhecido (L0 bateu) mas a frase ainda está sendo refinada.
   * O painel mostra o esqueleto por ≤ 1200 ms; a versão completa chega com o mesmo `id`.
   */
  pendente?: boolean;
  latenciaMs?: number;
  /** Date.now() do gateway — o painel descarta card tardio (> 2,5 s). */
  geradoEm?: number;
}

export type MensagemGateway =
  | { tipo: "pronto"; sessaoId: string; ia: boolean; modelo?: string; heartbeatMs?: number }
  | { tipo: "sessao.retomada"; sessaoId: string; aPartirDoSeq: number }
  | { tipo: "pong"; ts: number; ultimoSeq?: number }
  | { tipo: "transcricao"; texto: string; falante: Falante; final: boolean }
  | ({ tipo: "sugestao" } & SugestaoCard)
  | { tipo: "sugestao.retirar"; sugestaoId: string; motivo: string }
  | { tipo: "degradado"; motivo: string; niveisDesligados?: string[]; ateTs?: number }
  | { tipo: "recuperado" }
  | { tipo: "reconectando"; tentativa: number }
  | { tipo: "erro"; codigo?: string; texto: string; fatal?: boolean };

/** Briefing enxuto que os prompts usam (derivado do briefing completo da API). */
export interface Briefing {
  leadNome: string | null;
  empresa: string | null;
  cidade: string | null;
  valorEstimado: number | null;
  handover: string | null;
  notas: string[];
  reuniaoEm: string | null;
}

export type Temperatura = "frio" | "morno" | "quente";
/** Fonte interna do motor (antes do mapeamento para o card). */
export type FonteSugestao = "gatilho" | "banco" | "ia";
