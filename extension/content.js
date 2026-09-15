// Guarda: o background injeta este script sob demanda; evita registrar
// os listeners duas vezes se ele já estiver presente na página.
if (window.__COPILOTO_QS__) {
  console.debug("[Copiloto] já carregado nesta aba");
} else {
  window.__COPILOTO_QS__ = true;

/**
 * Content script — painel do copiloto dentro da página.
 *
 * Por que NÃO começa pelo Document Picture-in-Picture:
 * o Chrome só concede `activeTab` (necessário para chrome.tabCapture)
 * quando o usuário clica no ÍCONE DA EXTENSÃO. Nesse caminho o content
 * script não tem "user activation", e requestWindow() exige isso.
 *
 * Solução: o painel nasce como elemento da página (sempre funciona) e
 * tem um botão ⧉ que, aí sim com clique do usuário, o destaca em janela
 * flutuante.
 */

const SERVIDOR = "http://localhost:8787";

let painel = null;
let elementos = {};
let janelaPip = null;
let ativo = false;
let timerSugestao = null;
let linhaParcial = null;

// ── Painel ──────────────────────────────────────────────────────────────────

const ESTILO = `
  #copiloto-qs { position: fixed; top: 14px; left: 50%;
    transform: translateX(-50%); width: 420px;
    max-height: 78vh; z-index: 2147483647; background: #0D1B4B; color: #fff;
    border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
    font: 14px/1.5 system-ui, -apple-system, sans-serif; display: flex;
    flex-direction: column; overflow: hidden; }
  #copiloto-qs * { box-sizing: border-box; margin: 0; padding: 0; }
  #cq-cab { padding: 10px 12px; display: flex; align-items: center; gap: 8px;
    border-bottom: 1px solid rgba(255,255,255,.12); cursor: move; flex-shrink: 0; }
  #cq-ponto { width: 8px; height: 8px; border-radius: 50%; background: #667085; flex-shrink: 0; }
  #cq-ponto.on { background: #12B76A; animation: cqpulsa 2s infinite; }
  #cq-ponto.erro { background: #F04438; }
  @keyframes cqpulsa { 50% { opacity: .3 } }
  #cq-status { font-size: 12px; opacity: .85; flex: 1; }
  #cq-cab button { width: 26px; height: 26px; border: none; border-radius: 6px;
    background: rgba(255,255,255,.12); color: #fff; cursor: pointer; font-size: 13px; }
  #cq-sug { margin: 10px; padding: 14px; border-radius: 10px; background: #fff;
    color: #0D1B4B; display: none; flex-shrink: 0; }
  #cq-sug.on { display: block; }
  #cq-rot { font-size: 10px; font-weight: 700; letter-spacing: .09em;
    text-transform: uppercase; color: #1A55FF; margin-bottom: 5px; }
  #cq-frase { font-size: 18px; font-weight: 600; line-height: 1.35; }
  /* A transcrição fica em SEGUNDO PLANO: escondida por padrão.
     O closer não deve ler texto rolando — só a frase que importa. */
  #cq-txt { display: none; overflow-y: auto; padding: 6px 12px 12px;
    flex-direction: column; gap: 7px; max-height: 220px;
    border-top: 1px solid rgba(255,255,255,.12); }
  #copiloto-qs.transcricao #cq-txt { display: flex; }

  /* Repouso: uma pastilha discreta. Nada de painel grande ocupando a tela. */
  #copiloto-qs { transition: width .18s ease, background-color .18s ease; }
  #copiloto-qs.repouso { width: 210px; }
  #copiloto-qs.repouso #cq-sug { display: none; }
  .cq-l { font-size: 13px; }
  .cq-q { font-size: 10px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; opacity: .55; display: block; }
  .cq-l.lead .cq-q { color: #7FB0FF }
  .cq-l.closer { opacity: .6 }
  .cq-l.parcial { opacity: .45; font-style: italic }
  #cq-pe { padding: 7px 12px; font-size: 11px; opacity: .5;
    border-top: 1px solid rgba(255,255,255,.12); flex-shrink: 0;
    display: flex; gap: 10px; }
  #cq-pe span { flex: 1 }
  #cq-alerta { display: none; padding: 10px 12px; background: #B42318;
    color: #fff; font-size: 12px; font-weight: 600; line-height: 1.35; flex-shrink: 0; }
  #cq-alerta.on { display: block; }
  #copiloto-qs.oculto #cq-sug,
  #copiloto-qs.oculto #cq-txt { filter: blur(9px); opacity: .25; pointer-events: none; }
`;

function criarPainel() {
  if (painel) return;

  const estilo = document.createElement("style");
  estilo.textContent = ESTILO;
  document.head.appendChild(estilo);

  painel = document.createElement("div");
  painel.id = "copiloto-qs";
  painel.className = "repouso";
  painel.innerHTML = `
    <div id="cq-cab">
      <span id="cq-ponto"></span>
      <span id="cq-status">Iniciando…</span>
      <button id="cq-txt-toggle" title="Mostrar/ocultar transcrição">☰</button>
      <button id="cq-pip" title="Destacar em janela flutuante">⧉</button>
      <button id="cq-fechar" title="Parar">■</button>
    </div>
    <div id="cq-alerta"></div>
    <div id="cq-sug"><div id="cq-rot"></div><div id="cq-frase"></div></div>
    <div id="cq-txt"></div>
    <div id="cq-pe"><span id="cq-info">Pronto</span><b id="cq-timer">00:00</b></div>
  `;
  document.body.appendChild(painel);

  elementos = {
    ponto: painel.querySelector("#cq-ponto"),
    status: painel.querySelector("#cq-status"),
    sug: painel.querySelector("#cq-sug"),
    rot: painel.querySelector("#cq-rot"),
    frase: painel.querySelector("#cq-frase"),
    txt: painel.querySelector("#cq-txt"),
    pe: painel.querySelector("#cq-info"),
    timer: painel.querySelector("#cq-timer"),
    alerta: painel.querySelector("#cq-alerta"),
  };

  iniciarTimer();
  ouvirVigiaDeTela();

  painel.querySelector("#cq-fechar").addEventListener("click", parar);
  painel.querySelector("#cq-pip").addEventListener("click", destacarPip);
  painel.querySelector("#cq-txt-toggle").addEventListener("click", () => {
    painel.classList.toggle("transcricao");
    // Abrir a transcrição tira o painel do repouso para caber o texto.
    if (painel.classList.contains("transcricao")) painel.classList.remove("repouso");
    else if (!elementos.sug.classList.contains("on")) painel.classList.add("repouso");
  });
  arrastavel(painel.querySelector("#cq-cab"), painel);
}

// ── Timer da call ───────────────────────────────────────────────────────────

let t0 = 0, timerId = null, totalObjecoes = 0;

function iniciarTimer() {
  t0 = Date.now();
  totalObjecoes = 0;
  clearInterval(timerId);
  timerId = setInterval(() => {
    if (!elementos.timer) return;
    const s = Math.floor((Date.now() - t0) / 1000);
    elementos.timer.textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
}

// ── Vigia de compartilhamento de tela ───────────────────────────────────────
// O painel é invisível ao compartilhar ABA ou JANELA, mas aparece ao
// compartilhar a TELA INTEIRA. Aqui a gente detecta e borra o conteúdo.

function ouvirVigiaDeTela() {
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.origem !== "copiloto-vigia") return;
    const { perigoso, superficie } = e.data;

    if (perigoso) {
      painel?.classList.add("oculto");
      elementos.alerta.textContent =
        "⚠️ VOCÊ ESTÁ COMPARTILHANDO A TELA INTEIRA — o lead consegue ver este painel. Compartilhe apenas a aba.";
      elementos.alerta.classList.add("on");
    } else {
      painel?.classList.remove("oculto");
      elementos.alerta.classList.remove("on");
      if (superficie !== "parou") {
        definirStatus(`Compartilhando ${superficie === "browser" ? "a aba" : "a janela"} · seguro`, "on");
      }
    }
  });
}

