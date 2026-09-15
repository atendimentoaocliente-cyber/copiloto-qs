/**
 * Vigia de compartilhamento de tela — roda no contexto da PÁGINA (world MAIN).
 *
 * O painel é invisível ao lead quando o closer compartilha uma ABA ou uma
 * JANELA. Mas quando compartilha a TELA INTEIRA, o painel aparece — e o
 * lead lê o script de contorno de objeção.
 *
 * Intercepta `getDisplayMedia`, lê `displaySurface` da faixa de vídeo e
 * avisa o content script via `window.postMessage`.
 *
 * IMPORTANTE: esta função é injetada com `chrome.scripting.executeScript({ func })`,
 * o que a serializa com `toString()`. Por isso ela é AUTOCONTIDA: não pode
 * referenciar nada de fora do próprio corpo (nem imports, nem constantes do
 * módulo). No world MAIN não existe `chrome.runtime`, então o loader de
 * content scripts do bundler não funcionaria aqui — daí a injeção por função.
 */
export function vigiaDeTela(): void {
  if (window.__COPILOTO_VIGIA__) return;
  window.__COPILOTO_VIGIA__ = true;

  const dispositivos = navigator.mediaDevices;
  const original = dispositivos?.getDisplayMedia;
  if (!dispositivos || !original) return;

  const avisar = (perigoso: boolean, superficie: string): void => {
    window.postMessage({ origem: "copiloto-vigia", perigoso, superficie }, "*");
  };

  dispositivos.getDisplayMedia = async function (
    this: MediaDevices,
    ...args: Parameters<MediaDevices["getDisplayMedia"]>
  ): Promise<MediaStream> {
    const stream = await original.apply(this, args);
    try {
      const faixa = stream.getVideoTracks()[0];
      const cfg = (faixa?.getSettings?.() ?? {}) as { displaySurface?: string };
      // "monitor" = tela inteira | "window" = janela | "browser" = aba
      const superficie = cfg.displaySurface ?? "desconhecido";
      const perigoso = superficie === "monitor" || superficie === "desconhecido";
      avisar(perigoso, superficie);
      faixa?.addEventListener("ended", () => avisar(false, "parou"));
    } catch {
      // na dúvida, trata como perigoso
      avisar(true, "desconhecido");
    }
    return stream;
  };
}
