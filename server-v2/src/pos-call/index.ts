/**
 * Pós-call: resumo (Sonnet 5), próximo passo → qs_tasks, resumo → qs_notes,
 * qs_call_summaries, catalogação de objeções novas para a curadoria.
 *
 * Cada etapa tem seu próprio try/catch, registra o erro e SEGUE: uma falha
 * na criação da tarefa não pode impedir a gravação do resumo. O resultado
 * lista o que falhou e a sessão guarda isso em `error_message`.
 */
import type { RepositorioCopiloto } from "../db/repositorio.js";
import type { Logger } from "../logger.js";
import type { Metricas } from "../observabilidade/metricas.js";
import type { ClienteIa, ResumoCall } from "../motor/tipos.js";
import type { Sessao } from "../sessao/sessao.js";
import { mensagemDe } from "../util/erros.js";
import { podarResposta } from "../util/texto.js";

export interface ResultadoPosCall {
  resumoOk: boolean;
  tarefaCriada: boolean;
  notaCriada: boolean;
  objecoesCatalogadas: number;
  erros: string[];
}

export interface DependenciasPosCall {
  repo: RepositorioCopiloto;
  ia: ClienteIa | null;
  log: Logger;
  metricas: Metricas;
  categorias: () => Array<{ id: string; label: string }>;
  categoriaConhecida: (id: string) => boolean;
  minTurnosParaResumo?: number;
  agora?: () => Date;
}

export async function executarPosCall(sessao: Sessao, d: DependenciasPosCall): Promise<ResultadoPosCall> {
  const resultado: ResultadoPosCall = { resumoOk: false, tarefaCriada: false, notaCriada: false, objecoesCatalogadas: 0, erros: [] };
  const log = d.log.child({ callId: sessao.id });
  const minTurnos = d.minTurnosParaResumo ?? 4;
  const agora = d.agora ?? (() => new Date());

  // 0) O que falhou durante a call em persistência também entra no relatório.
  if (sessao.errosPersistencia.length) resultado.erros.push(`persistência durante a call: ${sessao.errosPersistencia.length} falha(s)`);

  // 1) Resumo com Sonnet 5
  let resumo: ResumoCall | null = null;
  let usoResumo = { modelo: "", tokensIn: 0, tokensOut: 0, usd: 0 };
  if (!d.ia) {
    resultado.erros.push("resumo não gerado: IA desligada (sem ANTHROPIC_API_KEY)");
  } else if (sessao.turnos.length < minTurnos) {
    resultado.erros.push(`resumo não gerado: call curta (${sessao.turnos.length} turnos)`);
  } else {
    try {
      const r = await d.ia.resumir(sessao.transcricaoCompleta(), sessao.briefingTexto(), d.categorias());
      resumo = r.dado;
      const usd = sessao.custo.registrarLlm(r.modelo, r.uso);
      usoResumo = { modelo: r.modelo, tokensIn: (r.uso.input_tokens ?? 0) + (r.uso.cache_read_input_tokens ?? 0), tokensOut: r.uso.output_tokens ?? 0, usd };
      resultado.resumoOk = true;
    } catch (err) {
      d.metricas.erro("pos_call_resumo");
      log.error({ err }, "falha ao gerar resumo");
      resultado.erros.push(`resumo: ${mensagemDe(err)}`);
    }
  }

  // 2) qs_call_summaries
  if (resumo) {
    try {
      const est = sessao.estatisticas();
      await d.repo.gravarResumo({
        callId: sessao.id,
        closerId: sessao.closerId,
        resumo: resumo.resumo,
        proximoPasso: resumo.proximoPasso?.descricao ?? null,
        proximoPassoPrazo: resumo.proximoPasso ? dataPrazo(agora(), resumo.proximoPasso.prazoDias) : null,
        temperatura: resumo.temperatura,
        temperaturaScore: resumo.temperaturaScore,
        objecoesDetectadas: agregarObjecoes(sessao, resumo),
        pontosPositivos: resumo.pontosPositivos,
        pontosAtencao: resumo.pontosAtencao,
        destinoMencionado: resumo.destino,
        orcamentoMencionado: resumo.orcamento,
        janelaViagem: resumo.janelaViagem,
        paxMencionado: resumo.pax,
        talkRatioCloser: est.talkRatioCloser,
        perguntasCloser: est.perguntasCloser,
        monologoMaxSeg: est.monologoMaxSeg,
        llmModel: usoResumo.modelo,
        tokensIn: usoResumo.tokensIn,
        tokensOut: usoResumo.tokensOut,
        custoUsd: usoResumo.usd,
      });
    } catch (err) {
      d.metricas.erro("pos_call_gravar_resumo");
      log.error({ err }, "falha ao gravar qs_call_summaries");
      resultado.erros.push(`qs_call_summaries: ${mensagemDe(err)}`);
    }
  }

  // 3) Nota no lead (qs_notes) — memória comercial visível no QS
  if (resumo && sessao.leadId) {
    try {
      await d.repo.criarNota({ leadId: sessao.leadId, authorId: sessao.closerId, body: formatarNota(resumo, sessao) });
      resultado.notaCriada = true;
    } catch (err) {
      d.metricas.erro("pos_call_nota");
      log.error({ err }, "falha ao criar qs_notes");
      resultado.erros.push(`qs_notes: ${mensagemDe(err)}`);
    }
  } else if (resumo && !sessao.leadId) {
    resultado.erros.push("nota e tarefa não criadas: call sem lead vinculado");
  }

  // 4) Próximo passo vira tarefa (qs_tasks)
  if (resumo?.proximoPasso && sessao.leadId) {
    try {
      const prazo = resumo.proximoPasso.prazoDias ?? 1;
      await d.repo.criarTarefa({
        leadId: sessao.leadId,
        ownerId: sessao.closerId,
        channelType: resumo.proximoPasso.canal,
        priority: resumo.temperatura === "quente" ? "alta" : resumo.temperatura === "morno" ? "media" : "baixa",
        scheduledAt: dataAgendada(agora(), prazo),
        notes: `[Copiloto] ${resumo.proximoPasso.descricao}`,
      });
      resultado.tarefaCriada = true;
    } catch (err) {
      d.metricas.erro("pos_call_tarefa");
      log.error({ err }, "falha ao criar qs_tasks");
      resultado.erros.push(`qs_tasks: ${mensagemDe(err)}`);
    }
  }

  // 5) Catalogação: objeções novas (do resumo) + sugestões geradas pelo L3 na call
  const paraCatalogar = new Map<string, { categoriaId: string; titulo: string; exemploLead: string; resposta: string }>();
  for (const o of resumo?.objecoesNovas ?? []) {
    paraCatalogar.set(o.titulo.trim().toLowerCase(), {
      categoriaId: d.categoriaConhecida(o.categoriaId) ? o.categoriaId : "outro",
      titulo: o.titulo.trim().slice(0, 120),
      exemploLead: o.comoOLeadFalou,
      resposta: podarResposta(o.respostaSugerida, 30),
    });
  }
  for (const det of sessao.deteccoes.values()) {
    if (det.fonte !== "ia" || det.retirada) continue;
    const titulo = `[call] ${det.trecho.slice(0, 80)}`;
    if (!paraCatalogar.has(titulo.toLowerCase())) {
      paraCatalogar.set(titulo.toLowerCase(), {
        categoriaId: d.categoriaConhecida(det.categoriaId) ? det.categoriaId : "outro",
        titulo,
        exemploLead: det.trecho,
        resposta: det.resposta,
      });
    }
  }
  for (const o of paraCatalogar.values()) {
    try {
      const r = await d.repo.catalogarObjecao({ ...o, respostaCurta: o.resposta, createdBy: sessao.closerId });
      if (r.nova) resultado.objecoesCatalogadas++;
    } catch (err) {
      d.metricas.erro("pos_call_catalogar");
      log.error({ err, titulo: o.titulo }, "falha ao catalogar objeção");
      resultado.erros.push(`catalogação: ${mensagemDe(err)}`);
    }
  }

  return resultado;
}