function arrastavel(alca, alvo) {
  let sx = 0, sy = 0, ox = 0, oy = 0, arrastando = false;
  alca.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "BUTTON") return;
    arrastando = true;
    sx = e.clientX; sy = e.clientY;
    const r = alvo.getBoundingClientRect();
    ox = r.left; oy = r.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!arrastando) return;
    alvo.style.left = ox + e.clientX - sx + "px";
    alvo.style.top = oy + e.clientY - sy + "px";
    alvo.style.right = "auto";
    alvo.style.transform = "none"; // sai do centro ao ser arrastado
  });
  document.addEventListener("mouseup", () => { arrastando = false; });
}

// ── Destacar em janela flutuante (precisa do clique do usuário) ──────────────

async function destacarPip() {
  if (!("documentPictureInPicture" in window)) {
    definirStatus("Chrome sem suporte a janela flutuante", "erro");
    return;
  }
  try {
    janelaPip = await documentPictureInPicture.requestWindow({
      width: 400, height: 560,
    });
    const est = janelaPip.document.createElement("style");
    est.textContent = ESTILO + `
      body { margin:0; background:#0D1B4B }
      #copiloto-qs { position:static; width:100%; max-height:100vh;
        height:100vh; border-radius:0; box-shadow:none }
      #cq-cab { cursor: default }
    `;
    janelaPip.document.head.appendChild(est);
    janelaPip.document.body.appendChild(painel);
    janelaPip.addEventListener("pagehide", () => {
      document.body.appendChild(painel);
      janelaPip = null;
    });
  } catch (err) {
    definirStatus("Não abriu a janela: " + err.message, "erro");
  }
}

