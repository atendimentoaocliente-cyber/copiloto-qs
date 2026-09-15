/**
 * Service worker — orquestra o ciclo de vida do copiloto.
 *
 * O clique no ÍCONE da extensão (ou o atalho `_execute_action`) é o único
 * gatilho que faz o Chrome conceder `activeTab`. Sem isso chrome.tabCapture
 * recusa com "Extension has not been invoked for the current page". Botão
 * desenhado na página NÃO concede — por isso o lembrete só aponta o atalho.
 *
 * Em MV3 o worker não tem AudioContext e morre por inatividade, então a
 * captura real acontece no Offscreen Document. Aqui só se decide, roteia
 * e persiste (chrome.storage.session).
 *
 * Fluxo de produção (evolução do protótipo, que ia direto para a captura):
 *
 *   clique → pareado? → painel na aba → escolher lead → consentimento LGPD
 *          → briefing → INICIAR ESCUTA (getMediaStreamId + offscreen) → ao vivo
 */

import contentScript from "@/conteudo/content.ts?script";
import { vigiaDeTela } from "@/conteudo/vigia-tela";
import { definirBadge, type EstadoBadge } from "./badge";
import { atualizarSessao, lerSessao, zerarSessao } from "./sessao";
import { armazenamento } from "@/compartilhado/armazenamento";
import { REGEX_SALA_MEET, TEXTO_CONSENTIMENTO, VERSAO_TEXTO_CONSENTIMENTO } from "@/compartilhado/config";
import { ErroGateway, gateway } from "@/compartilhado/gateway";
import { diasRestantes, expirado } from "@/compartilhado/jwt";
import {
  ehPara,
  type EventoAudio,
  type ParaContent,
  type ParaOffscreen,
  type SemDestino,
  type TelaPreCall,
} from "@/compartilhado/mensagens";
import type { Credencial, Reuniao, Sessao, ValorFeedback } from "@/compartilhado/tipos";

const CAMINHO_OFFSCREEN = "src/offscreen/offscreen.html";

// ── Utilitários de envio ────────────────────────────────────────────────────

async function paraContent(tabId: number, msg: SemDestino<ParaContent>): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { destino: "content", ...msg });
  } catch {
    /* aba fechou ou content script ainda não subiu */
  }
}

function paraOffscreen(msg: SemDestino<ParaOffscreen>): void {
  chrome.runtime.sendMessage({ destino: "offscreen", ...msg }).catch(() => {});
}

async function mostrarTela(tabId: number, dados: TelaPreCall): Promise<void> {
  await paraContent(tabId, { tipo: "MOSTRAR_TELA", dados });
}

// ── Credencial ──────────────────────────────────────────────────────────────

/** Devolve a credencial válida, renovando o JWT quando falta menos de 5 dias. */
async function credencialValida(): Promise<Credencial | null> {
  const cred = await armazenamento.lerCredencial();
  if (!cred || expirado(cred.token)) return null;

  if (diasRestantes(cred.token) < 5) {
    try {
      const url = await armazenamento.lerGateway();
      const nova = await gateway.renovar(url, cred.token);
      const renovada = { ...cred, token: nova.token, expiraEm: nova.expiraEm };
      await armazenamento.gravarCredencial(renovada);
      return renovada;
    } catch (err) {
      // Renovação falhou mas o token atual ainda vale: segue com ele.
      console.warn("[Copiloto] renovação do token falhou:", (err as Error).message);
    }
  }
  return cred;
}

// ── Offscreen ───────────────────────────────────────────────────────────────

async function garantirOffscreen(): Promise<void> {
  const existentes = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existentes.length > 0) return;

  await chrome.offscreen.createDocument({
    url: CAMINHO_OFFSCREEN,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification:
      "Captura o áudio da reunião para transcrição em tempo real com consentimento do lead.",
  });
}

async function fecharOffscreen(): Promise<void> {
  try {
    const existentes = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existentes.length > 0) await chrome.offscreen.closeDocument();
  } catch {
    /* já fechado */
  }
}

// ── Injeção do painel na aba ────────────────────────────────────────────────

function paginaCapturavel(url: string | undefined): boolean {
  return Boolean(url) && !/^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url!);
}

function plataformaDaUrl(url: string | undefined): Reuniao["plataforma"] {
  if (!url) return "outro";
  if (/meet\.google\.com/i.test(url)) return "google_meet";
  if (/zoom\.us/i.test(url)) return "zoom";
  if (/teams\.(microsoft|live)\.com/i.test(url)) return "teams";
  return "outro";
}