// ── auxiliares ──────────────────────────────────────────────────────────────

function agregarObjecoes(sessao: Sessao, resumo: ResumoCall) {
  const mapa = new Map<string, { category_id: string | null; objection_id: string | null; ocorrencias: number; superada: boolean | null }>();
  for (const det of sessao.deteccoes.values()) {
    if (det.retirada) continue;
    const chave = `${det.categoriaId}|${det.objecaoId ?? ""}`;
    const atual = mapa.get(chave) ?? { category_id: det.categoriaId, objection_id: det.objecaoId, ocorrencias: 0, superada: null };
    atual.ocorrencias++;
    mapa.set(chave, atual);
  }
  for (const o of resumo.objecoes) {
    for (const v of mapa.values()) if (v.category_id === o.categoriaId && v.superada === null) v.superada = o.superada;
    if (![...mapa.values()].some((v) => v.category_id === o.categoriaId)) {
      mapa.set(`${o.categoriaId}|llm`, { category_id: o.categoriaId, objection_id: null, ocorrencias: 1, superada: o.superada });
    }
  }
  return [...mapa.values()];
}

function formatarNota(r: ResumoCall, sessao: Sessao): string {
  const linhas = [
    `📞 Resumo da call (copiloto) — ${Math.round(sessao.duracaoMs / 60000)} min · temperatura: ${r.temperatura.toUpperCase()} (${r.temperaturaScore}/100)`,
    "",
    r.resumo,
    "",
    `Perfil: ${r.perfil}`,
  ];
  if (r.objecoes.length) linhas.push("", "Objeções: " + r.objecoes.map((o) => `${o.descricao}${o.superada ? " (superada)" : o.superada === false ? " (em aberto)" : ""}`).join("; "));
  if (r.proximoPasso) linhas.push("", `Próximo passo: ${r.proximoPasso.descricao}${r.proximoPasso.prazoDias != null ? ` (em ${r.proximoPasso.prazoDias} dia(s), via ${r.proximoPasso.canal})` : ""}`);
  if (r.pontosAtencao.length) linhas.push("", "Atenção: " + r.pontosAtencao.join("; "));
  return linhas.join("\n");
}

/** yyyy-mm-dd em São Paulo, N dias à frente. */
function dataPrazo(base: Date, dias: number | null): string {
  const d = new Date(base.getTime() + (dias ?? 1) * 86_400_000);
  return d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
}

/** ISO das 09:00 de São Paulo, N dias à frente (mesmo padrão do TasksPanel do QS). */
function dataAgendada(base: Date, dias: number): string {
  return `${dataPrazo(base, dias)}T09:00:00-03:00`;
}
