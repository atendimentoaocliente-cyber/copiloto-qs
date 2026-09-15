/**
 * O painel — DOM, arraste, janela flutuante (PiP) e alerta de tela.
 *
 * Por que NÃO começa em Document Picture-in-Picture: o Chrome só concede
 * `activeTab` no clique do ÍCONE; nesse caminho o content script não tem
 * "user activation" e `requestWindow()` falha. O painel nasce na página e
 * tem o botão ⧉ que, aí sim com clique do usuário, o destaca.
 *
 * O PiP some no compartilhamento de ABA e de JANELA, mas APARECE no de TELA
 * INTEIRA. Destacar não resolve a exposição — o que resolve é arrastar a
 * janela para outro monitor ou trocar o compartilhamento para "aba".
 */

import type { Preferencias } from "@/compartilhado/armazenamento";
import { enviarParaBackground } from "@/compartilhado/mensagens";
import type { AvisoTela } from "@/compartilhado/tipos";
import { ALTURA, ESTILO, ESTILO_PIP, LARGURA } from "./estilos";

export interface Elementos {
  raiz: HTMLDivElement;
  rail: HTMLDivElement;
  cabecalho: HTMLElement;
  glifo: HTMLSpanElement;
  titulo: HTMLSpanElement;
  tempo: HTMLSpanElement;
  seloTela: HTMLSpanElement;
  aviso: HTMLDivElement;
  alertaTela: HTMLDivElement;
  tela: HTMLElement;
  grade: HTMLElement;
  b: HTMLDivElement;
  c: HTMLDivElement;
  d: HTMLDivElement;
  e: HTMLDivElement;
  f: HTMLDivElement;
  g: HTMLDivElement;
  frase: HTMLParagraphElement;
  esqueleto: HTMLDivElement;
}

export class Painel {
  readonly el: Elementos;
  private janelaPip: Window | null = null;
  private estilo: HTMLStyleElement;
  private aoFechar: () => void;
  private timerAviso: ReturnType<typeof setTimeout> | null = null;
  private ouvintesTeclado: Array<(e: KeyboardEvent) => void> = [];

