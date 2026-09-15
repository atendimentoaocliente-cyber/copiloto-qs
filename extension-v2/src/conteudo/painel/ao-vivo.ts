/**
 * Painel ao vivo — a máquina de estados que o closer vê durante a call.
 *
 * Estados: ocioso · escutando · detectando · sugerindo · reconectando · erro · degradado
 * Sub-estados: fantasma (card a 45%) · closer-falando (rail cinza) · pausado · silenciado
 *
 * Regras que este arquivo cumpre (06-UX-OVERLAY-ux.md):
 *   • UMA frase por vez, nunca bullets, nunca lista, nunca empilha.
 *   • Zona C sempre no mesmo Y. Nada reflui.
 *   • Um transiente por objeção: todas as mudanças de DOM no mesmo rAF.
 *   • Card tardio (> 2,5 s) é descartado. Cooldown de 8 s. Teto de 6 por call.
 *   • Timer em minutos. Sem transcrição rolando. Sem vermelho.
 *   • Nunca mudo fingindo ativo: reconectando/erro/degradado são estados visíveis.
 */

import { UX } from "@/compartilhado/config";
import type { EventoAudio } from "@/compartilhado/mensagens";
import type { EstadoAoVivo, Sessao, Sugestao, Tratada, ValorFeedback } from "@/compartilhado/tipos";
import type { Painel } from "./painel";
import { esc, horaCurta, relogioDesde, truncar } from "./util";

export interface AcoesAoVivo {
  feedback(sugestaoId: string, valor: ValorFeedback, categoria: string): void;
  pausar(): void;
  retomar(): void;
  reconectar(): void;
}

const TITULOS: Record<EstadoAoVivo, { glifo: string; titulo: string }> = {
  ocioso: { glifo: "○", titulo: "Ligando a escuta" },
  escutando: { glifo: "●", titulo: "Escutando" },
  detectando: { glifo: "●", titulo: "Preparando resposta" },
  sugerindo: { glifo: "●", titulo: "Sugestão" },
  reconectando: { glifo: "◐", titulo: "Reconectando" },
  erro: { glifo: "▲", titulo: "Copiloto fora" },
  degradado: { glifo: "▲", titulo: "Copiloto degradado" },
};

export class AoVivo {
  private estado: EstadoAoVivo = "ocioso";
  private card: Sugestao | null = null;
  private cardComFeedback = false;
  private fantasma = false;
  private closerFalando = false;
  private pausado = false;
  private silenciadoAte = 0;
  private cardsMostrados = 0;
  private tratadas: Tratada[];
  private ultimoCardEm = 0;
  private ultimaSugestaoHora: string | null = null;
  private ultimoEcoLead = "";
  private reconexao: { tentativa: number; maximo: number; filaSegundos: number } | null = null;
  private motivoDegradado = "";
  private textoErro = "";
  private cardSeguradoPeloTurno: Sugestao | null = null;
  private temMicrofone = true;

  private timerFantasma: ReturnType<typeof setTimeout> | null = null;
  private timerDetectando: ReturnType<typeof setTimeout> | null = null;
  private timerTurno: ReturnType<typeof setTimeout> | null = null;
  private timerTempo: ReturnType<typeof setInterval> | null = null;
  private timerSilencio: ReturnType<typeof setTimeout> | null = null;
  private rafPendente = 0;

  constructor(
    private readonly painel: Painel,
    private readonly sessao: Sessao,
    private readonly acoes: AcoesAoVivo,
  ) {
    this.tratadas = [...sessao.tratadas];
    this.painel.mostrarGrade();
    this.iniciarTempo();
    this.agendarRender();
  }

  // ── Entrada de eventos do canal de áudio ──────────────────────────────────

  tratarEvento(evento: EventoAudio): void {
    switch (evento.tipo) {
      case "capturando":
        this.temMicrofone = evento.temMicrofone;
        break;
      case "conectado":
        // Conectou mas o gateway ainda não disse "pronto": continua ocioso.
        break;
      case "pronto":
        this.reconexao = null;
        this.mudarEstado("escutando");
        break;
      case "recuperado":
        this.reconexao = null;
        this.motivoDegradado = "";
        this.mudarEstado(this.card && !this.fantasma ? "sugerindo" : "escutando");
        break;
      case "reconectando":
        this.reconexao = { tentativa: evento.tentativa, maximo: evento.maximo, filaSegundos: evento.filaSegundos };
        this.mudarEstado("reconectando");
        break;
      case "degradado":
        this.motivoDegradado = evento.motivo;
        this.mudarEstado("degradado");
        break;
      case "erro":
        this.textoErro = evento.texto;
        this.mudarEstado("erro");
        break;
      case "aviso":
        this.painel.avisar(evento.texto);
        break;
      case "transcricao":
        this.tratarTranscricao(evento.dados.falante, evento.dados.texto, evento.dados.final);
        break;
      case "sugestao":
        this.tratarSugestao(evento.dados);
        break;
      case "sugestao_retirada":
        if (this.card?.id === evento.sugestaoId && !this.cardComFeedback) {
          this.card = null;
          this.cardsMostrados = Math.max(0, this.cardsMostrados - 1);
          this.mudarEstado("escutando");
        }
        break;
      case "parado":
        this.mudarEstado("ocioso");
        break;
    }
  }