async function injetarPainel(tabId: number): Promise<void> {
  // O content script tem guarda `window.__COPILOTO_QS__`, então reinjetar é seguro.
  await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] });
  // O vigia precisa rodar no contexto da PÁGINA para substituir getDisplayMedia.
  await chrome.scripting.executeScript({ target: { tabId }, func: vigiaDeTela, world: "MAIN" });

  // O loader do bundler importa o módulo real de forma assíncrona: executeScript
  // resolve antes de o listener existir. Espera o content script responder.
  const prazo = Date.now() + 4_000;
  while (Date.now() < prazo) {
    try {
      const ok = await chrome.tabs.sendMessage(tabId, { destino: "content", tipo: "PING" } satisfies ParaContent);
      if (ok === true) return;
    } catch {
      /* ainda não subiu */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("o painel não respondeu ao PING em 4 s");
}

// ── Fluxo pré-call ──────────────────────────────────────────────────────────

async function iniciarFluxo(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;

  if (!paginaCapturavel(tab.url)) {
    console.warn("[Copiloto] esta página não pode ser capturada:", tab.url);
    return;
  }

  // Uma sessão de cada vez. Se havia outra em outra aba, encerra antes.
  const anterior = await lerSessao();
  if (anterior.fase !== "inativo" && anterior.tabId !== null && anterior.tabId !== tabId) {
    await parar("closer");
  }

  try {
    await injetarPainel(tabId);
  } catch (err) {
    console.error("[Copiloto] não consegui injetar o painel:", err);
    return;
  }

  const cred = await credencialValida();
  if (!cred) {
    definirBadge(tabId, "sem_pareamento");
    await atualizarSessao({ fase: "carregando", tabId, plataforma: plataformaDaUrl(tab.url) });
    await paraContent(tabId, { tipo: "MOSTRAR_PAINEL", sessao: await lerSessao() });
    await mostrarTela(tabId, { tela: "sem_pareamento" });
    chrome.runtime.openOptionsPage();
    return;
  }

  definirBadge(tabId, "pre_call");
  await zerarSessao();
  await atualizarSessao({ fase: "carregando", tabId, plataforma: plataformaDaUrl(tab.url) });
  await paraContent(tabId, { tipo: "MOSTRAR_PAINEL", sessao: await lerSessao() });
  await mostrarTela(tabId, { tela: "carregando", texto: "Buscando suas reuniões de hoje" });
  await carregarReunioes(tabId, cred);
}

async function carregarReunioes(tabId: number, cred: Credencial): Promise<void> {
  const url = await armazenamento.lerGateway();
  try {
    const reunioes = await gateway.reunioesDeHoje(url, cred.token);
    await atualizarSessao({ fase: "selecionando_lead" });
    await mostrarTela(tabId, { tela: "reunioes", reunioes });
  } catch (err) {
    const e = err as ErroGateway;
    if (e.status === 401 || e.status === 403) {
      await armazenamento.apagarCredencial();
      definirBadge(tabId, "sem_pareamento");
      await mostrarTela(tabId, { tela: "sem_pareamento" });
      chrome.runtime.openOptionsPage();
      return;
    }
    await atualizarSessao({ fase: "selecionando_lead" });
    await mostrarTela(tabId, { tela: "reunioes", reunioes: [], erro: e.message });
  }
}

async function leadEscolhido(reuniaoId: string): Promise<void> {
  const sessao = await lerSessao();
  if (sessao.tabId === null) return;
  // A lista de reuniões não é persistida na sessão: pedimos de novo ao gateway
  // só a que foi escolhida, garantindo que ela é do closer autenticado.
  const cred = await credencialValida();
  if (!cred) return;
  const url = await armazenamento.lerGateway();
  let reuniao: Reuniao | undefined;
  try {
    reuniao = (await gateway.reunioesDeHoje(url, cred.token)).find((r) => r.id === reuniaoId);
  } catch {
    /* tratado abaixo */
  }
  if (!reuniao) {
    await mostrarTela(sessao.tabId, {
      tela: "reunioes",
      reunioes: [],
      erro: "Essa reunião não está mais na sua agenda. Escolha outra.",
    });
    return;
  }
  // Sessão sem lead é rejeitada — o vínculo é obrigatório e vem daqui.
  await atualizarSessao({ fase: "consentimento", reuniao });
  await mostrarTela(sessao.tabId, { tela: "consentimento", reuniao, texto: TEXTO_CONSENTIMENTO });
}

async function consentimentoRecusado(): Promise<void> {
  const sessao = await lerSessao();
  const tabId = sessao.tabId;
  // Descarta TUDO: nada foi persistido, nada será. O copiloto segue desligado.
  await zerarSessao();
  if (tabId !== null) {
    definirBadge(tabId, "inativo");
    await mostrarTela(tabId, { tela: "recusado" });
  }
}

async function consentimentoConfirmado(confirmadoEm: string): Promise<void> {
  const sessao = await lerSessao();
  if (sessao.tabId === null || !sessao.reuniao) return;
  const tabId = sessao.tabId;
  const cred = await credencialValida();
  if (!cred) return;
  const url = await armazenamento.lerGateway();

  const consentimento = {
    reuniaoId: sessao.reuniao.id,
    leadId: sessao.reuniao.leadId,
    confirmadoEm,
    textoVersao: VERSAO_TEXTO_CONSENTIMENTO,
    closerId: cred.usuario.id,
  };

  // A prova do consentimento é a PRIMEIRA coisa persistida. Sem ela, não há sessão.
  await mostrarTela(tabId, { tela: "carregando", texto: "Registrando o consentimento" });
  let consentimentoId: string;
  try {
    consentimentoId = (await gateway.registrarConsentimento(url, cred.token, consentimento)).id;
  } catch (err) {
    await mostrarTela(tabId, {
      tela: "consentimento",
      reuniao: sessao.reuniao,
      texto: TEXTO_CONSENTIMENTO,
    });
    await paraContent(tabId, {
      tipo: "AUDIO_EVENTO",
      evento: { tipo: "aviso", texto: `Não consegui registrar o consentimento: ${(err as Error).message}` },
    });
    return;
  }

  await atualizarSessao({
    fase: "briefing",
    consentimento: { ...consentimento, id: consentimentoId },
    sessaoId: crypto.randomUUID(),
  });

  // Briefing pré-call: handover do SDR, histórico e produto de interesse.
  try {
    const briefing = await gateway.briefing(url, cred.token, sessao.reuniao.leadId, sessao.reuniao.id);
    await atualizarSessao({ briefing });
    await mostrarTela(tabId, { tela: "briefing", reuniao: sessao.reuniao, briefing });
  } catch (err) {
    await mostrarTela(tabId, {
      tela: "briefing",
      reuniao: sessao.reuniao,
      briefing: null,
      erroBriefing: (err as Error).message,
    });
  }
}

// ── Início da escuta (captura) ──────────────────────────────────────────────

async function iniciarEscuta(): Promise<void> {
  const sessao = await lerSessao();
  const { tabId, reuniao, consentimento, sessaoId } = sessao;
  if (tabId === null || !reuniao || !consentimento?.id || !sessaoId) {
    console.error("[Copiloto] tentativa de iniciar escuta sem lead/consentimento");
    return;
  }
  const cred = await credencialValida();
  if (!cred) return;

  let streamId: string;
  try {
    // activeTab foi concedido no clique do ícone e vale até a aba navegar.
    // O streamId, por sua vez, expira em segundos — por isso ele é consumido
    // imediatamente pelo offscreen, logo abaixo.
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    const texto = (err as Error).message ?? "";
    if (/not been invoked|activeTab/i.test(texto)) {
      await atualizarSessao({ aguardandoReinvocacao: true });
      await mostrarTela(tabId, {
        tela: "erro",
        acao: "reinvocar",
        texto: "A aba mudou e o Chrome pede sua confirmação de novo. Clique no ícone da extensão ou aperte o atalho para liberar o áudio.",
      });
      return;
    }
    await mostrarTela(tabId, { tela: "erro", texto: `Não consegui capturar o áudio desta aba: ${texto}` });
    return;
  }

  await garantirOffscreen();
  paraOffscreen({
    tipo: "INICIAR",
    parametros: {
      streamId,
      gateway: await armazenamento.lerGateway(),
      token: cred.token,
      sessaoId,
      reuniaoId: reuniao.id,
      leadId: reuniao.leadId,
      consentimentoId: consentimento.id,
      plataforma: sessao.plataforma ?? "outro",
    },
  });

  const atualizada = await atualizarSessao({
    fase: "ao_vivo",
    iniciadaEm: new Date().toISOString(),
    aguardandoReinvocacao: false,
  });
  definirBadge(tabId, "escutando");
  await paraContent(tabId, { tipo: "ESCUTA_INICIADA", sessao: atualizada });
}

// ── Encerramento ────────────────────────────────────────────────────────────

async function parar(_motivo: "closer" | "aba_fechada" | "erro"): Promise<void> {
  const sessao = await lerSessao();
  const tabId = sessao.tabId;
  if (sessao.fase === "inativo") return;

  await atualizarSessao({ fase: "encerrando" });
  paraOffscreen({ tipo: "PARAR" });
  // Dá tempo do offscreen mandar `encerrar` ao gateway e fechar o socket
  // (o gateway precisa do CloseStream para não perder as últimas falas).
  setTimeout(() => void fecharOffscreen(), 1_500);

  if (tabId !== null) {
    definirBadge(tabId, "inativo");
    await paraContent(tabId, { tipo: "PARAR_PAINEL" });
  }
  await zerarSessao();
}

// ── Feedback do closer ──────────────────────────────────────────────────────

async function registrarFeedback(sugestaoId: string, valor: ValorFeedback, categoria: string): Promise<void> {
  const sessao = await lerSessao();
  if (!sessao.sessaoId) return;
  const em = new Date().toISOString();

  await atualizarSessao({
    tratadas: [...sessao.tratadas, { em, categoria, valor }].slice(-50),
  });

  // Manda pelos dois caminhos: WS (rápido, alimenta o ranking na hora) e
  // REST (fica na fila se o gateway estiver fora).
  paraOffscreen({ tipo: "FEEDBACK", sugestaoId, valor });
  await enviarFeedbackRest({ sugestaoId, sessaoId: sessao.sessaoId, valor, em });
}

async function enviarFeedbackRest(f: { sugestaoId: string; sessaoId: string; valor: ValorFeedback; em: string }): Promise<void> {
  const cred = await credencialValida();
  if (!cred) return;
  const url = await armazenamento.lerGateway();
  const pendentes = await armazenamento.lerFeedbacksPendentes();
  const lote = [...pendentes, f];
  const restantes: typeof lote = [];
  for (const item of lote) {
    try {
      await gateway.feedback(url, cred.token, item.sugestaoId, item.sessaoId, item.valor as ValorFeedback, item.em);
    } catch {
      restantes.push(item);
    }
  }
  await armazenamento.gravarFeedbacksPendentes(restantes);
}

// ── Eventos do canal de áudio → badge + repasse ao painel ───────────────────

async function tratarEventoAudio(evento: EventoAudio): Promise<void> {
  const sessao = await lerSessao();
  if (sessao.tabId === null) return;
  const tabId = sessao.tabId;

  const badge: Partial<Record<EventoAudio["tipo"], EstadoBadge>> = {
    pronto: "escutando",
    recuperado: "escutando",
    reconectando: "instavel",
    degradado: "instavel",
    erro: "erro",
  };
  const novo = badge[evento.tipo];
  if (novo && sessao.superficie !== "monitor") definirBadge(tabId, novo);

  await paraContent(tabId, { tipo: "AUDIO_EVENTO", evento });

  if (evento.tipo === "erro" && evento.fatal) {
    // Erro fatal na captura: encerra de forma honesta, nunca "mudo fingindo ativo".
    await parar("erro");
  }
}

// ── Listeners ───────────────────────────────────────────────────────────────

// ÚNICO ponto de entrada que concede activeTab.
chrome.action.onClicked.addListener(async (tab) => {
  const sessao = await lerSessao();
  const mesmaAba = tab.id !== undefined && sessao.tabId === tab.id;

  if (mesmaAba && sessao.aguardandoReinvocacao) {
    // Clique de reinvocação: activeTab renovado, retoma do ponto onde parou
    // (vale tanto no briefing quanto numa captura que caiu no meio da call).
    await iniciarEscuta();
    return;
  }
  if (mesmaAba && sessao.fase === "ao_vivo") {
    await parar("closer");
    return;
  }
  if (mesmaAba && sessao.fase !== "inativo") {
    // Clique durante o pré-call: cancela.
    await parar("closer");
    return;
  }
  await iniciarFluxo(tab);
});

chrome.commands.onCommand.addListener(async (comando) => {
  const sessao = await lerSessao();
  if (sessao.tabId === null || sessao.fase !== "ao_vivo") return;
  if (comando === "marcar-usei" || comando === "marcar-nao-serviu" || comando === "silenciar") {
    await paraContent(sessao.tabId, { tipo: "ATALHO", comando });
  }
});

chrome.runtime.onMessage.addListener((msg: unknown, remetente, responder) => {
  if (!ehPara(msg, "background")) return;

  void (async () => {
    switch (msg.tipo) {
      case "PAINEL_PRONTO": {
        // O content script (re)carregou e pede o estado atual.
        const sessao = await lerSessao();
        if (remetente.tab?.id !== undefined && sessao.tabId === remetente.tab.id) {
          await paraContent(sessao.tabId, { tipo: "MOSTRAR_PAINEL", sessao });
        }
        break;
      }
      case "PARAR":
        await parar("closer");
        break;
      case "ABRIR_OPCOES":
        chrome.runtime.openOptionsPage();
        break;
      case "LEAD_ESCOLHIDO":
        await leadEscolhido(msg.reuniaoId);
        break;
      case "RECARREGAR_REUNIOES": {
        const sessao = await lerSessao();
        const cred = await credencialValida();
        if (sessao.tabId !== null && cred) {
          await atualizarSessao({ fase: "carregando" });
          await mostrarTela(sessao.tabId, { tela: "carregando", texto: "Buscando suas reuniões de hoje" });
          await carregarReunioes(sessao.tabId, cred);
        }
        break;
      }
      case "CONSENTIMENTO_CONFIRMADO":
        await consentimentoConfirmado(msg.confirmadoEm);
        break;
      case "CONSENTIMENTO_RECUSADO":
        await consentimentoRecusado();
        break;
      case "INICIAR_ESCUTA":
        await iniciarEscuta();
        break;
      case "PAUSAR":
        paraOffscreen({ tipo: "PAUSAR" });
        break;
      case "RETOMAR":
        paraOffscreen({ tipo: "RETOMAR" });
        break;
      case "RECONECTAR":
        paraOffscreen({ tipo: "RECONECTAR" });
        break;
      case "FEEDBACK":
        await registrarFeedback(msg.sugestaoId, msg.valor, msg.categoria);
        break;
      case "TELA": {
        const sessao = await lerSessao();
        if (sessao.tabId === null) break;
        await atualizarSessao({ superficie: msg.aviso.superficie });
        if (msg.aviso.perigoso) definirBadge(sessao.tabId, "tela_exposta");
        else definirBadge(sessao.tabId, sessao.fase === "ao_vivo" ? "escutando" : "pre_call");
        break;
      }
      case "AUDIO_EVENTO":
        await tratarEventoAudio(msg.evento);
        break;
    }
  })().finally(() => responder(true));

  return true; // resposta assíncrona
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessao = await lerSessao();
  if (tabId === sessao.tabId) await parar("aba_fechada");
});

// Marca o ícone quando o closer está numa sala do Meet — o copiloto nunca
// fica esquecido, mesmo se o lembrete já tiver sumido.
async function marcarSeEmCall(tabId: number, url: string | undefined): Promise<void> {
  const sessao = await lerSessao();
  if (tabId === sessao.tabId && sessao.fase !== "inativo") return;
  definirBadge(tabId, REGEX_SALA_MEET.test(url ?? "") ? "em_call" : "inativo");
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" || info.url) void marcarSeEmCall(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await marcarSeEmCall(tabId, tab.url);
  } catch {
    /* aba já fechou */
  }
});

chrome.runtime.onInstalled.addListener(async (detalhes) => {
  if (detalhes.reason === "install") chrome.runtime.openOptionsPage();
  // Sessão de uma vida anterior do Chrome não vale mais.
  await zerarSessao();
  await fecharOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await zerarSessao();
  await fecharOffscreen();
});

// Se a sessão ficou "ao_vivo" mas o offscreen não existe mais (Chrome
// derrubou o documento), avisa o painel em vez de fingir que está ativo.
void (async () => {
  const sessao = await lerSessao();
  if (sessao.fase !== "ao_vivo" || sessao.tabId === null) return;
  const contextos = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contextos.length === 0) {
    await paraContent(sessao.tabId, {
      tipo: "AUDIO_EVENTO",
      evento: { tipo: "erro", texto: "A captura de áudio caiu. Clique no ícone para religar.", fatal: false },
    });
    definirBadge(sessao.tabId, "erro");
    await atualizarSessao({ aguardandoReinvocacao: true });
  }
})();

export {};
