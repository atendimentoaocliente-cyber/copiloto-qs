/**
 * Service worker — orquestra o ciclo de vida da captura.
 *
 * O clique no ÍCONE DA EXTENSÃO é o único gatilho válido: é ele que faz o
 * Chrome conceder `activeTab`, sem o qual chrome.tabCapture recusa com
 * "Extension has not been invoked for the current page".
 *
 * Em MV3 o service worker não tem AudioContext e morre por inatividade,
 * então a captura de áudio real acontece no Offscreen Document.
 */

const CAMINHO_OFFSCREEN = "offscreen.html";
const SERVIDOR = "http://localhost:8787";

let abaAtiva = null;

async function garantirOffscreen() {
  const existentes = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existentes.length > 0) return;

  await chrome.offscreen.createDocument({
    url: CAMINHO_OFFSCREEN,
    reasons: ["USER_MEDIA"],
    justification:
      "Captura o áudio da reunião para gerar transcrição em tempo real.",
  });
}

async function iniciar(tab) {
  // Páginas internas do Chrome não podem ser capturadas.
  if (!tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    console.warn("[Copiloto] esta página não pode ser capturada:", tab.url);
    return;
  }

  try {
    // Precisa vir ANTES de qualquer await longo: o activeTab concedido pelo
    // clique tem validade curta.
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    abaAtiva = tab.id;

    // Garante que o content script existe (a aba pode ter carregado antes
    // de a extensão ser instalada).
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      // O vigia precisa rodar no contexto da PÁGINA para substituir
      // getDisplayMedia — por isso world: "MAIN".
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["vigia-tela.js"],
        world: "MAIN",
      });
    } catch {
      /* já injetado */
    }

    await chrome.tabs.sendMessage(tab.id, {
      destino: "content",
      tipo: "MOSTRAR_PAINEL",
    });

    await garantirOffscreen();

    chrome.runtime.sendMessage({
      destino: "offscreen",
      tipo: "INICIAR",
      streamId,
      servidor: SERVIDOR,
    });

    chrome.action.setBadgeText({ text: "●", tabId: tab.id });
    chrome.action.setBadgeBackgroundColor({ color: "#12B76A", tabId: tab.id });
  } catch (err) {
    console.error("[Copiloto] falha ao iniciar:", err);
    if (abaAtiva !== null) {
      chrome.tabs
        .sendMessage(abaAtiva, {
          destino: "content",
          tipo: "ERRO",
          texto: err.message,
        })
        .catch(() => {});
    }
  }
}

async function parar() {
  chrome.runtime.sendMessage({ destino: "offscreen", tipo: "PARAR" });
  if (abaAtiva !== null) {
    chrome.action.setBadgeText({ text: "", tabId: abaAtiva });
    chrome.tabs
      .sendMessage(abaAtiva, { destino: "content", tipo: "PARAR_PAINEL" })
      .catch(() => {});
  }
  abaAtiva = null;
}

// ÚNICO ponto de entrada — é o clique aqui que concede activeTab
chrome.action.onClicked.addListener((tab) => {
  if (abaAtiva === tab.id) parar();
  else iniciar(tab);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.destino === "background" && msg.tipo === "PARAR") {
    parar();
    return;
  }
  // Vindo do offscreen, repassa para a aba capturada
  if (msg.destino === "content" && abaAtiva !== null) {
    chrome.tabs.sendMessage(abaAtiva, msg).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === abaAtiva) parar();
});


// Marca o ícone quando você está numa call do Meet — assim o copiloto
// nunca fica esquecido, mesmo se o lembrete já tiver sumido.
function marcarSeMeet(tabId, url) {
  if (tabId === abaAtiva) return; // já capturando: badge verde continua
  const numaCall = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url ?? "");
  chrome.action.setBadgeText({ text: numaCall ? "!" : "", tabId });
  if (numaCall) {
    chrome.action.setBadgeBackgroundColor({ color: "#1A55FF", tabId });
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" || info.url) marcarSeMeet(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    marcarSeMeet(tabId, tab.url);
  } catch {}
});