  constructor(op: { aoFechar: () => void; aoBriefing: () => void; preferencias: Preferencias }) {
    this.aoFechar = op.aoFechar;

    this.estilo = document.createElement("style");
    this.estilo.id = "copiloto-qs-estilo";
    this.estilo.textContent = ESTILO;
    document.head.appendChild(this.estilo);

    const raiz = document.createElement("div");
    raiz.id = "copiloto-qs";
    raiz.dataset["estado"] = "ocioso";
    raiz.dataset["nivel"] = "sugestao";
    raiz.innerHTML = `
      <div class="cq-rail"></div>
      <div class="cq-corpo">
        <header class="cq-a">
          <span class="cq-glifo">○</span>
          <span class="cq-titulo">Copiloto</span>
          <span class="cq-selo-tela">TELA</span>
          <span class="cq-tempo"></span>
          <button class="cq-btn-briefing" title="Ver briefing do lead">ⓘ</button>
          <button class="cq-btn-pip" title="Destacar em janela flutuante">⧉</button>
          <button class="cq-btn-fechar" title="Parar o copiloto">✕</button>
        </header>
        <div class="cq-alerta-tela">
          <b>TELA INTEIRA COMPARTILHADA — O LEAD VÊ ESTE PAINEL</b>
          <p>Compartilhe só a aba, ou destaque o painel e arraste para outro monitor.</p>
          <div class="cq-acoes-tela">
            <button class="cq-btn cq-btn-pip-alerta">Destacar em janela</button>
            <button class="cq-btn secundario cq-btn-mostrar-assim">Estou em outro monitor</button>
          </div>
        </div>
        <div class="cq-aviso"></div>
        <section class="cq-tela"></section>
        <section class="cq-grade" hidden>
          <div class="cq-b"></div>
          <div class="cq-c">
            <p class="cq-frase"></p>
            <div class="cq-esqueleto"><i></i><i></i></div>
          </div>
          <div class="cq-d"></div>
          <div class="cq-e"></div>
          <div class="cq-f"></div>
          <div class="cq-g"></div>
        </section>
      </div>
    `;
    document.body.appendChild(raiz);

    const q = <T extends Element>(sel: string): T => raiz.querySelector(sel) as T;
    this.el = {
      raiz,
      rail: q(".cq-rail"),
      cabecalho: q(".cq-a"),
      glifo: q(".cq-glifo"),
      titulo: q(".cq-titulo"),
      tempo: q(".cq-tempo"),
      seloTela: q(".cq-selo-tela"),
      aviso: q(".cq-aviso"),
      alertaTela: q(".cq-alerta-tela"),
      tela: q(".cq-tela"),
      grade: q(".cq-grade"),
      b: q(".cq-b"),
      c: q(".cq-c"),
      d: q(".cq-d"),
      e: q(".cq-e"),
      f: q(".cq-f"),
      g: q(".cq-g"),
      frase: q(".cq-frase"),
      esqueleto: q(".cq-esqueleto"),
    };

    this.aplicarPreferencias(op.preferencias);

    q<HTMLButtonElement>(".cq-btn-fechar").addEventListener("click", () => this.aoFechar());
    q<HTMLButtonElement>(".cq-btn-briefing").addEventListener("click", () => op.aoBriefing());
    q<HTMLButtonElement>(".cq-btn-pip").addEventListener("click", () => void this.destacarPip());
    q<HTMLButtonElement>(".cq-btn-pip-alerta").addEventListener("click", () => void this.destacarPip());
    q<HTMLButtonElement>(".cq-btn-mostrar-assim").addEventListener("click", () => {
      raiz.classList.add("mostrar-mesmo-assim");
    });

    this.tornarArrastavel(op.preferencias.posicaoPainel);
    this.ouvirVigiaDeTela();
  }

  // ── Preferências ──────────────────────────────────────────────────────────

  aplicarPreferencias(p: Preferencias): void {
    this.el.raiz.classList.toggle("fonte-grande", p.fonteGrande);
    this.el.raiz.classList.toggle("modo-minimo", p.modoMinimo);
    this.el.raiz.classList.toggle("sem-transicoes", p.semTransicoes);
  }

  // ── Documento atual (página ou PiP) ───────────────────────────────────────

  doc(): Document {
    return this.janelaPip?.document ?? document;
  }

  mostrarTela(): void {
    this.el.tela.hidden = false;
    this.el.grade.hidden = true;
  }

  mostrarGrade(): void {
    this.el.tela.hidden = true;
    this.el.grade.hidden = false;
  }

  /** Aviso não-vermelho, some sozinho. */
  avisar(texto: string, ms = 8000): void {
    this.el.aviso.textContent = texto;
    this.el.aviso.classList.add("on");
    if (this.timerAviso) clearTimeout(this.timerAviso);
    this.timerAviso = setTimeout(() => this.el.aviso.classList.remove("on"), ms);
  }

  limparAviso(): void {
    this.el.aviso.classList.remove("on");
  }

  // ── Teclado (na página e no PiP) ──────────────────────────────────────────

  ouvirTeclado(fn: (e: KeyboardEvent) => void): void {
    this.ouvintesTeclado.push(fn);
    document.addEventListener("keydown", fn, true);
    this.janelaPip?.document.addEventListener("keydown", fn, true);
  }

  // ── Arraste (só na página; no PiP a janela já é móvel) ────────────────────

