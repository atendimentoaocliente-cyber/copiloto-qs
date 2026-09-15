/**
 * Badge no ícone da extensão — o estado do copiloto visível sem abrir nada.
 *
 *   (vazio)  inativo
 *   "!"      azul     numa call, copiloto ainda não ativado
 *   "?"      âmbar    extensão não pareada
 *   "…"      cinza    fluxo pré-call em andamento
 *   "●"      verde    escutando
 *   "◐"      âmbar    reconectando / degradado
 *   "▲"      cinza    erro
 *   "TELA"   vermelho tela inteira compartilhada — painel visível ao lead
 */

export type EstadoBadge =
  | "inativo"
  | "em_call"
  | "sem_pareamento"
  | "pre_call"
  | "escutando"
  | "instavel"
  | "erro"
  | "tela_exposta";

const MAPA: Record<EstadoBadge, { texto: string; cor: string }> = {
  inativo: { texto: "", cor: "#667085" },
  em_call: { texto: "!", cor: "#1A55FF" },
  sem_pareamento: { texto: "?", cor: "#C2410C" },
  pre_call: { texto: "…", cor: "#3D4766" },
  escutando: { texto: "●", cor: "#12B76A" },
  instavel: { texto: "◐", cor: "#C2410C" },
  erro: { texto: "▲", cor: "#3D4766" },
  tela_exposta: { texto: "TELA", cor: "#B42318" },
};

export function definirBadge(tabId: number, estado: EstadoBadge): void {
  const { texto, cor } = MAPA[estado];
  chrome.action.setBadgeText({ text: texto, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: cor, tabId }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: "#FFFFFF", tabId }).catch(() => {});
}
