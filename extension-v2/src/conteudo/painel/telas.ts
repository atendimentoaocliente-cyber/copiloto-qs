/**
 * Telas pré-call — vivem no lugar da grade ao vivo, dentro do mesmo painel.
 *
 *   carregando → reuniões (escolha do lead) → consentimento LGPD → briefing → [Iniciar escuta]
 *
 * Nada aqui anima além de background-color em hover. Sem spinner.
 */

import type { TelaPreCall } from "@/compartilhado/mensagens";
import type { Briefing, Reuniao } from "@/compartilhado/tipos";
import type { Painel } from "./painel";
import { atalhoAtivar, dataCurta, esc, horaCurta, reais } from "./util";

export interface AcoesTela {
  escolherLead(reuniaoId: string): void;
  recarregarReunioes(): void;
  confirmarConsentimento(): void;
  recusarConsentimento(): void;
  iniciarEscuta(): void;
  abrirOpcoes(): void;
  fechar(): void;
  /** Volta da tela de briefing para a grade ao vivo (quando a call já começou). */
  voltarParaAoVivo?: () => void;
}

function cabecalho(painel: Painel, glifo: string, titulo: string): void {
  painel.el.glifo.textContent = glifo;
  painel.el.titulo.textContent = titulo;
  painel.el.tempo.textContent = "";
  painel.el.raiz.dataset["estado"] = "ocioso";
  painel.el.raiz.classList.remove("fantasma", "closer-falando");
}

export function renderizarTela(painel: Painel, dados: TelaPreCall, acoes: AcoesTela): void {
  painel.mostrarTela();
  const tela = painel.el.tela;

  switch (dados.tela) {
    case "carregando":
      cabecalho(painel, "○", "Copiloto");
      tela.innerHTML = `<h2>${esc(dados.texto)}.</h2><p>Só um instante.</p>`;
      break;

    case "sem_pareamento":
      cabecalho(painel, "○", "Não pareado");
      tela.innerHTML = `
        <h2>A extensão ainda não está ligada ao seu usuário do QS.</h2>
        <p>Abra o QS → Configurações → Copiloto, gere o código de 6 dígitos e cole na página de opções da extensão.</p>
        <div class="cq-acoes-tela">
          <button class="cq-btn primario" data-acao="opcoes">Abrir configurações</button>
          <button class="cq-btn" data-acao="fechar">Fechar</button>
        </div>`;
      break;

    case "reunioes":
      cabecalho(painel, "○", "Qual lead é esta call?");
      tela.innerHTML = renderReunioes(dados.reunioes, dados.erro);
      break;

    case "consentimento":
      cabecalho(painel, "○", "Consentimento");
      tela.innerHTML = `
        <span class="cq-rotulo">Leia em voz alta para ${esc(primeiroNome(dados.reuniao.leadNome))}</span>
        <div class="cq-citacao">${esc(dados.texto)}</div>
        <p>Nada é gravado nem enviado antes de você confirmar. Se o lead recusar, o copiloto fica desligado nesta call.</p>
        <div class="cq-acoes-tela">
          <button class="cq-btn primario" data-acao="confirmar">✓ Li e o lead aceitou</button>
          <button class="cq-btn" data-acao="recusar">Lead recusou</button>
        </div>`;
      break;

    case "briefing":
      cabecalho(painel, "○", "Briefing pré-call");
      tela.innerHTML = renderBriefing(dados.reuniao, dados.briefing, dados.erroBriefing, Boolean(acoes.voltarParaAoVivo));
      break;

    case "recusado":
      cabecalho(painel, "○", "Copiloto desligado");
      tela.innerHTML = `
        <h2>Tudo certo. O copiloto fica desligado nesta call.</h2>
        <p>Nada foi gravado nem enviado. Este painel fecha sozinho.</p>
        <div class="cq-acoes-tela"><button class="cq-btn" data-acao="fechar">Fechar agora</button></div>`;
      setTimeout(() => acoes.fechar(), 8000);
      break;

    case "erro":
      cabecalho(painel, "▲", "Copiloto fora");
      tela.innerHTML = `
        <h2>${esc(dados.texto)}</h2>
        ${dados.acao === "reinvocar" ? `<p>Atalho: <b>${esc(atalhoAtivar())}</b>. O briefing e o consentimento estão guardados — você não precisa refazer nada.</p>` : ""}
        <div class="cq-acoes-tela"><button class="cq-btn" data-acao="fechar">Cancelar</button></div>`;
      break;
  }

  tela.querySelectorAll<HTMLElement>("[data-acao]").forEach((botao) => {
    botao.addEventListener("click", () => {
      const acao = botao.dataset["acao"];
      const id = botao.dataset["id"];
      switch (acao) {
        case "opcoes": acoes.abrirOpcoes(); break;
        case "fechar": acoes.fechar(); break;
        case "recarregar": acoes.recarregarReunioes(); break;
        case "lead": if (id) acoes.escolherLead(id); break;
        case "confirmar": acoes.confirmarConsentimento(); break;
        case "recusar": acoes.recusarConsentimento(); break;
        case "iniciar": acoes.iniciarEscuta(); break;
        case "voltar": acoes.voltarParaAoVivo?.(); break;
      }
    });
  });
}

function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome;
}

