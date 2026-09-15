/**
 * Máquina de estados da sessão — vive no service worker, persiste em
 * chrome.storage.session para sobreviver à morte do worker por inatividade.
 *
 *   inativo → carregando → selecionando_lead → consentimento → briefing → ao_vivo → encerrando → inativo
 *                                                    └─ recusado ────────────────────────────────┘
 */

import { armazenamento, sessaoVazia } from "@/compartilhado/armazenamento";
import type { FaseSessao, Sessao } from "@/compartilhado/tipos";

/** Transições permitidas. Qualquer outra é bug e é logada. */
const TRANSICOES: Record<FaseSessao, FaseSessao[]> = {
  inativo: ["carregando"],
  carregando: ["selecionando_lead", "inativo", "encerrando"],
  selecionando_lead: ["consentimento", "carregando", "inativo", "encerrando"],
  consentimento: ["briefing", "selecionando_lead", "inativo", "encerrando"],
  briefing: ["ao_vivo", "inativo", "encerrando"],
  ao_vivo: ["encerrando", "inativo"],
  encerrando: ["inativo"],
};

let cache: Sessao | null = null;

export async function lerSessao(): Promise<Sessao> {
  if (cache) return cache;
  cache = await armazenamento.lerSessao();
  return cache;
}

export async function atualizarSessao(mudancas: Partial<Sessao>): Promise<Sessao> {
  const atual = await lerSessao();
  if (mudancas.fase && mudancas.fase !== atual.fase) {
    const permitidas = TRANSICOES[atual.fase];
    if (!permitidas.includes(mudancas.fase)) {
      console.warn(`[Copiloto] transição inesperada ${atual.fase} → ${mudancas.fase}`);
    }
  }
  cache = { ...atual, ...mudancas };
  await armazenamento.gravarSessao(cache);
  return cache;
}

export async function zerarSessao(): Promise<Sessao> {
  cache = sessaoVazia();
  await armazenamento.limparSessao();
  return cache;
}

/** Fases em que já existe painel na aba. */
export function temPainel(fase: FaseSessao): boolean {
  return fase !== "inativo";
}
