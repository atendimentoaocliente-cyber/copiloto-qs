/**
 * Lembrete automático no Google Meet.
 *
 * O Chrome não deixa uma extensão capturar áudio sem invocação do usuário
 * (é o que impede qualquer extensão de gravar suas reuniões em silêncio).
 * Então o mais próximo de "automático" é: detectar que você entrou numa
 * call e lembrar, com o atalho na cara.
 *
 * Some sozinho em 12 segundos, ou quando o copiloto é ativado.
 */

(() => {
  if (window.__COPILOTO_LEMBRETE__) return;
  window.__COPILOTO_LEMBRETE__ = true;

  const ATALHO = navigator.platform.includes("Mac")
    ? "⌘ + Shift + K"
    : "Ctrl + Shift + K";

  let mostrado = false;
  let elemento = null;

  /** Está dentro de uma reunião? (não na home do Meet) */
  function dentroDaCall() {
    const cod = location.pathname.slice(1);
    if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(cod)) return false;
    // botões de mídia só existem depois de entrar
    return Boolean(
      document.querySelector('[data-is-muted]') ||
      document.querySelector('[aria-label*="microfone" i]') ||
      document.querySelector('[aria-label*="microphone" i]')
    );
  }

  function mostrar() {
    if (mostrado || document.getElementById("copiloto-qs")) return;
    mostrado = true;

    elemento = document.createElement("div");
    elemento.id = "cq-lembrete";
    elemento.innerHTML = `
      <div style="font-weight:700;font-size:14px;margin-bottom:3px">
        Copiloto QS pronto
      </div>
      <div style="font-size:13px;opacity:.85;line-height:1.45">
        Aperte <b style="background:rgba(255,255,255,.18);padding:2px 7px;
        border-radius:5px;white-space:nowrap">${ATALHO}</b>
        ou clique no ícone da extensão para ativar nesta call.
      </div>
    `;
    Object.assign(elemento.style, {
      position: "fixed",
      bottom: "100px",
      right: "20px",
      zIndex: "2147483646",
      maxWidth: "310px",
      padding: "14px 16px",
      borderRadius: "12px",
      background: "#0D1B4B",
      color: "#fff",
      font: "14px/1.5 system-ui, -apple-system, sans-serif",
      boxShadow: "0 10px 32px rgba(0,0,0,.4)",
      transition: "opacity .3s, transform .3s",
      opacity: "0",
      transform: "translateY(8px)",
      cursor: "pointer",
    });
    elemento.addEventListener("click", sumir);
    document.body.appendChild(elemento);

    requestAnimationFrame(() => {
      elemento.style.opacity = "1";
      elemento.style.transform = "translateY(0)";
    });

    setTimeout(sumir, 12000);
  }

  function sumir() {
    if (!elemento) return;
    elemento.style.opacity = "0";
    elemento.style.transform = "translateY(8px)";
    setTimeout(() => { elemento?.remove(); elemento = null; }, 300);
  }

  // O Meet é uma SPA: observa até a call realmente começar
  const observador = new MutationObserver(() => {
    if (dentroDaCall()) {
      mostrar();
      observador.disconnect();
    }
    // se o copiloto foi ativado, tira o lembrete da frente
    if (document.getElementById("copiloto-qs")) sumir();
  });

  observador.observe(document.body, { childList: true, subtree: true });
  if (dentroDaCall()) { mostrar(); observador.disconnect(); }
})();
