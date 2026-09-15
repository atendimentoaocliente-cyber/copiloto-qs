// src/components/sdr/copiloto/CallDetailPage.tsx — Detalhe de uma call
//
// Transcrição com falantes, timeline das objeções detectadas (com latência, o que
// foi sugerido e se o closer usou), resumo da IA e ações de volta para o QS:
// criar tarefa (qs_tasks) e salvar o resumo na ficha do lead (qs_notes).

import { useState, useEffect, useCallback, useMemo } from "react";
import { useQsAuth } from "@/contexts/QsAuthContext";
import {
  fetchCopilotCall,
  fetchCopilotTranscricao,
  fetchCopilotDeteccoes,
  criarTarefaDaCall,
  salvarResumoComoNota,
  COTACAO_USD_BRL,
} from "@/lib/qs/copiloto";
import type { ChannelType, PriorityLevel } from "../types";
import { CHANNEL_LABELS, PRIORITY_LABELS } from "../types";
import type { CopilotCallSession, CopilotTranscriptTurn, CopilotDetection } from "./types";
import { CALL_STATUS_LABELS, TEMPERATURA_LABELS, PLATFORM_LABELS, OUTCOME_LABELS, MATCH_METHOD_LABELS, SPEAKER_LABELS } from "./types";
import {
  Pagina,
  Hero,
  Cartao,
  Selo,
  Carregando,
  ErroBanner,
  Botao,
  Campo,
  Modal,
  Toast,
  TituloSecao,
  CLASSE_INPUT,
  COR_TEMPERATURA,
  COR_STATUS_CALL,
  COR_OUTCOME,
  AZUL,
  AZUL_VIVO,
  fmtDataHora,
  fmtDuracao,
  fmtMs,
  fmtLatencia,
  fmtBRL,
  fmtPct,
  fmtData,
  hexComAlpha,
  mensagemDoErro,
  type ToastEstado,
} from "./ui";

interface CallDetailPageProps {
  callId: string;
  onBack: () => void;
  onOpenLead?: (leadId: string) => void;
}