// ── Desenho ─────────────────────────────────────────────────────────────────

function definirStatus(texto, estado = "") {
  if (!elementos.status) return;
  elementos.status.textContent = texto;
  elementos.ponto.className = estado;
}

function doc() {
  return janelaPip ? janelaPip.document : document;
}

function escreverTranscricao({ texto, falante, final }) {
  if (!elementos.txt || !texto?.trim()) return;
  const rotulo = falante === "lead" ? "Lead" : "Você";

  if (!final) {
    if (!linhaParcial) {
      linhaParcial = doc().createElement("div");
      elementos.txt.appendChild(linhaParcial);
    }
    linhaParcial.className = `cq-l parcial ${falante}`;
    linhaParcial.innerHTML = `<span class="cq-q">${rotulo}</span>${texto}`;
  } else {
    const linha = linhaParcial || doc().createElement("div");
    linha.className = `cq-l ${falante}`;
    linha.innerHTML = `<span class="cq-q">${rotulo}</span>${texto}`;
    if (!linhaParcial) elementos.txt.appendChild(linha);
    linhaParcial = null;
  }

  elementos.txt.scrollTop = elementos.txt.scrollHeight;
  while (elementos.txt.children.length > 40) {
    elementos.txt.removeChild(elementos.txt.firstChild);
  }
}

function mostrarSugestao({ categoria, resposta, latenciaMs, fonte }) {
  if (!elementos.sug) return;
  elementos.rot.textContent = categoria + (fonte === "ia" ? " · IA" : "");
  elementos.frase.textContent = resposta;
  elementos.sug.classList.add("on");
  totalObjecoes++;
  if (elementos.pe) {
    elementos.pe.textContent =
      `${totalObjecoes} objeç${totalObjecoes === 1 ? "ão" : "ões"}` +
      (latenciaMs ? ` · ${latenciaMs} ms` : "");
  }
  // Acorda o painel só agora: é este o momento que merece o olhar do closer.
  painel?.classList.remove("repouso");

  clearTimeout(timerSugestao);
  timerSugestao = setTimeout(() => {
    elementos.sug.classList.remove("on");
    // Volta a ficar discreto, a não ser que a transcrição esteja aberta.
    if (!painel?.classList.contains("transcricao")) painel?.classList.add("repouso");
  }, 20000);
}

// ── Ciclo de vida ───────────────────────────────────────────────────────────