  private tornarArrastavel(posicao: { x: number; y: number } | null): void {
    const alvo = this.el.raiz;
    if (posicao && posicao.x >= 0 && posicao.y >= 0 &&
        posicao.x + LARGURA <= window.innerWidth && posicao.y + ALTURA <= window.innerHeight) {
      alvo.style.left = `${posicao.x}px`;
      alvo.style.top = `${posicao.y}px`;
      alvo.style.right = "auto";
    }

    let sx = 0, sy = 0, ox = 0, oy = 0, arrastando = false;
    this.el.cabecalho.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON" || this.janelaPip) return;
      arrastando = true;
      sx = e.clientX; sy = e.clientY;
      const r = alvo.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!arrastando) return;
      alvo.style.left = `${ox + e.clientX - sx}px`;
      alvo.style.top = `${oy + e.clientY - sy}px`;
      alvo.style.right = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (!arrastando) return;
      arrastando = false;
      const r = alvo.getBoundingClientRect();
      chrome.storage.local.get("preferencias").then((res) => {
        const atual = (res["preferencias"] as Preferencias | undefined) ?? {};
        return chrome.storage.local.set({
          preferencias: { ...atual, posicaoPainel: { x: Math.round(r.left), y: Math.round(r.top) } },
        });
      }).catch(() => {});
    });
  }

  // ── Janela flutuante (precisa do clique do usuário) ───────────────────────

  async destacarPip(): Promise<void> {
    if (this.janelaPip) {
      this.janelaPip.focus();
      return;
    }
    const api = window.documentPictureInPicture;
    if (!api) {
      this.avisar("Este Chrome não suporta janela flutuante (precisa do 116+).");
      return;
    }
    try {
      const janela = await api.requestWindow({ width: LARGURA, height: ALTURA });
      this.janelaPip = janela;
      const est = janela.document.createElement("style");
      est.textContent = ESTILO + ESTILO_PIP;
      janela.document.head.appendChild(est);
      janela.document.body.appendChild(this.el.raiz);
      for (const fn of this.ouvintesTeclado) janela.document.addEventListener("keydown", fn, true);
      janela.addEventListener("pagehide", () => {
        document.body.appendChild(this.el.raiz);
        this.janelaPip = null;
      });
    } catch (err) {
      this.avisar(`Não abriu a janela: ${(err as Error).message}`);
    }
  }

  get emPip(): boolean {
    return this.janelaPip !== null;
  }

  /** O evento nasceu dentro do painel (na página) ou na janela flutuante? */
  eventoDoPainel(e: UIEvent): boolean {
    if (this.janelaPip && e.view === this.janelaPip) return true;
    const alvo = e.target;
    return alvo instanceof Node && this.el.raiz.contains(alvo);
  }

  // ── Vigia de compartilhamento de tela ─────────────────────────────────────

  private ouvirVigiaDeTela(): void {
    window.addEventListener("message", (e: MessageEvent) => {
      if (e.source !== window || e.data?.origem !== "copiloto-vigia") return;
      const aviso: AvisoTela = { perigoso: Boolean(e.data.perigoso), superficie: e.data.superficie ?? "desconhecido" };
      this.aplicarAvisoTela(aviso);
      enviarParaBackground({ tipo: "TELA", aviso });
    });
  }

  aplicarAvisoTela(aviso: AvisoTela): void {
    const raiz = this.el.raiz;
    if (aviso.perigoso) {
      raiz.classList.add("exposto");
      raiz.classList.remove("mostrar-mesmo-assim");
    } else {
      raiz.classList.remove("exposto", "mostrar-mesmo-assim");
      if (aviso.superficie === "browser") this.avisar("Compartilhando a aba · painel invisível ao lead", 5000);
      if (aviso.superficie === "window") this.avisar("Compartilhando a janela · painel invisível ao lead", 5000);
    }
  }

  // ── Destruição ────────────────────────────────────────────────────────────

  destruir(): void {
    for (const fn of this.ouvintesTeclado) {
      document.removeEventListener("keydown", fn, true);
      this.janelaPip?.document.removeEventListener("keydown", fn, true);
    }
    this.janelaPip?.close();
    this.janelaPip = null;
    this.el.raiz.remove();
    this.estilo.remove();
  }
}