function mediana(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function amanha9h(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString().slice(0, 16);
}

function dataLocalParaIso(local: string): string {
  return new Date(local).toISOString();
}

// ── Card de detecção (reutilizado na timeline e inline na transcrição) ────────

function CardDeteccao({ d, compacto = false }: { d: CopilotDetection; compacto?: boolean }) {
  const cor = d.category?.cor ?? "#64748B";
  const sugerido = d.suggestion_shown ?? d.objection?.resposta_curta ?? null;
  return (
    <div id={`det-${d.id}`} className="rounded-lg bg-white" style={{ borderLeft: `3px solid ${cor}`, border: "1px solid #EAECF0", borderLeftWidth: 3, borderLeftColor: cor }}>
      <div className={`px-4 ${compacto ? "py-2.5" : "py-3"}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-bold tabular-nums text-gray-400">{fmtMs(d.detected_at_ms)}</span>
          <Selo cor={cor}>{d.category?.label ?? "Sem categoria"}</Selo>
          {d.objection?.titulo && <span className="text-[12px] font-semibold text-gray-700 truncate">{d.objection.titulo}</span>}
          {!d.objection_id && <span className="text-[11px] italic" style={{ color: "#B54708" }}>sem objeção no playbook</span>}
          <span className="ml-auto flex items-center gap-1.5">
            <Selo cor={COR_OUTCOME[d.outcome]} solido={d.outcome === "usada"}>{OUTCOME_LABELS[d.outcome]}</Selo>
          </span>
        </div>
        {!compacto && (
          <p className="text-[13px] text-gray-700 italic mt-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 not-italic mr-1">Lead</span>“{d.trecho}”
          </p>
        )}
        <div className="mt-2 rounded-md px-3 py-2" style={{ background: hexComAlpha(AZUL_VIVO, 0.06) }}>
          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: AZUL_VIVO }}>Sugerido na tela</p>
          <p className="text-[13px] font-semibold leading-snug mt-0.5" style={{ color: AZUL }}>
            {sugerido ?? <span className="text-gray-400 font-normal">nada exibido (abaixo do limiar ou em cooldown)</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-2 text-[11px] text-gray-400 tabular-nums">
          <span title="Da fala do lead ao pixel na tela">
            latência <strong className={d.latency_ms !== null && d.latency_ms > 2000 ? "" : "text-gray-700"} style={d.latency_ms !== null && d.latency_ms > 2000 ? { color: "#B54708" } : undefined}>{fmtLatencia(d.latency_ms)}</strong>
            {d.latency_ms !== null && d.latency_ms > 2000 ? " · acima da meta (2 s)" : ""}
          </span>
          <span>·</span>
          <span>{MATCH_METHOD_LABELS[d.match_method]} {fmtPct(d.similarity * 100)}</span>
          {d.superada !== null && (
            <>
              <span>·</span>
              <span style={{ color: d.superada ? "#027A48" : "#B42318" }}>{d.superada ? "objeção contornada" : "não contornada"}</span>
            </>
          )}
          {d.feedback_note && (
            <>
              <span>·</span>
              <span className="italic">“{d.feedback_note}”</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Página ───────────────────────────────────────────────────────────────────

export default function CallDetailPage({ callId, onBack, onOpenLead }: CallDetailPageProps) {
  const { currentUser } = useQsAuth();

  const [call, setCall] = useState<CopilotCallSession | null>(null);
  const [turnos, setTurnos] = useState<CopilotTranscriptTurn[]>([]);
  const [deteccoes, setDeteccoes] = useState<CopilotDetection[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<unknown>(null);
  const [toast, setToast] = useState<ToastEstado | null>(null);
  const [buscaTranscricao, setBuscaTranscricao] = useState("");

  // Modal de tarefa
  const [modalTarefa, setModalTarefa] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [tCanal, setTCanal] = useState<ChannelType>("whatsapp");
  const [tPrioridade, setTPrioridade] = useState<PriorityLevel>("alta");
  const [tQuando, setTQuando] = useState(amanha9h());
  const [tNotas, setTNotas] = useState("");

  function avisar(mensagem: string, tipo: ToastEstado["tipo"] = "sucesso") {
    setToast({ mensagem, tipo });
    setTimeout(() => setToast(null), 3200);
  }

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const [c, t, d] = await Promise.all([fetchCopilotCall(callId), fetchCopilotTranscricao(callId), fetchCopilotDeteccoes(callId)]);
      setCall(c);
      setTurnos(t);
      setDeteccoes(d);
      const s = c.summary;
      if (s?.proximo_passo) setTNotas(`Copiloto · ${s.proximo_passo}`);
      if (s?.proximo_passo_prazo) setTQuando(`${s.proximo_passo_prazo}T09:00`);
    } catch (e) {
      setErro(e);
    } finally {
      setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Call ao vivo / processando: atualiza sozinha a cada 10 s
  useEffect(() => {
    if (!call || !["gravando", "processando", "pausada", "aguardando"].includes(call.status)) return;
    const id = setInterval(carregar, 10_000);
    return () => clearInterval(id);
  }, [call, carregar]);

  // ── Métricas ──
  const metricas = useMemo(() => {
    const exibidas = deteccoes.filter((d) => d.shown_at || d.suggestion_shown);
    const usadas = deteccoes.filter((d) => d.outcome === "usada");
    const lat = deteccoes.map((d) => d.latency_ms).filter((v): v is number => v !== null);
    const custo = ((call?.stt_cost_usd ?? 0) + (call?.llm_cost_usd ?? 0)) * COTACAO_USD_BRL;
    return {
      objecoes: deteccoes.length,
      exibidas: exibidas.length,
      usadas: usadas.length,
      taxaUso: exibidas.length > 0 ? (usadas.length / exibidas.length) * 100 : null,
      latP50: mediana(lat),
      custo,
    };
  }, [deteccoes, call]);

  // Detecção → turno da transcrição (por transcript_id ou pelo tempo)
  const deteccoesPorTurno = useMemo(() => {
    const mapa = new Map<number, CopilotDetection[]>();
    if (turnos.length === 0) return mapa;
    for (const d of deteccoes) {
      let turnoId: number | null = d.transcript_id;
      if (turnoId === null) {
        // último turno que começou antes (ou no instante) da detecção
        let candidato: CopilotTranscriptTurn | null = null;
        for (const t of turnos) {
          if (t.ts_start_ms <= d.detected_at_ms) candidato = t;
          else break;
        }
        turnoId = candidato?.id ?? turnos[0].id;
      }
      const arr = mapa.get(turnoId) ?? [];
      arr.push(d);
      mapa.set(turnoId, arr);
    }
    return mapa;
  }, [turnos, deteccoes]);

  const turnosVisiveis = useMemo(() => {
    const q = buscaTranscricao.trim().toLowerCase();
    if (!q) return turnos;
    return turnos.filter((t) => t.content.toLowerCase().includes(q));
  }, [turnos, buscaTranscricao]);

  const duracaoMs = (call?.duration_seconds ?? 0) * 1000 || Math.max(...turnos.map((t) => t.ts_end_ms ?? t.ts_start_ms), ...deteccoes.map((d) => d.detected_at_ms), 1);

  function irParaDeteccao(id: string) {
    document.getElementById(`det-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ── Ações de volta para o QS ──
  async function criarTarefa() {
    if (!call?.lead_id) return;
    setSalvando(true);
    try {
      await criarTarefaDaCall({
        lead_id: call.lead_id,
        owner_id: call.closer_id,
        channel_type: tCanal,
        priority: tPrioridade,
        scheduled_at: dataLocalParaIso(tQuando),
        notes: tNotas.trim(),
      });
      setModalTarefa(false);
      avisar("Tarefa criada no painel do closer.");
    } catch (e) {
      avisar(mensagemDoErro(e), "erro");
    } finally {
      setSalvando(false);
    }
  }

  async function salvarNota() {
    if (!call?.lead_id || !call.summary || !currentUser) return;
    const s = call.summary;
    const corpo = [
      `Resumo do Copiloto · call de ${fmtDataHora(call.started_at ?? call.created_at)} · ${fmtDuracao(call.duration_seconds)} · temperatura ${TEMPERATURA_LABELS[s.temperatura].toLowerCase()}`,
      "",
      s.resumo,
      s.proximo_passo ? `\nPróximo passo: ${s.proximo_passo}${s.proximo_passo_prazo ? ` (até ${fmtData(s.proximo_passo_prazo)})` : ""}` : "",
      s.pontos_atencao.length ? `\nPontos de atenção: ${s.pontos_atencao.join("; ")}` : "",
      deteccoes.length ? `\nObjeções: ${deteccoes.map((d) => d.objection?.titulo ?? d.category?.label ?? d.trecho).join("; ")}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n");
    setSalvando(true);
    try {
      await salvarResumoComoNota(call.lead_id, currentUser.id, corpo);
      avisar("Resumo salvo na ficha do lead.");
    } catch (e) {
      avisar(mensagemDoErro(e), "erro");
    } finally {
      setSalvando(false);
    }
  }

  if (loading && !call) return <Pagina><Carregando texto="Carregando call..." /></Pagina>;

  if (erro && !call) {
    return (
      <Pagina>
        <Hero titulo="Call" aoVoltar={onBack} rotuloVoltar="Voltar para calls" />
        <ErroBanner erro={erro} aoTentar={carregar} />
      </Pagina>
    );
  }
  if (!call) return null;

  const s = call.summary;
  const nomeLead = call.lead?.full_name ?? call.titulo ?? "Lead não vinculado";
  const aoVivo = ["gravando", "pausada"].includes(call.status);

  return (
    <Pagina>
      <Hero
        aoVoltar={onBack}
        rotuloVoltar="Voltar para calls"
        titulo={
          <span className="flex items-center gap-2 flex-wrap">
            {nomeLead}
            {s?.destino_mencionado && <span className="font-normal text-white/80">· {s.destino_mencionado}</span>}
            {aoVivo && (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-white/20">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#FCA5A5" }} /> ao vivo
              </span>
            )}
          </span>
        }
        subtitulo={`${call.closer?.name ?? "Closer"} · ${fmtDataHora(call.started_at ?? call.created_at)} · ${fmtDuracao(call.duration_seconds)} · ${PLATFORM_LABELS[call.platform]} · ${CALL_STATUS_LABELS[call.status]}`}
        kpis={[
          { valor: String(metricas.objecoes), label: "Objeções", sub: `${metricas.exibidas} com sugestão na tela` },
          { valor: metricas.exibidas > 0 ? `${metricas.usadas} de ${metricas.exibidas}` : "—", label: "Sugestões usadas", sub: fmtPct(metricas.taxaUso) },
          { valor: fmtLatencia(metricas.latP50), label: "Latência mediana", sub: "fala do lead → tela · meta < 2 s" },
          { valor: fmtBRL(metricas.custo), label: "Custo da call", sub: "STT (transcrição) + IA" },
        ]}
        acoes={
          call.lead_id && onOpenLead ? (
            <button onClick={() => onOpenLead(call.lead_id!)} className="px-4 py-2 rounded-lg text-sm font-semibold bg-white/20 hover:bg-white/30 transition-colors text-white">
              Abrir lead
            </button>
          ) : undefined
        }
      />

      {erro && <ErroBanner erro={erro} aoTentar={carregar} titulo="Falha ao atualizar a call" />}

      {call.status === "erro" && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-[13px] text-red-700">
          <strong>A sessão terminou com erro.</strong> {call.error_message ?? "Sem detalhe registrado pelo gateway."}
        </div>
      )}
      {call.status === "aguardando" && (
        <div className="rounded-xl px-5 py-3 text-[13px] bg-white" style={{ border: "1px solid #EAECF0" }}>
          <strong style={{ color: AZUL }}>Sessão preparada.</strong> O closer precisa abrir o Meet e clicar no ícone da extensão para começar a captura. Esta tela atualiza sozinha.
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* ── Coluna principal ── */}
        <div className="col-span-2 space-y-6">
          {/* Timeline */}
          <section className="space-y-3">
            <TituloSecao sub="Cada marca é uma objeção detectada. Clique para ir até ela.">Timeline de objeções</TituloSecao>
            <Cartao className="px-5 py-4">
              {deteccoes.length === 0 ? (
                <p className="text-[13px] text-gray-500">Nenhuma objeção detectada nesta call{aoVivo ? " até agora" : ""}.</p>
              ) : (
                <div className="relative pt-1 pb-5">
                  <div className="h-2 rounded-full bg-gray-100 relative">
                    {deteccoes.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => irParaDeteccao(d.id)}
                        title={`${fmtMs(d.detected_at_ms)} · ${d.category?.label ?? ""} · ${OUTCOME_LABELS[d.outcome]}`}
                        className="absolute rounded-full transition-transform"
                        style={{
                          left: `calc(${Math.min(100, (d.detected_at_ms / duracaoMs) * 100)}% - 7px)`,
                          top: -3,
                          width: 14,
                          height: 14,
                          background: d.category?.cor ?? "#64748B",
                          border: "2px solid #fff",
                          boxShadow: "0 0 0 1px rgba(16,24,40,0.1)",
                        }}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-400 tabular-nums mt-2">
                    <span>00:00</span>
                    <span>{fmtMs(duracaoMs)}</span>
                  </div>
                </div>
              )}
              {deteccoes.length > 0 && (
                <div className="space-y-2">
                  {deteccoes.map((d) => (
                    <CardDeteccao key={d.id} d={d} />
                  ))}
                </div>
              )}
            </Cartao>
          </section>

          {/* Transcrição */}
          <section className="space-y-3">
            <TituloSecao sub={`${turnos.length} turnos de fala · lead e closer em canais separados`}>Transcrição</TituloSecao>
            <Cartao className="overflow-hidden">
              <div className="px-5 py-3" style={{ borderBottom: "1px solid #F2F4F7" }}>
                <input
                  type="text"
                  value={buscaTranscricao}
                  onChange={(e) => setBuscaTranscricao(e.target.value)}
                  placeholder="Buscar um trecho na transcrição..."
                  className={CLASSE_INPUT}
                />
              </div>
              <div className="overflow-y-auto max-h-[80vh]">
                {turnos.length === 0 && (
                  <p className="px-5 py-8 text-[13px] text-gray-500 text-center">
                    {aoVivo ? "Aguardando os primeiros turnos finais da transcrição..." : "Sem transcrição persistida para esta call."}
                  </p>
                )}
                {turnosVisiveis.map((t) => {
                  const isLead = t.speaker === "lead";
                  const dets = deteccoesPorTurno.get(t.id) ?? [];
                  return (
                    <div key={t.id} className="px-5 py-3" style={{ borderBottom: "1px solid #F2F4F7" }}>
                      <div className="flex items-start gap-3">
                        <span className="text-[11px] tabular-nums text-gray-400 shrink-0 w-10 mt-0.5">{fmtMs(t.ts_start_ms)}</span>
                        <div className="min-w-0 flex-1">
                          <span className="block text-[10px] font-bold uppercase tracking-wider" style={{ color: isLead ? AZUL_VIVO : "#98A2B3" }}>
                            {SPEAKER_LABELS[t.speaker]}
                            {t.confidence !== null && t.confidence < 0.6 && <span className="ml-1.5 font-medium normal-case" style={{ color: "#B54708" }}>· baixa confiança</span>}
                          </span>
                          <p className={`text-sm leading-relaxed ${isLead ? "text-gray-900" : "text-gray-600"}`}>{t.content}</p>
                        </div>
                      </div>
                      {dets.length > 0 && (
                        <div className="space-y-2 mt-2" style={{ marginLeft: 52 }}>
                          {dets.map((d) => (
                            <CardDeteccao key={`inline-${d.id}`} d={d} compacto />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {turnos.length > 0 && turnosVisiveis.length === 0 && (
                  <p className="px-5 py-8 text-[13px] text-gray-500 text-center">Nenhum trecho contém “{buscaTranscricao}”.</p>
                )}
              </div>
            </Cartao>
          </section>
        </div>

        {/* ── Coluna lateral ── */}
        <div className="space-y-6">
          <section className="space-y-3">
            <TituloSecao sub={s ? `gerado por ${s.llm_model ?? "IA"} · ${fmtDataHora(s.created_at)}` : undefined}>Resumo da IA</TituloSecao>
            <Cartao className="px-5 py-4 space-y-4">
              {!s ? (
                <p className="text-[13px] text-gray-500">
                  {call.status === "processando" ? "A IA está gerando o resumo. Esta tela atualiza sozinha." : aoVivo ? "O resumo é gerado ao encerrar a call." : "Sem resumo para esta call."}
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Selo cor={COR_TEMPERATURA[s.temperatura]} solido>{TEMPERATURA_LABELS[s.temperatura]}</Selo>
                    {s.temperatura_score !== null && <span className="text-[11px] text-gray-400 tabular-nums">score {s.temperatura_score}/100</span>}
                    {s.revisado_at && <Selo cor="#027A48">Revisado</Selo>}
                  </div>
                  <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line">{s.resumo}</p>

                  {s.proximo_passo && (
                    <div className="rounded-lg px-4 py-3" style={{ background: hexComAlpha(AZUL_VIVO, 0.06) }}>
                      <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: AZUL_VIVO }}>Próximo passo</p>
                      <p className="text-sm font-semibold mt-0.5" style={{ color: AZUL }}>{s.proximo_passo}</p>
                      {s.proximo_passo_prazo && <p className="text-[11px] text-gray-500 mt-0.5">até {fmtData(s.proximo_passo_prazo)}</p>}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3 text-[12px]">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Destino</p>
                      <p className="text-gray-900 font-medium">{s.destino_mencionado ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Orçamento citado</p>
                      <p className="text-gray-900 font-medium">{s.orcamento_mencionado ? fmtBRL(s.orcamento_mencionado, 0) : "—"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Janela de viagem</p>
                      <p className="text-gray-900 font-medium">{s.janela_viagem ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Viajantes</p>
                      <p className="text-gray-900 font-medium">{s.pax_mencionado ?? "—"}</p>
                    </div>
                  </div>

                  {s.pontos_positivos.length > 0 && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "#027A48" }}>O que funcionou</p>
                      <ul className="space-y-1">
                        {s.pontos_positivos.map((p, i) => (
                          <li key={i} className="text-[13px] text-gray-700 flex gap-2"><span style={{ color: "#027A48" }}>✓</span>{p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {s.pontos_atencao.length > 0 && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "#B54708" }}>Pontos de atenção</p>
                      <ul className="space-y-1">
                        {s.pontos_atencao.map((p, i) => (
                          <li key={i} className="text-[13px] text-gray-700 flex gap-2"><span style={{ color: "#B54708" }}>!</span>{p}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2 pt-3" style={{ borderTop: "1px solid #F2F4F7" }}>
                    <div>
                      <p className="text-[18px] font-bold tabular-nums" style={{ color: s.talk_ratio_closer !== null && (s.talk_ratio_closer > 60 || s.talk_ratio_closer < 30) ? "#B54708" : AZUL }}>{fmtPct(s.talk_ratio_closer)}</p>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Fala do closer</p>
                      <p className="text-[10px] text-gray-400">ideal 40–50%</p>
                    </div>
                    <div>
                      <p className="text-[18px] font-bold tabular-nums" style={{ color: AZUL }}>{s.perguntas_closer ?? "—"}</p>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Perguntas</p>
                      <p className="text-[10px] text-gray-400">feitas pelo closer</p>
                    </div>
                    <div>
                      <p className="text-[18px] font-bold tabular-nums" style={{ color: s.monologo_max_seg !== null && s.monologo_max_seg > 90 ? "#B54708" : AZUL }}>{s.monologo_max_seg !== null ? fmtDuracao(s.monologo_max_seg) : "—"}</p>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Maior monólogo</p>
                      <p className="text-[10px] text-gray-400">do closer, sem pausa</p>
                    </div>
                  </div>
                </>
              )}
            </Cartao>
          </section>

          {/* Ações para o QS */}
          <section className="space-y-3">
            <TituloSecao sub="O que sair desta call vira trabalho no QS.">Levar para o QS</TituloSecao>
            <Cartao className="px-5 py-4 space-y-2">
              {!call.lead_id && (
                <p className="text-[12px] text-gray-500 mb-2">Esta call não está vinculada a um lead. Vincule pela extensão na próxima call para criar tarefa e nota.</p>
              )}
              <Botao onClick={() => setModalTarefa(true)} disabled={!call.lead_id}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
                Criar tarefa para o closer
              </Botao>
              <Botao variante="secundario" onClick={salvarNota} disabled={!call.lead_id || !s || salvando}>
                Salvar resumo na ficha do lead
              </Botao>
            </Cartao>
          </section>

          {/* Dados técnicos */}
          <section className="space-y-3">
            <TituloSecao>Sessão</TituloSecao>
            <Cartao className="px-5 py-4 text-[12px] space-y-1.5">
              <div className="flex justify-between gap-3"><span className="text-gray-400">Status</span><Selo cor={COR_STATUS_CALL[call.status]}>{CALL_STATUS_LABELS[call.status]}</Selo></div>
              <div className="flex justify-between gap-3"><span className="text-gray-400">Início</span><span className="text-gray-900 tabular-nums">{fmtDataHora(call.started_at)}</span></div>
              <div className="flex justify-between gap-3"><span className="text-gray-400">Fim</span><span className="text-gray-900 tabular-nums">{fmtDataHora(call.ended_at)}</span></div>
              <div className="flex justify-between gap-3"><span className="text-gray-400">STT <span className="text-gray-300">· transcrição de voz</span></span><span className="text-gray-900">{call.stt_provider} {call.stt_model ?? ""}</span></div>
              <div className="flex justify-between gap-3"><span className="text-gray-400">Custo STT</span><span className="text-gray-900 tabular-nums">{fmtBRL((call.stt_cost_usd ?? 0) * COTACAO_USD_BRL)}</span></div>
              <div className="flex justify-between gap-3"><span className="text-gray-400">Custo IA</span><span className="text-gray-900 tabular-nums">{fmtBRL((call.llm_cost_usd ?? 0) * COTACAO_USD_BRL)}</span></div>
              <div className="flex justify-between gap-3"><span className="text-gray-400">Áudio guardado</span><span className="text-gray-900">{call.recording_path ? "sim" : "não"}</span></div>
              {call.meeting && (
                <div className="flex justify-between gap-3"><span className="text-gray-400">Reunião no QS</span><span className="text-gray-900 tabular-nums">{fmtDataHora(call.meeting.scheduled_at)}</span></div>
              )}
            </Cartao>
          </section>
        </div>
      </div>

      {modalTarefa && (
        <Modal
          titulo="Criar tarefa"
          sub={`Para ${call.closer?.name ?? "o closer"} · lead ${nomeLead}`}
          aoFechar={() => setModalTarefa(false)}
          largura={520}
          rodape={
            <>
              <Botao variante="secundario" onClick={() => setModalTarefa(false)} disabled={salvando}>Cancelar</Botao>
              <Botao onClick={criarTarefa} disabled={salvando || !tNotas.trim()}>{salvando ? "Criando..." : "Criar tarefa"}</Botao>
            </>
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Campo label="Canal">
                <select value={tCanal} onChange={(e) => setTCanal(e.target.value as ChannelType)} className={CLASSE_INPUT}>
                  {(Object.keys(CHANNEL_LABELS) as ChannelType[]).map((c) => (
                    <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>
                  ))}
                </select>
              </Campo>
              <Campo label="Prioridade">
                <select value={tPrioridade} onChange={(e) => setTPrioridade(e.target.value as PriorityLevel)} className={CLASSE_INPUT}>
                  {(Object.keys(PRIORITY_LABELS) as PriorityLevel[]).map((p) => (
                    <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                  ))}
                </select>
              </Campo>
            </div>
            <Campo label="Quando">
              <input type="datetime-local" value={tQuando} onChange={(e) => setTQuando(e.target.value)} className={CLASSE_INPUT} />
            </Campo>
            <Campo label="O que fazer" dica="Pré-preenchido com o próximo passo sugerido pela IA. Ajuste se precisar.">
              <textarea rows={3} value={tNotas} onChange={(e) => setTNotas(e.target.value)} className={`${CLASSE_INPUT} resize-none`} />
            </Campo>
          </div>
        </Modal>
      )}
      <Toast toast={toast} />
    </Pagina>
  );
}
