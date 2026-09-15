/**
 * Lembrete automático nas plataformas de reunião.
 *
 * O Chrome não deixa uma extensão capturar áudio sem invocação do usuário
 * (é o que impede qualquer extensão de gravar reuniões em silêncio). Então
 * o mais próximo de "automático" é detectar que o closer entrou numa call e
 * lembrar, com o atalho na cara. Botão na página NÃO concede activeTab.
 *
 * Some sozinho em 12 segundos, ou quando o copiloto é ativado.
 */

(() => {
  if (window.__COPILOTO_LEMBRETE__) return;
  window.__COPILOTO_LEMBRETE__ = true;

  const ATALHO = navigator.platform.includes("Mac") ? "⌘ + Shift + K" : "Ctrl + Shift + K";

  let mostrado = false;
  let elemento: HTMLDivElement | null = null;

  /** Está dentro de uma reunião? (não na home) */
  function dentroDaCall(): boolean {
    const host = location.hostname;
    if (host === "meet.google.com") {
      if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(location.pathname.slice(1))) return false;
      return Boolean(
        document.querySelector("[data-is-muted]") ||
        document.querySelector('[aria-label*="microfone" i]') ||
        document.querySelector('[aria-label*="microphone" i]'),
      );
    }
    if (/zoom\.us$/.test(host)) return /\/wc\/\d+\/(join|start)/.test(location.pathname) || Boolean(document.querySelector('[aria-label*="mute" i]'));
    if (/teams\.(microsoft|live)\.com$/.test(host)) return Boolean(document.querySelector('[data-tid="toggle-mute"], [aria-label*="mute" i]'));
    return false;
  }

  function mostrar(): void {
    if (mostrado || document.getElementById("copiloto-qs")) return;
    mostrado = true;

    elemento = document.createElement("div");
    elemento.id = "cq-lembrete";
    elemento.innerHTML = `
      <div style="font-weight:700;font-size:14px;margin-bottom:3px">Copiloto QS pronto</div>
      <div style="font-size:13px;opacity:.85;line-height:1.45">
        Aperte <b style="background:rgba(255,255,255,.18);padding:2px 7px;border-radius:5px;white-space:nowrap">${ATALHO}</b>
        ou clique no ícone da extensão para ativar nesta call.
      </div>`;
    Object.assign(elemento.style, {
      position: "fixed", bottom: "100px", right: "20px", zIndex: "2147483646",
      maxWidth: "310px", padding: "14px 16px", borderRadius: "12px",
      background: "#0D1B4B", color: "#fff",
      font: "14px/1.5 system-ui, -apple-system, sans-serif",
      boxShadow: "0 10px 32px rgba(0,0,0,.4)",
      transition: "opacity .3s", opacity: "0", cursor: "pointer",
    } satisfies Partial<CSSStyleDeclaration>);
    elemento.addEventListener("click", sumir);
    document.body.appendChild(elemento);
    requestAnimationFrame(() => { if (elemento) elemento.style.opacity = "1"; });
    setTimeout(sumir, 12000);
  }

  function sumir(): void {
    if (!elemento) return;
    elemento.style.opacity = "0";
    const el = elemento;
    setTimeout(() => el.remove(), 300);
    elemento = null;
  }

  // As plataformas são SPA: observa até a call realmente começar.
  const observador = new MutationObserver(() => {
    if (dentroDaCall()) {
      mostrar();
      observador.disconnect();
    }
    if (document.getElementById("copiloto-qs")) sumir();
  });
  observador.observe(document.body, { childList: true, subtree: true });
  if (dentroDaCall()) { mostrar(); observador.disconnect(); }
})();

export {};