function renderReunioes(reunioes: Reuniao[], erro?: string): string {
  const lista = reunioes
    .slice()
    .sort((a, b) => a.inicio.localeCompare(b.inicio))
    .map((r) => `
      <button class="cq-item" data-acao="lead" data-id="${esc(r.id)}">
        <b>${esc(r.leadNome)}</b>
        <span>${esc(horaCurta(r.inicio))}${r.destino ? ` · ${esc(r.destino)}` : ""}${r.produto ? ` · ${esc(r.produto)}` : ""}${r.ticketEstimado ? ` · ${esc(reais(r.ticketEstimado))}` : ""}${r.sdrNome ? ` · SDR ${esc(r.sdrNome)}` : ""}</span>
      </button>`)
    .join("");

  return `
    <h2>Escolha a reunião desta call.</h2>
    ${erro ? `<p>${esc(erro)}</p>` : ""}
    ${lista ? `<div class="cq-lista">${lista}</div>` : `<p>Nenhuma reunião agendada para hoje. O copiloto só funciona com um lead do QS vinculado — agende a reunião no QS e atualize aqui.</p>`}
    <div class="cq-acoes-tela">
      <button class="cq-btn" data-acao="recarregar">Atualizar</button>
      <button class="cq-btn" data-acao="fechar">Cancelar</button>
    </div>`;
}

function renderBriefing(reuniao: Reuniao, b: Briefing | null, erro: string | undefined, aoVivo: boolean): string {
  const partes: string[] = [];
  const nome = b?.lead.nome ?? reuniao.leadNome;

  partes.push(`<h2>${esc(nome)}</h2>`);
  if (erro) partes.push(`<p>Sem briefing agora: ${esc(erro)}. Você pode iniciar assim mesmo.</p>`);

  const produto = b?.produto;
  if (produto || reuniao.destino || reuniao.produto) {
    partes.push(`<div class="cq-bloco">
      <span class="cq-rotulo">Produto de interesse</span>
      <p>${esc(produto?.nome ?? reuniao.produto ?? "—")}${(produto?.destino ?? reuniao.destino) ? ` · ${esc(produto?.destino ?? reuniao.destino)}` : ""}${produto?.duracaoDias ? ` · ${produto.duracaoDias} dias` : ""}</p>
      ${(produto?.ticketEstimado ?? reuniao.ticketEstimado) ? `<p class="fraca">Ticket estimado ${esc(reais(produto?.ticketEstimado ?? reuniao.ticketEstimado))}${produto?.periodo ? ` · ${esc(produto.periodo)}` : ""}</p>` : ""}
    </div>`);
  }

  const h = b?.handover;
  if (h) {
    partes.push(`<div class="cq-bloco">
      <span class="cq-rotulo">O que ${esc(h.sdrNome)} levantou · ${esc(dataCurta(h.criadoEm))}</span>
      <p>${esc(h.resumo)}</p>
      ${h.motivacao ? `<p class="fraca">Motivação: ${esc(h.motivacao)}</p>` : ""}
      ${h.decisores ? `<p class="fraca">Quem decide: ${esc(h.decisores)}</p>` : ""}
      ${h.orcamentoDeclarado ? `<p class="fraca">Orçamento declarado: ${esc(reais(h.orcamentoDeclarado))}</p>` : ""}
      ${h.perfilViagem ? `<p class="fraca">Perfil: ${esc(h.perfilViagem)}</p>` : ""}
      ${h.notas.length ? `<ul>${h.notas.slice(0, 5).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    </div>`);
  } else if (b) {
    partes.push(`<div class="cq-bloco"><span class="cq-rotulo">Handover</span><p class="fraca">O SDR ainda não registrou o handover deste lead.</p></div>`);
  }

  if (b?.historico.length) {
    partes.push(`<div class="cq-bloco">
      <span class="cq-rotulo">Histórico</span>
      <ul>${b.historico.slice(0, 5).map((i) => `<li>${esc(dataCurta(i.data))} · ${esc(i.descricao)}</li>`).join("")}</ul>
    </div>`);
  }

  if (b?.ultimasCalls.length) {
    const rotulo: Record<string, string> = { fechou: "fechou", sem_fechamento: "sem fechamento", follow_up: "follow-up", perdido: "perdido" };
    partes.push(`<div class="cq-bloco">
      <span class="cq-rotulo">Últimas calls deste lead</span>
      <ul>${b.ultimasCalls.slice(0, 3).map((c) => `<li>${esc(dataCurta(c.data))} · ${c.duracaoMin} min · ${c.objecoes} objeç${c.objecoes === 1 ? "ão" : "ões"} · ${esc(rotulo[c.resultado] ?? c.resultado)}</li>`).join("")}</ul>
    </div>`);
  }

  if (b?.playbook) {
    partes.push(`<div class="cq-bloco"><span class="cq-rotulo">Playbook carregado</span><p class="fraca">${esc(b.playbook.nome)} · ${b.playbook.totalObjecoes} objeções prontas</p></div>`);
  }

  partes.push(aoVivo
    ? `<div class="cq-acoes-tela"><button class="cq-btn primario" data-acao="voltar">Voltar ao painel</button></div>`
    : `<div class="cq-acoes-tela">
         <button class="cq-btn primario" data-acao="iniciar">▶ Iniciar escuta</button>
         <button class="cq-btn" data-acao="fechar">Cancelar</button>
       </div>`);

  return partes.join("");
}
