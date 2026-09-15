/**
 * Content script — o painel do copiloto dentro da página da reunião.
 *
 * Injetado sob demanda pelo service worker (chrome.scripting) no clique do
 * ícone. A guarda `window.__COPILOTO_QS__` evita registrar tudo duas vezes
 * se a página já tinha o script.
 *
 * Aqui não existe lógica de negócio: o content script desenha o que o
 * service worker manda (telas pré-call) e o que o canal de áudio reporta
 * (eventos ao vivo), e devolve as decisões do closer.
 */

import { ehPara, enviarParaBackground, type TelaPreCall } from "@/compartilhado/mensagens";
import type { Preferencias } from "@/compartilhado/armazenamento";
import type { Sessao } from "@/compartilhado/tipos";
import { AoVivo } from "./painel/ao-vivo";
import { Painel } from "./painel/painel";
import { renderizarTela, type AcoesTela } from "./painel/telas";

if (window.__COPILOTO_QS__) {
  console.debug("[Copiloto] já carregado nesta aba");
} else {
  window.__COPILOTO_QS__ = true;

  let painel: Painel | null = null;
  let aoVivo: AoVivo | null = null;
  let sessao: Sessao | null = null;
  let ultimaTela: TelaPreCall | null = null;
  let mostrandoBriefingSobreAoVivo = false;

  const PREFERENCIAS_PADRAO: Preferencias = {
    fonteGrande: false,
    modoMinimo: false,
    semTransicoes: false,
    posicaoPainel: null,
  };

  async function lerPreferencias(): Promise<Preferencias> {
    try {
      const r = await chrome.storage.local.get("preferencias");
      return { ...PREFERENCIAS_PADRAO, ...((r["preferencias"] as Partial<Preferencias> | undefined) ?? {}) };
    } catch {
      return PREFERENCIAS_PADRAO;
    }
  }

  const acoesTela: AcoesTela = {
    escolherLead: (reuniaoId) => enviarParaBackground({ tipo: "LEAD_ESCOLHIDO", reuniaoId }),
    recarregarReunioes: () => enviarParaBackground({ tipo: "RECARREGAR_REUNIOES" }),
    confirmarConsentimento: () =>
      enviarParaBackground({ tipo: "CONSENTIMENTO_CONFIRMADO", confirmadoEm: new Date().toISOString() }),
    recusarConsentimento: () => enviarParaBackground({ tipo: "CONSENTIMENTO_RECUSADO" }),
    iniciarEscuta: () => enviarParaBackground({ tipo: "INICIAR_ESCUTA" }),
    abrirOpcoes: () => enviarParaBackground({ tipo: "ABRIR_OPCOES" }),
    fechar: () => parar(),
  };

  async function garantirPainel(): Promise<Painel> {
    if (painel) return painel;
    const preferencias = await lerPreferencias();
    painel = new Painel({
      preferencias,
      aoFechar: () => parar(),
      aoBriefing: () => alternarBriefing(),
    });
    painel.ouvirTeclado((e) => {
      // Só quando o painel (ou a janela flutuante) tem o foco — o Ctrl+↵ do
      // chat do Meet continua sendo do Meet.
      if (aoVivo && !mostrandoBriefingSobreAoVivo && painel?.eventoDoPainel(e)) aoVivo.tecla(e);
    });
    // Preferências mudadas na página de opções valem na hora.
    chrome.storage.onChanged.addListener((mudancas, area) => {
      if (area === "local" && mudancas["preferencias"] && painel) {
        painel.aplicarPreferencias({ ...PREFERENCIAS_PADRAO, ...(mudancas["preferencias"].newValue ?? {}) });
      }
    });
    return painel;
  }

  /** ⓘ no cabeçalho: durante a call, mostra o briefing por cima da grade e volta. */
  function alternarBriefing(): void {
    if (!painel || !sessao?.reuniao) return;
    if (!aoVivo) return; // no pré-call o briefing já é a tela
    if (mostrandoBriefingSobreAoVivo) {
      mostrandoBriefingSobreAoVivo = false;
      painel.mostrarGrade();
      return;
    }
    mostrandoBriefingSobreAoVivo = true;
    renderizarTela(
      painel,
      { tela: "briefing", reuniao: sessao.reuniao, briefing: sessao.briefing },
      {
        ...acoesTela,
        voltarParaAoVivo: () => {
          mostrandoBriefingSobreAoVivo = false;
          painel?.mostrarGrade();
        },
      },
    );
  }

  function entrarAoVivo(s: Sessao): void {
    if (!painel) return;
    sessao = s;
    aoVivo?.destruir();
    mostrandoBriefingSobreAoVivo = false;
    aoVivo = new AoVivo(painel, s, {
      feedback: (sugestaoId, valor, categoria) =>
        enviarParaBackground({ tipo: "FEEDBACK", sugestaoId, valor, categoria }),
      pausar: () => enviarParaBackground({ tipo: "PAUSAR" }),
      retomar: () => enviarParaBackground({ tipo: "RETOMAR" }),
      reconectar: () => enviarParaBackground({ tipo: "RECONECTAR" }),
    });
  }

  function parar(): void {
    enviarParaBackground({ tipo: "PARAR" });
    destruirLocal();
  }

  function destruirLocal(): void {
    aoVivo?.destruir();
    aoVivo = null;
    painel?.destruir();
    painel = null;
    sessao = null;
    ultimaTela = null;
    mostrandoBriefingSobreAoVivo = false;
  }

  chrome.runtime.onMessage.addListener((msg: unknown, _remetente, responder) => {
    if (!ehPara(msg, "content")) return;

    if (msg.tipo === "PING") {
      responder(true);
      return;
    }

    void (async () => {
      switch (msg.tipo) {
        case "MOSTRAR_PAINEL": {
          const p = await garantirPainel();
          sessao = msg.sessao;
          if (msg.sessao.fase === "ao_vivo") {
            // Painel recarregado no meio da call (SPA navegou): volta ao vivo.
            if (!aoVivo) entrarAoVivo(msg.sessao);
          } else if (!ultimaTela) {
            renderizarTela(p, { tela: "carregando", texto: "Preparando o copiloto" }, acoesTela);
          }
          if (msg.sessao.superficie === "monitor") {
            p.aplicarAvisoTela({ perigoso: true, superficie: "monitor" });
          }
          break;
        }
        case "MOSTRAR_TELA": {
          const p = await garantirPainel();
          ultimaTela = msg.dados;
          renderizarTela(p, msg.dados, acoesTela);
          break;
        }
        case "ESCUTA_INICIADA":
          await garantirPainel();
          entrarAoVivo(msg.sessao);
          break;
        case "AUDIO_EVENTO":
          if (aoVivo) aoVivo.tratarEvento(msg.evento);
          else if (painel && (msg.evento.tipo === "aviso" || msg.evento.tipo === "erro")) painel.avisar(msg.evento.texto);
          break;
        case "ATALHO":
          aoVivo?.atalho(msg.comando);
          break;
        case "PARAR_PAINEL":
          destruirLocal();
          break;
      }
    })();
  });

  // Avisa o service worker que o painel está de pé — se havia sessão nesta
  // aba (página recarregou no meio da call), ele reenvia o estado.
  enviarParaBackground({ tipo: "PAINEL_PRONTO" });
}

export {};