function parar() {
  auto?.parar();
  auto = null;
  jaIniciou = false;
  chrome.runtime.sendMessage({ destino: "background", tipo: "PARAR" });
  ativo = false;
  janelaPip?.close();
  janelaPip = null;
  painel?.remove();
  painel = null;
  elementos = {};
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.destino !== "content") return;

  if (msg.tipo === "MOSTRAR_PAINEL") {
    criarPainel();
    ativo = true;
    definirStatus("Conectando…");
    return;
  }
  if (msg.tipo === "PARAR_PAINEL") { parar(); return; }

  if (!painel) return;

  switch (msg.tipo) {
    case "CONECTADO":   definirStatus("Escutando a call", "on"); break;
    case "CAPTURANDO":  definirStatus(`Escutando · ${msg.taxaNativa} Hz`, "on"); break;
    case "AVISO":
    case "ERRO":        definirStatus(msg.texto, "erro"); break;
    case "DESCONECTADO":definirStatus("Servidor caiu", "erro"); break;
    case "PARADO":      definirStatus("Parado"); clearInterval(timerId); break;
    case "RECONECTANDO":definirStatus(`Reconectando… (${msg.tentativa})`, "erro"); break;
    case "SERVIDOR": {
      const p = msg.payload;
      if (p.tipo === "transcricao") escreverTranscricao(p);
      if (p.tipo === "sugestao") mostrarSugestao(p);
      if (p.tipo === "pronto") {
        definirStatus(p.ia ? "Escutando · IA ativa" : "Escutando a call", "on");
      }
      if (p.tipo === "reconectando") {
        definirStatus(`Reconectando… (${p.tentativa})`, "erro");
      }
      if (p.tipo === "erro") definirStatus(p.texto, "erro");
      break;
    }
  }
});


// ── Início automático ───────────────────────────────────────────────────────
// Sem clique: assim que a call começa, o copiloto liga sozinho.

let auto = null;
let jaIniciou = false;

/** Está dentro de uma reunião? (não na home, não na tela de "entrar") */
function dentroDaCall() {
  const cod = location.pathname.slice(1);
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(cod)) return false;
  // Áudio tocando = a call começou de verdade.
  const midias = document.querySelectorAll("audio, video");
  for (const m of midias) if (m.srcObject || m.src) return true;
  return false;
}

async function iniciarAutomatico() {
  if (jaIniciou) return;
  jaIniciou = true;

  try {
    const { AutoCaptura } = await import(chrome.runtime.getURL("auto-captura.js"));
    criarPainel();
    definirStatus("Ligando…");

    auto = new AutoCaptura({
      servidor: SERVIDOR,
      aoEvento: (ev) => {
        switch (ev.tipo) {
          case "INICIADA":    definirStatus("Escutando a call", "on"); break;
          case "CONECTADA":   definirStatus("Escutando a call", "on"); break;
          case "PARTICIPANTE":definirStatus("Escutando a call", "on"); break;
          case "AVISO":
          case "ERRO":        definirStatus(ev.texto, "erro"); break;
          case "RECONECTANDO":definirStatus(`Reconectando… (${ev.tentativa})`, "erro"); break;
          case "PARADA":      definirStatus("Parado"); break;
          case "SERVIDOR": {
            const p = ev.payload;
            if (p.tipo === "transcricao") escreverTranscricao(p);
            if (p.tipo === "sugestao") mostrarSugestao(p);
            if (p.tipo === "pronto") definirStatus("Escutando a call", "on");
            if (p.tipo === "erro") definirStatus(p.texto, "erro");
            break;
          }
        }
      },
    });

    await auto.iniciar();
  } catch (err) {
    console.error("[Copiloto] auto-início falhou:", err);
    definirStatus("Falha ao iniciar: " + err.message, "erro");
    jaIniciou = false;
  }
}

// O Meet é uma SPA: observa até a call realmente começar.
const vigiaCall = new MutationObserver(() => {
  if (!jaIniciou && dentroDaCall()) iniciarAutomatico();
});
vigiaCall.observe(document.documentElement, { childList: true, subtree: true });
if (dentroDaCall()) iniciarAutomatico();
setInterval(() => { if (!jaIniciou && dentroDaCall()) iniciarAutomatico(); }, 2500);

}
