/**
 * Wrapper tipado sobre chrome.storage.
 *
 *   local   → credencial (JWT), preferências, URL do gateway — sobrevive a reinício.
 *   session → estado da sessão em andamento — sobrevive à morte do service
 *             worker, mas some ao fechar o Chrome (é o que queremos).
 */

import { GATEWAY_PADRAO } from "./config";
import type { Credencial, Sessao } from "./tipos";

export interface Preferencias {
  /** Fonte grande: frase a 26px, teto cai para 52 caracteres. */
  fonteGrande: boolean;
  /** Modo mínimo: esconde âncora, alternativa e fila (closers experientes). */
  modoMinimo: boolean;
  /** Transições instantâneas (equivale a prefers-reduced-motion). */
  semTransicoes: boolean;
  /** Última posição do painel na página. */
  posicaoPainel: { x: number; y: number } | null;
}

const PREFERENCIAS_PADRAO: Preferencias = {
  fonteGrande: false,
  modoMinimo: false,
  semTransicoes: false,
  posicaoPainel: null,
};

interface Local {
  credencial?: Credencial;
  gateway?: string;
  preferencias?: Preferencias;
  /** Fila de feedbacks que não conseguiram sair (gateway fora). */
  feedbacksPendentes?: Array<{ sugestaoId: string; sessaoId: string; valor: string; em: string }>;
}

async function lerLocal<K extends keyof Local>(chave: K): Promise<Local[K]> {
  const r = await chrome.storage.local.get(chave);
  return r[chave] as Local[K];
}

export const armazenamento = {
  // ── credencial ────────────────────────────────────────────────────────────
  async lerCredencial(): Promise<Credencial | null> {
    return (await lerLocal("credencial")) ?? null;
  },
  async gravarCredencial(c: Credencial): Promise<void> {
    await chrome.storage.local.set({ credencial: c });
  },
  async apagarCredencial(): Promise<void> {
    await chrome.storage.local.remove("credencial");
  },

  // ── gateway ───────────────────────────────────────────────────────────────
  async lerGateway(): Promise<string> {
    const url = await lerLocal("gateway");
    return (url && url.trim()) || GATEWAY_PADRAO;
  },
  async gravarGateway(url: string): Promise<void> {
    await chrome.storage.local.set({ gateway: url.trim().replace(/\/+$/, "") });
  },

  // ── preferências ──────────────────────────────────────────────────────────
  async lerPreferencias(): Promise<Preferencias> {
    return { ...PREFERENCIAS_PADRAO, ...((await lerLocal("preferencias")) ?? {}) };
  },
  async gravarPreferencias(p: Partial<Preferencias>): Promise<void> {
    const atual = await this.lerPreferencias();
    await chrome.storage.local.set({ preferencias: { ...atual, ...p } });
  },

  // ── feedbacks pendentes ───────────────────────────────────────────────────
  async lerFeedbacksPendentes(): Promise<NonNullable<Local["feedbacksPendentes"]>> {
    return (await lerLocal("feedbacksPendentes")) ?? [];
  },
  async gravarFeedbacksPendentes(lista: NonNullable<Local["feedbacksPendentes"]>): Promise<void> {
    await chrome.storage.local.set({ feedbacksPendentes: lista.slice(-200) });
  },

  // ── sessão (storage.session) ──────────────────────────────────────────────
  async lerSessao(): Promise<Sessao> {
    const r = await chrome.storage.session.get("sessao");
    return (r["sessao"] as Sessao | undefined) ?? sessaoVazia();
  },
  async gravarSessao(s: Sessao): Promise<void> {
    await chrome.storage.session.set({ sessao: s });
  },
  async limparSessao(): Promise<void> {
    await chrome.storage.session.remove("sessao");
  },
};

export function sessaoVazia(): Sessao {
  return {
    fase: "inativo",
    tabId: null,
    sessaoId: null,
    reuniao: null,
    briefing: null,
    consentimento: null,
    iniciadaEm: null,
    plataforma: "outro",
    tratadas: [],
    superficie: null,
    aguardandoReinvocacao: false,
  };
}
