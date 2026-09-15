/**
 * Contrato do provedor de transcrição em streaming.
 *
 * Trocar de provedor (plano B: Azure Speech / Google STT / AssemblyAI) é
 * implementar esta interface e registrar na fábrica — nada muda na sessão
 * nem no motor.
 *
 * Garantias que TODA implementação precisa dar:
 *   1. `enviar()` nunca lança: se a conexão caiu, enfileira e reconecta.
 *   2. `finalizar()` só resolve depois que o provedor devolveu as últimas
 *      falas finais (ou estourou o prazo). Sem isso, o fim de toda call perde
 *      as últimas frases — medido em produção.
 *   3. Nenhuma falha é engolida: vira evento `erro` ou `estado`.
 */
import { EventEmitter } from "node:events";

export interface EventoTranscricao {
  texto: string;
  /** 0 = lead (aba), 1 = closer (microfone). */
  canal: 0 | 1;
  final: boolean;
  confianca: number | null;
  inicioMs: number | null;
  fimMs: number | null;
}

export type EstadoStt =
  | { estado: "conectado"; tentativa: number }
  | { estado: "reconectando"; tentativa: number; esperaMs: number }
  | { estado: "caiu"; motivo: string };

export interface EventosStt {
  transcricao: [EventoTranscricao];
  estado: [EstadoStt];
  erro: [Error];
  /** Latência da 1ª palavra: ms entre o primeiro byte enviado e o primeiro transcript. */
  primeira_palavra: [number];
}

export interface OpcoesStt {
  taxaAmostragem: number;
  canais: number;
  /** Vocabulário do domínio (destinos, siglas) para o modelo priorizar. */
  termos?: string[];
}

export abstract class ProvedorStt extends EventEmitter<EventosStt> {
  abstract readonly nome: string;
  abstract readonly modelo: string;
  /** Abre a conexão. Resolve quando pronta para receber áudio. */
  abstract conectar(): Promise<void>;
  /** Envia PCM. Nunca lança — enfileira se estiver caído. */
  abstract enviar(pcm: Buffer): void;
  /** Sinaliza fim do áudio e AGUARDA os finais pendentes. */
  abstract finalizar(): Promise<void>;
  /** Derruba tudo sem esperar (usado em erro fatal). */
  abstract destruir(): void;
  /** Bytes que ficaram na fila e foram descartados por excesso — para métrica. */
  abstract get bytesDescartados(): number;
}

export type FabricaStt = (opcoes: OpcoesStt) => ProvedorStt;
