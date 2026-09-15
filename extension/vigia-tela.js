/**
 * Vigia de compartilhamento de tela.
 *
 * O painel do copiloto é invisível para o lead quando você compartilha
 * uma ABA ou uma JANELA. Mas quando você compartilha a TELA INTEIRA,
 * ele aparece — e o lead lê o script de contorno de objeção.
 *
 * Este módulo intercepta getDisplayMedia, descobre o que está sendo
 * compartilhado e esconde o painel automaticamente quando o risco existe.
 *
 * Roda no contexto da PÁGINA (não do content script isolado), porque
 * precisa substituir a função que o Meet chama.
 */

(() => {
  if (window.__COPILOTO_VIGIA__) return;
  window.__COPILOTO_VIGIA__ = true;

  const original = navigator.mediaDevices?.getDisplayMedia;
  if (!original) return;

  function avisar(perigoso, superficie) {
    window.postMessage(
      { origem: "copiloto-vigia", perigoso, superficie },
      "*"
    );
  }

  navigator.mediaDevices.getDisplayMedia = async function (...args) {
    const stream = await original.apply(this, args);

    try {
      const faixa = stream.getVideoTracks()[0];
      const cfg = faixa.getSettings?.() ?? {};
      // "monitor" = tela inteira | "window" = janela | "browser" = aba
      const superficie = cfg.displaySurface ?? "desconhecido";
      const perigoso = superficie === "monitor" || superficie === "desconhecido";

      avisar(perigoso, superficie);

      faixa.addEventListener("ended", () => avisar(false, "parou"));
    } catch {
      // na dúvida, trata como perigoso
      avisar(true, "desconhecido");
    }

    return stream;
  };
})();
