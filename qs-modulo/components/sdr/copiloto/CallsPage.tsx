// src/components/sdr/copiloto/CallsPage.tsx — Histórico de calls do Copiloto
//
// KPIs do período, filtros por closer / período / temperatura / status e cards com
// resumo. Closer vê só as próprias calls (canSeeAllData); gestor e admin veem tudo.

import { useState, useEffect, useCallback, useMemo } from "react";
import { useQsAuth, canSeeAllData } from "@/contexts/QsAuthContext";
import { fetchCopilotCalls, fetchClosers, periodoDias, COTACAO_USD_BRL } from "@/lib/qs/copiloto";
import type { CopilotCallSession, CopilotCallStatus, CopilotTemperatura } from "./types";
import { CALL_STATUS_LABELS, TEMPERATURA_LABELS, PLATFORM_LABELS } from "./types";
import {
  Pagina,
  Hero,
  Cartao,
  Selo,
  Carregando,
  ErroBanner,
  Vazio,
  Pilula,
  CLASSE_INPUT,
  CLASSE_SELECT_PILL,
  COR_TEMPERATURA,
  COR_STATUS_CALL,
  fmtDataHora,
  fmtDuracao,
  fmtBRL,
  fmtPct,
  fmtNumero,
} from "./ui";

interface CallsPageProps {
  onOpenCall: (callId: string) => void;
  onOpenLead?: (leadId: string) => void;
}

const PERIODOS: { dias: number; label: string }[] = [
  { dias: 7, label: "7 dias" },
  { dias: 30, label: "30 dias" },
  { dias: 90, label: "90 dias" },
  { dias: 0, label: "Tudo" },
];

function rotuloDoDia(iso: string): string {
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);
  const mesmoDia = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (mesmoDia(d, hoje)) return "Hoje";
  if (mesmoDia(d, ontem)) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
}

function DesfechoLead({ call }: { call: CopilotCallSession }) {
  const lead = call.lead;
  if (!lead) return null;
  if (lead.status === "ganho") {
    return <Selo cor="#027A48">Ganho {lead.closed_value ? `· ${fmtBRL(lead.closed_value, 0)}` : ""}</Selo>;
  }
  if (lead.status === "perdido") return <Selo cor="#B42318">Perdido</Selo>;
  return <Selo cor="#667085">Em aberto</Selo>;
}