  /** Atalhos vindos do service worker (chrome.commands) ou do teclado local. */
  atalho(comando: "marcar-usei" | "marcar-nao-serviu" | "silenciar"): void {
    if (comando === "marcar-usei") this.marcar("usei");
    if (comando === "marcar-nao-serviu") this.marcar("nao_serviu");
    if (comando === "silenciar") this.alternarSilencio();
  }

  tecla(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === "Enter") { e.preventDefault(); this.marcar("usei"); }
    else if (e.key === "Backspace") { e.preventDefault(); this.marcar("nao_serviu"); }
    else if (e.key === " " || e.code === "Space") { e.preventDefault(); this.alternarSilencio(); }
  }

  destruir(): void {
    for (const t of [this.timerFantasma, this.timerDetectando, this.timerTurno, this.timerSilencio]) {
      if (t) clearTimeout(t);
    }
    if (this.timerTempo) clearInterval(this.timerTempo);
    if (this.rafPendente) cancelAnimationFrame(this.rafPendente);
  }

  // ── Transcrição: só alimenta eco e fronteira de turno. NUNCA é exibida rolando. ──

  private tratarTranscricao(falante: "lead" | "closer", texto: string, final: boolean): void {
    if (falante === "closer") {
      const antes = this.closerFalando;
      this.closerFalando = !final;
      if (final && this.cardSeguradoPeloTurno) this.liberarCardSegurado();
      if (antes !== this.closerFalando) this.agendarRender();
      return;
    }
    // Lead falou: se o closer estava marcado como falando, a fronteira de turno passou.
    if (this.closerFalando) {
      this.closerFalando = false;
      this.agendarRender();
    }
    if (texto.trim()) this.ultimoEcoLead = truncar(texto, UX.maxCaracteresEco);
  }

  // ── Card ──────────────────────────────────────────────────────────────────

  private tratarSugestao(s: Sugestao): void {
    const agora = Date.now();

    if (this.pausado || this.estaSilenciado()) return;

    // Card tardio: a janela conversacional já fechou. Melhor nada do que contradizer o closer.
    if (s.geradoEm && agora - s.geradoEm > UX.descarteTardioMs) {
      console.info("[Copiloto] sugestão descartada por latência:", s.categoria, agora - s.geradoEm, "ms");
      return;
    }

    // Só na fronteira de turno: se o closer está falando, segura por até 1,5 s.
    if (this.closerFalando && !s.pendente) {
      this.cardSeguradoPeloTurno = s;
      if (this.timerTurno) clearTimeout(this.timerTurno);
      this.timerTurno = setTimeout(() => this.liberarCardSegurado(), 1500);
      return;
    }

    // Atualização de um card pendente (mesmo id) não passa pelo cooldown nem pelo teto.
    const completandoPendente = this.estado === "detectando" && this.card?.id === s.id && !s.pendente;

    if (!completandoPendente) {
      if (this.cardsMostrados >= UX.tetoCardsPorCall) {
        console.info("[Copiloto] teto de cards atingido — só registrando:", s.categoria);
        return;
      }
      const emCooldown = agora - this.ultimoCardEm < UX.cooldownMs;
      if (emCooldown) {
        const promove = s.nivel === "atencao" && this.card?.nivel !== "atencao";
        if (!promove) {
          console.info("[Copiloto] cooldown — sugestão não exibida:", s.categoria);
          return;
        }
      }
    }

    // Card anterior sem feedback vira "ignorou" na fila.
    if (this.card && !this.cardComFeedback && this.card.id !== s.id && !this.card.pendente) {
      this.registrarTratada(this.card, "ignorou");
    }

    this.card = {
      ...s,
      frase: truncar(s.frase ?? "", this.tetoFrase()),
      eco: s.eco ? truncar(s.eco, UX.maxCaracteresEco) : this.ultimoEcoLead || undefined,
    };
    this.cardComFeedback = false;
    this.fantasma = false;

    if (s.pendente) {
      this.mudarEstado("detectando");
      if (this.timerDetectando) clearTimeout(this.timerDetectando);
      this.timerDetectando = setTimeout(() => {
        // A frase não chegou a tempo: volta a escutar. Nada de sugestão fora de hora.
        if (this.estado === "detectando") {
          this.card = null;
          this.mudarEstado("escutando");
        }
      }, UX.detectandoMaximoMs);
      return;
    }

    if (this.timerDetectando) clearTimeout(this.timerDetectando);
    if (!completandoPendente) this.cardsMostrados++;
    this.ultimoCardEm = agora;
    this.ultimaSugestaoHora = horaCurta(new Date().toISOString());
    this.mudarEstado("sugerindo");

    if (this.timerFantasma) clearTimeout(this.timerFantasma);
    this.timerFantasma = setTimeout(() => this.virarFantasma(), UX.fantasmaMs);
  }

  private liberarCardSegurado(): void {
    const s = this.cardSeguradoPeloTurno;
    this.cardSeguradoPeloTurno = null;
    if (this.timerTurno) clearTimeout(this.timerTurno);
    this.closerFalando = false;
    if (s) this.tratarSugestao(s);
  }

  private virarFantasma(): void {
    if (this.estado !== "sugerindo") return;
    this.fantasma = true;
    this.agendarRender();
  }

  private marcar(valor: ValorFeedback): void {
    if (this.estado !== "sugerindo" || !this.card || this.cardComFeedback) return;
    const card = this.card;
    this.cardComFeedback = true;
    this.registrarTratada(card, valor);
    this.acoes.feedback(card.id, valor, card.categoria);

    if (valor === "usei") {
      // Confirmação foveal: flash de 120 ms no botão, depois fantasma imediato.
      const botao = this.painel.el.g.querySelector<HTMLButtonElement>(".cq-btn.primario");
      botao?.classList.add("flash");
      setTimeout(() => botao?.classList.remove("flash"), 120);
      if (this.timerFantasma) clearTimeout(this.timerFantasma);
      this.virarFantasma();
      return;
    }

    if (valor === "nao_serviu" && card.alternativa) {
      // Plano B sobe para a zona C. Continua sendo UMA frase.
      this.card = { ...card, frase: truncar(card.alternativa, this.tetoFrase()), alternativa: undefined };
      this.cardComFeedback = false; // ele ainda pode marcar "usei" na alternativa
      this.fantasma = false;
      if (this.timerFantasma) clearTimeout(this.timerFantasma);
      this.timerFantasma = setTimeout(() => this.virarFantasma(), UX.fantasmaMs);
      this.agendarRender();
      return;
    }

    if (this.timerFantasma) clearTimeout(this.timerFantasma);
    this.virarFantasma();
  }

  private registrarTratada(card: Sugestao, valor: ValorFeedback): void {
    this.tratadas.push({ em: new Date().toISOString(), categoria: card.categoria, valor });
    if (this.tratadas.length > 50) this.tratadas.shift();
    if (valor === "ignorou") this.acoes.feedback(card.id, "ignorou", card.categoria);
  }

  // ── Pausar / silenciar ────────────────────────────────────────────────────

  private alternarPausa(): void {
    this.pausado = !this.pausado;
    if (this.pausado) this.acoes.pausar();
    else this.acoes.retomar();
    this.agendarRender();
  }

  private alternarSilencio(): void {
    if (this.estaSilenciado()) {
      this.silenciadoAte = 0;
    } else {
      this.silenciadoAte = Date.now() + UX.silenciarMs;
      if (this.timerSilencio) clearTimeout(this.timerSilencio);
      this.timerSilencio = setTimeout(() => this.agendarRender(), UX.silenciarMs + 50);
    }
    this.agendarRender();
  }

  private estaSilenciado(): boolean {
    return this.silenciadoAte > Date.now();
  }

  // ── Estado e render ───────────────────────────────────────────────────────

  private mudarEstado(novo: EstadoAoVivo): void {
    this.estado = novo;
    this.agendarRender();
  }

  private tetoFrase(): number {
    return this.painel.el.raiz.classList.contains("fonte-grande") ? 52 : UX.maxCaracteresFrase;
  }

  /** Todas as mudanças de DOM num único frame: um transiente, não três. */
  private agendarRender(): void {
    if (this.rafPendente) return;
    this.rafPendente = requestAnimationFrame(() => {
      this.rafPendente = 0;
      this.render();
    });
  }

  private render(): void {
    const { el } = this.painel;
    const raiz = el.raiz;
    const estado = this.estado;
    const card = this.card;

    raiz.dataset["estado"] = estado;
    raiz.dataset["nivel"] = card?.nivel ?? "sugestao";
    raiz.classList.toggle("fantasma", estado === "sugerindo" && this.fantasma);
    raiz.classList.toggle("closer-falando", this.closerFalando);

    // A. barra de estado
    const t = TITULOS[estado];
    let titulo = t.titulo;
    let glifo = t.glifo;
    if (estado === "sugerindo") {
      if (this.fantasma) { titulo = "Escutando"; glifo = "○"; }
      else titulo = card?.nivel === "atencao" ? "Atenção" : "Sugestão";
    }
    if (this.pausado) { titulo = "Pausado"; glifo = "⏸"; }
    else if (this.estaSilenciado()) { titulo = `Silenciado até ${horaCurta(new Date(this.silenciadoAte).toISOString())}`; glifo = "○"; }
    el.glifo.textContent = glifo;
    el.titulo.textContent = titulo;

    // B. contexto
    el.b.innerHTML = this.renderB();

    // C. zona de aterrissagem — frase troca com fade de 280 ms (só opacity)
    const fraseNova = this.fraseParaC();
    const sistema = estado !== "sugerindo" && estado !== "detectando";
    if (el.frase.textContent !== fraseNova) {
      el.frase.classList.add("entrando");
      el.frase.textContent = fraseNova;
      el.frase.classList.toggle("sistema", sistema);
      // força o estilo inicial antes de tirar a classe: fade 0 → 1
      void el.frase.offsetWidth;
      el.frase.classList.remove("entrando");
    } else {
      el.frase.classList.toggle("sistema", sistema);
    }

    // D. âncora
    el.d.innerHTML = this.renderD();

    // E. alternativa
    el.e.innerHTML = this.renderE();

    // F. fila recente
    el.f.innerHTML = this.renderF();

    // G. ações
    this.renderG();
  }

  private renderB(): string {
    const lead = this.sessao.reuniao?.leadNome ?? "Lead";
    const destino = this.sessao.briefing?.produto?.destino ?? this.sessao.reuniao?.destino;
    const dias = this.sessao.briefing?.produto?.duracaoDias;
    const linhaLead = `${esc(lead)}${destino ? ` · ${esc(destino)}` : ""}${dias ? ` ${dias}d` : ""}`;
    const restantes = Math.max(0, UX.tetoCardsPorCall - this.cardsMostrados);

    switch (this.estado) {
      case "sugerindo":
      case "detectando": {
        const c = this.card;
        if (!c) return "";
        return `<span class="cq-chip">${esc(c.categoria)}</span>${c.eco ? `<span class="cq-eco">«${esc(c.eco)}»</span>` : ""}`;
      }
      case "reconectando":
        return `<span class="cq-contexto">Tentativa ${this.reconexao?.tentativa ?? 1} de ${this.reconexao?.maximo ?? 5}</span>
                <span class="cq-contexto fraca">${linhaLead}</span>`;
      case "erro":
        return `<span class="cq-contexto">${this.ultimaSugestaoHora ? `Última sugestão às ${esc(this.ultimaSugestaoHora)}` : "Nenhuma sugestão ainda"}</span>
                <span class="cq-contexto fraca">${esc(this.textoErro)}</span>`;
      case "degradado":
        return `<span class="cq-contexto">Sem sugestões no momento</span>
                <span class="cq-contexto fraca">${esc(this.motivoDegradado)}</span>`;
      case "ocioso":
        return `<span class="cq-contexto">${linhaLead}</span><span class="cq-contexto fraca">Conectando ao copiloto</span>`;
      case "escutando":
      default: {
        const teto = restantes === 0 ? "teto atingido · só registrando" : `${restantes} restante${restantes === 1 ? "" : "s"} no teto`;
        const mic = this.temMicrofone ? "" : " · sem microfone";
        return `<span class="cq-contexto">${linhaLead}</span>
                <span class="cq-contexto fraca">${this.tratadas.length} tratada${this.tratadas.length === 1 ? "" : "s"} · ${teto}${mic}</span>`;
      }
    }
  }

  private fraseParaC(): string {
    switch (this.estado) {
      case "sugerindo": return this.card?.frase ?? "";
      case "detectando": return "";
      case "reconectando": return "Voltando em instantes.";
      case "erro": return "Segue a call normalmente.";
      case "degradado": return "Segue a call normalmente.";
      case "ocioso": return "Ligando a escuta.";
      case "escutando":
      default: return this.card && this.fantasma ? this.card.frase : "";
    }
  }

  private renderD(): string {
    switch (this.estado) {
      case "sugerindo":
        return this.card?.ancora
          ? `<span class="cq-rotulo">${esc(this.card.ancora.rotulo)}</span><span class="cq-ancora">${esc(this.card.ancora.texto)}</span>`
          : "";
      case "reconectando":
        return `<span class="cq-rotulo">Áudio sendo guardado localmente</span><span class="cq-ancora">Nada da call será perdido${this.reconexao?.filaSegundos ? ` · ${this.reconexao.filaSegundos} s na fila` : ""}</span>`;
      case "erro":
        return `<span class="cq-rotulo">Copiloto fora</span><span class="cq-ancora">A call continua. Tente religar abaixo.</span>`;
      case "degradado":
        return `<span class="cq-rotulo">Transcrição preservada</span><span class="cq-ancora">O resumo pós-call continua garantido.</span>`;
      case "escutando":
        if (this.card && this.fantasma && this.card.ancora) {
          return `<span class="cq-rotulo">${esc(this.card.ancora.rotulo)}</span><span class="cq-ancora">${esc(this.card.ancora.texto)}</span>`;
        }
        return "";
      default:
        return "";
    }
  }

  private renderE(): string {
    if (this.estado !== "sugerindo" || !this.card?.alternativa) return "";
    return `<span class="cq-alt"><b>ou →</b>${esc(this.card.alternativa)}</span>`;
  }

  private renderF(): string {
    if (this.estado === "detectando" && !this.tratadas.length) return "";
    const rotulo: Record<ValorFeedback, string> = { usei: "✓ usou", nao_serviu: "✗ não serviu", ignorou: "— ignorou" };
    const itens = this.tratadas.slice(-2).reverse();
    if (!itens.length) return `<span class="cq-rotulo">Já tratadas</span><ul class="cq-fila"><li><span></span><span>Nenhuma ainda</span></li></ul>`;
    return `<span class="cq-rotulo">Já tratadas</span><ul class="cq-fila">${itens
      .map((t) => `<li><span>${esc(relogioDesde(this.sessao.iniciadaEm, t.em))}</span><span>${esc(t.categoria)}</span><span>${rotulo[t.valor]}</span></li>`)
      .join("")}</ul>`;
  }

  private renderG(): void {
    const g = this.painel.el.g;
    let html = "";
    switch (this.estado) {
      case "sugerindo":
      case "detectando": {
        const desab = this.estado === "detectando" || this.cardComFeedback ? "disabled" : "";
        html = `<button class="cq-btn primario" data-acao="usei" ${desab}>✓ Usei</button>
                <button class="cq-btn" data-acao="nao-serviu" ${desab}>Não serviu</button>`;
        break;
      }
      case "reconectando":
        html = "";
        break;
      case "erro":
        html = `<button class="cq-btn primario" data-acao="reconectar">⤾ Tentar de novo</button>`;
        break;
      case "ocioso":
        html = "";
        break;
      case "escutando":
      case "degradado":
      default:
        html = this.pausado
          ? `<button class="cq-btn primario" data-acao="pausar">▶ Retomar</button>`
          : `<button class="cq-btn" data-acao="pausar">⏸ Pausar</button>
             <button class="cq-btn" data-acao="silenciar">${this.estaSilenciado() ? "Reativar" : "Silenciar 5 min"}</button>`;
    }
    if (g.innerHTML === html) return;
    g.innerHTML = html;
    g.querySelectorAll<HTMLButtonElement>("[data-acao]").forEach((b) => {
      b.addEventListener("click", () => {
        switch (b.dataset["acao"]) {
          case "usei": this.marcar("usei"); break;
          case "nao-serviu": this.marcar("nao_serviu"); break;
          case "pausar": this.alternarPausa(); break;
          case "silenciar": this.alternarSilencio(); break;
          case "reconectar": this.acoes.reconectar(); this.mudarEstado("reconectando"); break;
        }
      });
    });
  }

  // ── Timer em MINUTOS — atualiza 1×/min, nunca segundos ────────────────────

  private iniciarTempo(): void {
    const inicio = this.sessao.iniciadaEm ? new Date(this.sessao.iniciadaEm).getTime() : Date.now();
    const atualizar = () => {
      const min = Math.floor((Date.now() - inicio) / 60000);
      this.painel.el.tempo.textContent = `${min} min`;
    };
    atualizar();
    const ateProximoMinuto = 60000 - ((Date.now() - inicio) % 60000);
    setTimeout(() => {
      atualizar();
      this.timerTempo = setInterval(atualizar, 60000);
    }, ateProximoMinuto);
  }
}