export default function CallsPage({ onOpenCall, onOpenLead }: CallsPageProps) {
  const { currentUser } = useQsAuth();
  const veTudo = currentUser ? canSeeAllData(currentUser.role) : false;

  const [calls, setCalls] = useState<CopilotCallSession[]>([]);
  const [closers, setClosers] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<unknown>(null);

  const [busca, setBusca] = useState("");
  const [dias, setDias] = useState(30);
  const [filtroCloser, setFiltroCloser] = useState<string>(veTudo ? "" : (currentUser?.id ?? ""));
  const [filtroTemperatura, setFiltroTemperatura] = useState<CopilotTemperatura | "">("");
  const [filtroStatus, setFiltroStatus] = useState<CopilotCallStatus | "">("");

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const periodo = dias > 0 ? periodoDias(dias) : undefined;
      const [lista, users] = await Promise.all([
        fetchCopilotCalls({
          closer_id: veTudo ? filtroCloser || undefined : currentUser?.id,
          inicio: periodo?.inicio,
          fim: periodo?.fim,
          temperatura: filtroTemperatura || undefined,
          status: filtroStatus || undefined,
        }),
        veTudo ? fetchClosers() : Promise.resolve([]),
      ]);
      setCalls(lista);
      if (veTudo) setClosers(users);
    } catch (e) {
      setErro(e);
    } finally {
      setLoading(false);
    }
  }, [dias, filtroCloser, filtroTemperatura, filtroStatus, veTudo, currentUser?.id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Busca textual no cliente (lead, empresa, closer, resumo, destino)
  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return calls;
    return calls.filter((c) =>
      [c.lead?.full_name, c.lead?.company_name, c.closer?.name, c.titulo, c.summary?.resumo, c.summary?.destino_mencionado, c.summary?.proximo_passo]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [calls, busca]);

  // KPIs do conjunto carregado
  const kpis = useMemo(() => {
    const total = filtradas.length;
    const minutos = filtradas.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / 60;
    const deteccoes = filtradas.reduce((s, c) => s + (c._deteccoes ?? 0), 0);
    const usadas = filtradas.reduce((s, c) => s + (c._usadas ?? 0), 0);
    const custoBrl = filtradas.reduce((s, c) => s + ((c.stt_cost_usd ?? 0) + (c.llm_cost_usd ?? 0)), 0) * COTACAO_USD_BRL;
    const decididas = filtradas.filter((c) => c.lead?.status === "ganho" || c.lead?.status === "perdido");
    const ganhas = decididas.filter((c) => c.lead?.status === "ganho").length;
    return {
      total,
      minutos: Math.round(minutos),
      objecoesPorCall: total > 0 ? deteccoes / total : 0,
      taxaUso: deteccoes > 0 ? (usadas / deteccoes) * 100 : null,
      custoBrl,
      fechamento: decididas.length > 0 ? (ganhas / decididas.length) * 100 : null,
    };
  }, [filtradas]);

  // Agrupa por dia
  const grupos = useMemo(() => {
    const mapa = new Map<string, CopilotCallSession[]>();
    for (const c of filtradas) {
      const chave = rotuloDoDia(c.started_at ?? c.created_at);
      const arr = mapa.get(chave) ?? [];
      arr.push(c);
      mapa.set(chave, arr);
    }
    return [...mapa.entries()];
  }, [filtradas]);

  return (
    <Pagina>
      <Hero
        titulo="Calls do Copiloto"
        subtitulo="Transcrição, objeções detectadas e o que o closer fez com cada sugestão."
        kpis={[
          { valor: String(kpis.total), label: "Calls", sub: `${kpis.minutos} min gravados` },
          { valor: fmtNumero(kpis.objecoesPorCall, 1), label: "Objeções por call", sub: "detectadas ao vivo" },
          { valor: fmtPct(kpis.taxaUso), label: "Uso da sugestão", sub: "usadas ÷ detectadas" },
          { valor: fmtPct(kpis.fechamento), label: "Fechamento", sub: `ganhas ÷ decididas · custo ${fmtBRL(kpis.custoBrl)}` },
        ]}
      />

      {/* Busca e filtros */}
      <div className="space-y-3">
        <div className="relative">
          <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por lead, empresa, closer, destino ou trecho do resumo..."
            className={`${CLASSE_INPUT} pl-10`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PERIODOS.map((p) => (
            <Pilula key={p.dias} ativa={dias === p.dias} onClick={() => setDias(p.dias)}>{p.label}</Pilula>
          ))}
          <span className="w-px h-5 bg-gray-200" />
          {(Object.keys(TEMPERATURA_LABELS) as CopilotTemperatura[]).map((t) => (
            <button
              key={t}
              onClick={() => setFiltroTemperatura(filtroTemperatura === t ? "" : t)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${filtroTemperatura === t ? "text-white" : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}
              style={filtroTemperatura === t ? { background: COR_TEMPERATURA[t] } : undefined}
            >
              {TEMPERATURA_LABELS[t]}
            </button>
          ))}
          <span className="w-px h-5 bg-gray-200" />
          {veTudo && (
            <select value={filtroCloser} onChange={(e) => setFiltroCloser(e.target.value)} className={CLASSE_SELECT_PILL}>
              <option value="">Todos os closers</option>
              {closers.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          )}
          <select value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value as CopilotCallStatus | "")} className={CLASSE_SELECT_PILL}>
            <option value="">Status</option>
            {(Object.keys(CALL_STATUS_LABELS) as CopilotCallStatus[]).filter((s) => s !== "descartada").map((s) => (
              <option key={s} value={s}>{CALL_STATUS_LABELS[s]}</option>
            ))}
          </select>
          {(filtroTemperatura || filtroStatus || (veTudo && filtroCloser) || busca) && (
            <button
              onClick={() => { setFiltroTemperatura(""); setFiltroStatus(""); if (veTudo) setFiltroCloser(""); setBusca(""); }}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 bg-white hover:bg-red-50 transition-colors"
            >
              Limpar filtros
            </button>
          )}
          <span className="ml-auto text-[12px] text-gray-400">{filtradas.length} {filtradas.length === 1 ? "call" : "calls"}</span>
        </div>
      </div>

      {erro && <ErroBanner erro={erro} aoTentar={carregar} />}
      {loading && <Carregando texto="Carregando calls..." />}

      {!loading && !erro && filtradas.length === 0 && (
        <Vazio
          titulo="Nenhuma call neste recorte"
          texto={
            calls.length === 0
              ? "Quando o closer abrir o Meet com a extensão pareada e iniciar o Copiloto, a call aparece aqui com transcrição, objeções e resumo."
              : "Ajuste os filtros ou a busca."
          }
        />
      )}

      {!loading &&
        grupos.map(([dia, lista]) => (
          <section key={dia} className="space-y-2">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500 capitalize">{dia}</h2>
            {lista.map((c) => {
              const s = c.summary;
              const nomeLead = c.lead?.full_name ?? c.titulo ?? "Lead não vinculado";
              return (
                <Cartao key={c.id} onClick={() => onOpenCall(c.id)} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-[15px] font-bold text-gray-900 truncate">{nomeLead}</h3>
                        {s?.destino_mencionado && <span className="text-[13px] text-gray-500">· {s.destino_mencionado}</span>}
                        {c.status === "gravando" && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#B42318" }}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#B42318" }} /> ao vivo
                          </span>
                        )}
                      </div>
                      <p className="text-[12px] text-gray-500 mt-0.5">
                        {c.closer?.name ?? "Closer"} · {fmtDataHora(c.started_at ?? c.created_at)} · {fmtDuracao(c.duration_seconds)} · {PLATFORM_LABELS[c.platform]}
                        {c.lead?.company_name ? ` · ${c.lead.company_name}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                      {s && <Selo cor={COR_TEMPERATURA[s.temperatura]}>{TEMPERATURA_LABELS[s.temperatura]}</Selo>}
                      <DesfechoLead call={c} />
                      {c.status !== "concluida" && <Selo cor={COR_STATUS_CALL[c.status]}>{CALL_STATUS_LABELS[c.status]}</Selo>}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 mt-2 text-[12px] text-gray-500">
                    <span className="tabular-nums"><strong className="text-gray-900">{c._deteccoes ?? 0}</strong> objeções</span>
                    <span className="tabular-nums">usou <strong className="text-gray-900">{c._usadas ?? 0}</strong></span>
                    {s?.talk_ratio_closer !== null && s?.talk_ratio_closer !== undefined && (
                      <span className="tabular-nums">closer falou <strong className="text-gray-900">{fmtPct(s.talk_ratio_closer)}</strong></span>
                    )}
                    <span className="tabular-nums">{fmtBRL(((c.stt_cost_usd ?? 0) + (c.llm_cost_usd ?? 0)) * COTACAO_USD_BRL)}</span>
                    {c.lead_id && onOpenLead && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenLead(c.lead_id!); }}
                        className="ml-auto text-[#0147FF] hover:underline font-medium"
                      >
                        Abrir lead
                      </button>
                    )}
                  </div>

                  {s?.resumo ? (
                    <div className="mt-3 pt-3 text-[13px] text-gray-700" style={{ borderTop: "1px solid #F2F4F7" }}>
                      <p className="line-clamp-2">{s.resumo}</p>
                      {s.proximo_passo && (
                        <p className="text-[12px] mt-1.5">
                          <span className="font-bold uppercase tracking-wider text-[10px] text-gray-400 mr-1">Próximo passo</span>
                          <span className="text-gray-900 font-medium">{s.proximo_passo}</span>
                        </p>
                      )}
                    </div>
                  ) : (
                    c.status === "concluida" && (
                      <p className="mt-3 pt-3 text-[12px] text-gray-400" style={{ borderTop: "1px solid #F2F4F7" }}>
                        Sem resumo — a IA não gerou (ou ainda está processando).
                      </p>
                    )
                  )}
                  {c.status === "erro" && c.error_message && (
                    <p className="mt-3 pt-3 text-[12px] font-mono" style={{ borderTop: "1px solid #F2F4F7", color: "#B42318" }}>{c.error_message}</p>
                  )}
                </Cartao>
              );
            })}
          </section>
        ))}
    </Pagina>
  );
}
