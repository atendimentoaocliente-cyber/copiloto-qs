// src/components/sdr/copiloto/AnalyticsPage.tsx — Desempenho do Copiloto
//
// Objeções mais frequentes, ranking por closer, taxa de uso da sugestão, objeções
// que mais aparecem em leads perdidos (view que cruza qs_loss_reasons) e custo
// do período. Visível para gestor e admin — o closer não vê ranking entre pares.

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchKpisPeriodo,
  fetchObjecoesPorPeriodo,
  fetchRankingClosers,
  fetchObjecoesMatadoras,
  fetchCustoPeriodo,
  fetchClosers,
  periodoDias,
  COTACAO_USD_BRL,
  type CopilotKpisPeriodo,
} from "@/lib/qs/copiloto";
import type { CopilotObjecaoPeriodo, CopilotRankingCloser, CopilotObjecaoMatadora, CopilotCustoPeriodo } from "./types";
import {
  Pagina,
  Hero,
  Cartao,
  Selo,
  Barra,
  Carregando,
  ErroBanner,
  Vazio,
  Pilula,
  CLASSE_SELECT_PILL,
  AZUL,
  AZUL_VIVO,
  fmtLatencia,
  fmtBRL,
  fmtPct,
  fmtNumero,
} from "./ui";

interface AnalyticsPageProps {
  onOpenPlaybook?: () => void;
}

const PERIODOS = [
  { dias: 7, label: "7 dias" },
  { dias: 30, label: "30 dias" },
  { dias: 90, label: "90 dias" },
];

const CORES_CATEGORIA: Record<string, string> = {
  preco: "#DC2626",
  timing: "#EA580C",
  autoridade: "#CA8A04",
  confianca: "#2563EB",
  concorrente: "#7C3AED",
  escopo: "#0D9488",
  pagamento: "#DB2777",
  outro: "#64748B",
};

function Th({ children, direita = false }: { children: React.ReactNode; direita?: boolean }) {
  return <th className={`${direita ? "text-right" : "text-left"} px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap`}>{children}</th>;
}

function Td({ children, direita = false, className = "" }: { children: React.ReactNode; direita?: boolean; className?: string }) {
  return <td className={`px-4 py-3 text-sm ${direita ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>;
}

export default function AnalyticsPage({ onOpenPlaybook }: AnalyticsPageProps) {
  const [dias, setDias] = useState(30);
  const [closerId, setCloserId] = useState("");
  const [closers, setClosers] = useState<Array<{ id: string; name: string }>>([]);

  const [kpis, setKpis] = useState<CopilotKpisPeriodo | null>(null);
  const [objecoes, setObjecoes] = useState<CopilotObjecaoPeriodo[]>([]);
  const [ranking, setRanking] = useState<CopilotRankingCloser[]>([]);
  const [matadoras, setMatadoras] = useState<CopilotObjecaoMatadora[]>([]);
  const [custo, setCusto] = useState<CopilotCustoPeriodo | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<unknown>(null);
  const [erroMatadoras, setErroMatadoras] = useState<unknown>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    setErroMatadoras(null);
    const periodo = periodoDias(dias);
    const closer = closerId || undefined;
    try {
      const [k, o, r, c, u] = await Promise.all([
        fetchKpisPeriodo(periodo, closer),
        fetchObjecoesPorPeriodo(periodo, closer, 60),
        fetchRankingClosers(periodo),
        fetchCustoPeriodo(periodo, closer),
        fetchClosers(),
      ]);
      setKpis(k);
      setObjecoes(o);
      setRanking(r);
      setCusto(c);
      setClosers(u);
    } catch (e) {
      setErro(e);
    } finally {
      setLoading(false);
    }
    // A view de objeções matadoras é histórica (não filtra por período) e pode falhar
    // sozinha sem derrubar o resto — mas o erro aparece na seção dela.
    try {
      setMatadoras(await fetchObjecoesMatadoras(10));
    } catch (e) {
      setErroMatadoras(e);
    }
  }, [dias, closerId]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // ── Agregações derivadas ──
  const porCategoria = useMemo(() => {
    const mapa = new Map<string, { id: string; label: string; deteccoes: number; usadas: number; exibidas: number }>();
    for (const o of objecoes) {
      const id = o.category_id ?? "outro";
      const atual = mapa.get(id) ?? { id, label: o.categoria ?? "Outra", deteccoes: 0, usadas: 0, exibidas: 0 };
      atual.deteccoes += o.deteccoes;
      atual.usadas += o.sugestoes_usadas;
      atual.exibidas += o.sugestoes_exibidas;
      mapa.set(id, atual);
    }
    return [...mapa.values()].sort((a, b) => b.deteccoes - a.deteccoes);
  }, [objecoes]);

  const topObjecoes = useMemo(() => objecoes.filter((o) => o.objection_id).slice(0, 8), [objecoes]);

  const queMaisFalham = useMemo(
    () =>
      objecoes
        .filter((o) => o.objection_id && o.sugestoes_exibidas >= 5 && o.taxa_uso_pct !== null)
        .sort((a, b) => (a.taxa_uso_pct ?? 0) - (b.taxa_uso_pct ?? 0))
        .slice(0, 6),
    [objecoes]
  );

  const semResposta = useMemo(() => objecoes.filter((o) => !o.objection_id).sort((a, b) => b.deteccoes - a.deteccoes).slice(0, 6), [objecoes]);

  const maxCategoria = porCategoria[0]?.deteccoes ?? 0;
  const maxObjecao = topObjecoes[0]?.deteccoes ?? 0;

  return (
    <Pagina>
      <Hero
        titulo="Desempenho do Copiloto"
        subtitulo="O que os leads mais dizem, o que os closers fazem com a sugestão e o que isso custa."
        kpis={
          kpis
            ? [
                { valor: String(kpis.calls), label: "Calls", sub: `${kpis.minutos} min · ${fmtNumero(kpis.objecoes_por_call, 1)} objeções/call` },
                { valor: String(kpis.objecoes), label: "Objeções detectadas", sub: `latência mediana ${fmtLatencia(kpis.latencia_p50_ms)}` },
                { valor: fmtPct(kpis.taxa_uso_pct), label: "Uso da sugestão", sub: "usadas ÷ exibidas na tela" },
                { valor: fmtPct(kpis.fechamento_pct), label: "Fechamento", sub: "leads ganhos ÷ decididos" },
              ]
            : undefined
        }
        acoes={
          <div className="flex items-center gap-1.5 flex-wrap">
            {PERIODOS.map((p) => (
              <button
                key={p.dias}
                onClick={() => setDias(p.dias)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${dias === p.dias ? "bg-white" : "bg-white/20 text-white hover:bg-white/30"}`}
                style={dias === p.dias ? { color: AZUL } : undefined}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Pilula ativa={!closerId} onClick={() => setCloserId("")}>Time inteiro</Pilula>
        <select value={closerId} onChange={(e) => setCloserId(e.target.value)} className={CLASSE_SELECT_PILL}>
          <option value="">Filtrar por closer</option>
          {closers.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <span className="ml-auto text-[11px] text-gray-400">Custos convertidos a R$ {COTACAO_USD_BRL.toFixed(2)}/US$</span>
      </div>

      {erro && <ErroBanner erro={erro} aoTentar={carregar} />}
      {loading && <Carregando texto="Calculando indicadores..." />}

      {!loading && !erro && kpis && kpis.calls === 0 && (
        <Vazio titulo="Sem calls no período" texto="Os indicadores aparecem assim que houver calls com o Copiloto ligado. Troque o período ou remova o filtro de closer." />
      )}

      {!loading && !erro && kpis && kpis.calls > 0 && (
        <>
          {/* Linha 1: frequência + custo */}
          <div className="grid lg:grid-cols-2 gap-6">
            <Cartao titulo="Objeções mais frequentes" sub="Por categoria, no período. A barra é o volume; o número à direita, quantas vezes a sugestão foi usada.">
              <div className="px-5 py-4 space-y-3">
                {porCategoria.length === 0 && <p className="text-[13px] text-gray-500">Nenhuma detecção no período.</p>}
                {porCategoria.map((c) => (
                  <div key={c.id} className="flex items-center gap-3">
                    <div className="w-32 shrink-0 flex items-center gap-2 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CORES_CATEGORIA[c.id] ?? "#64748B" }} />
                      <span className="text-[13px] text-gray-800 truncate">{c.label}</span>
                    </div>
                    <div className="flex-1"><Barra valor={c.deteccoes} max={maxCategoria} cor={CORES_CATEGORIA[c.id] ?? AZUL_VIVO} altura={18} /></div>
                    <div className="w-24 shrink-0 text-right">
                      <span className="text-[14px] font-bold tabular-nums text-gray-900">{c.deteccoes}</span>
                      <span className="text-[11px] text-gray-400 tabular-nums ml-1">· {c.exibidas > 0 ? fmtPct((c.usadas / c.exibidas) * 100) : "—"} uso</span>
                    </div>
                  </div>
                ))}
              </div>
              {topObjecoes.length > 0 && (
                <div className="px-5 py-4" style={{ borderTop: "1px solid #F2F4F7" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-3">Top objeções do playbook</p>
                  <div className="space-y-2">
                    {topObjecoes.map((o) => (
                      <div key={o.objection_id} className="flex items-center gap-3">
                        <span className="text-[13px] text-gray-800 truncate flex-1">{o.titulo}</span>
                        <div className="w-32 shrink-0"><Barra valor={o.deteccoes} max={maxObjecao} /></div>
                        <span className="w-8 text-right text-[13px] font-bold tabular-nums text-gray-900">{o.deteccoes}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Cartao>

            <Cartao titulo="Custo do período" sub="STT (transcrição de voz, Deepgram) + IA (detecção semântica e resumo). Meta: até R$ 5 por call.">
              {custo && (
                <div className="px-5 py-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <p className="text-[26px] font-bold tabular-nums leading-none" style={{ color: AZUL }}>{fmtBRL(custo.total_brl)}</p>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mt-2">Total</p>
                      <p className="text-[11px] text-gray-400">US$ {custo.total_usd.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-[26px] font-bold tabular-nums leading-none" style={{ color: custo.media_por_call_brl > 5 ? "#B54708" : AZUL }}>{fmtBRL(custo.media_por_call_brl)}</p>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mt-2">Por call</p>
                      <p className="text-[11px] text-gray-400">{custo.media_por_call_brl > 5 ? "acima da meta de R$ 5" : "dentro da meta"}</p>
                    </div>
                    <div>
                      <p className="text-[26px] font-bold tabular-nums leading-none" style={{ color: AZUL }}>{fmtBRL(custo.custo_por_minuto_brl)}</p>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mt-2">Por minuto</p>
                      <p className="text-[11px] text-gray-400">{custo.minutos} min em {custo.calls} calls</p>
                    </div>
                  </div>
                  <div className="mt-5 space-y-2">
                    <div className="flex items-center gap-3">
                      <span className="w-32 text-[12px] text-gray-600 shrink-0">STT · transcrição</span>
                      <div className="flex-1"><Barra valor={custo.stt_usd} max={custo.total_usd || 1} cor="#175CD3" altura={14} /></div>
                      <span className="w-24 text-right text-[12px] tabular-nums text-gray-900">{fmtBRL(custo.stt_usd * COTACAO_USD_BRL)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="w-32 text-[12px] text-gray-600 shrink-0">IA · sugestão + resumo</span>
                      <div className="flex-1"><Barra valor={custo.llm_usd} max={custo.total_usd || 1} cor="#7C3AED" altura={14} /></div>
                      <span className="w-24 text-right text-[12px] tabular-nums text-gray-900">{fmtBRL(custo.llm_usd * COTACAO_USD_BRL)}</span>
                    </div>
                  </div>
                  {custo.llm_usd === 0 && custo.calls > 0 && (
                    <p className="text-[11px] mt-3" style={{ color: "#B54708" }}>Custo de IA zerado: a camada generativa está desligada (sem ANTHROPIC_API_KEY no gateway) ou nenhuma call precisou dela.</p>
                  )}
                </div>
              )}
            </Cartao>
          </div>

          {/* Ranking por closer */}
          <Cartao
            titulo="Ranking por closer"
            sub="Latência alta + uso baixo é o closer que ainda não confia na tela. Latência alta + uso alto é quem está lendo em voz alta. Os dois pedem treino, mas treinos diferentes."
          >
            {ranking.length === 0 ? (
              <p className="px-5 py-6 text-[13px] text-gray-500">Sem calls no período.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: "1px solid #F2F4F7" }}>
                      <Th>Closer</Th>
                      <Th direita>Calls</Th>
                      <Th direita>Obj./call</Th>
                      <Th direita>Uso da sugestão</Th>
                      <Th direita>Latência p50</Th>
                      <Th direita>Fechamento</Th>
                      <Th direita>Custo</Th>
                      <Th>Leitura</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.map((r, i) => {
                      const lento = r.latencia_p50_ms !== null && r.latencia_p50_ms > 6000;
                      const usoBaixo = r.taxa_uso_pct !== null && r.taxa_uso_pct < 50 && r.exibidas >= 10;
                      const leitura = lento && !usoBaixo ? "Lê a tela em voz alta — treino cego" : lento && usoBaixo ? "Ignora e demora — revisar playbook com ele" : usoBaixo ? "Não usa a sugestão — checar confiança nas respostas" : r.taxa_uso_pct !== null && r.taxa_uso_pct >= 75 ? "Rampado" : "—";
                      return (
                        <tr key={r.closer_id} className={`hover:bg-gray-50/40 transition-colors ${i === ranking.length - 1 ? "" : ""}`} style={{ borderBottom: "1px solid #F2F4F7" }}>
                          <Td className="font-medium text-gray-900 whitespace-nowrap">
                            <span className="inline-flex items-center gap-2">
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold text-white" style={{ background: i === 0 ? AZUL_VIVO : "#98A2B3" }}>{i + 1}</span>
                              {r.closer}
                            </span>
                          </Td>
                          <Td direita>{r.calls}</Td>
                          <Td direita>{fmtNumero(r.objecoes_por_call, 1)}</Td>
                          <Td direita className={usoBaixo ? "font-semibold" : ""}>
                            <span style={usoBaixo ? { color: "#B54708" } : undefined}>{fmtPct(r.taxa_uso_pct)}</span>
                            <span className="text-[11px] text-gray-400 ml-1">({r.usadas}/{r.exibidas})</span>
                          </Td>
                          <Td direita><span style={lento ? { color: "#B54708", fontWeight: 600 } : undefined}>{fmtLatencia(r.latencia_p50_ms)}</span></Td>
                          <Td direita>
                            {fmtPct(r.fechamento_pct)}
                            <span className="text-[11px] text-gray-400 ml-1">({r.calls_ganhas}/{r.calls_ganhas + r.calls_perdidas})</span>
                          </Td>
                          <Td direita>{fmtBRL(r.custo_brl)}</Td>
                          <Td className="text-[12px] text-gray-500">{leitura}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Cartao>

          {/* Linha 3: falhas + perdidos */}
          <div className="grid lg:grid-cols-2 gap-6">
            <Cartao
              titulo="Sugestões que mais falham"
              sub="Exibidas pelo menos 5 vezes e pouco usadas. Cada linha é uma resposta para reescrever no playbook."
              acoes={onOpenPlaybook ? <button onClick={onOpenPlaybook} className="text-[12px] font-semibold hover:underline" style={{ color: AZUL_VIVO }}>Abrir playbook</button> : undefined}
            >
              <div className="divide-y">
                {queMaisFalham.length === 0 && <p className="px-5 py-6 text-[13px] text-gray-500">Ainda sem amostra suficiente (mínimo de 5 exibições por objeção).</p>}
                {queMaisFalham.map((o) => (
                  <div key={o.objection_id} className="px-5 py-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-gray-900 truncate">{o.titulo}</p>
                      <p className="text-[11px] text-gray-400">{o.categoria} · {o.sugestoes_exibidas} exibições · latência p95 {fmtLatencia(o.latencia_p95_ms)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[15px] font-bold tabular-nums" style={{ color: "#B42318" }}>{fmtPct(100 - (o.taxa_uso_pct ?? 0))}</p>
                      <p className="text-[10px] text-gray-400 uppercase tracking-wider">dispensada</p>
                    </div>
                  </div>
                ))}
              </div>
              {semResposta.length > 0 && (
                <div className="px-5 py-4" style={{ borderTop: "1px solid #F2F4F7" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: "#B54708" }}>Lacunas · detectadas sem objeção no playbook</p>
                  <div className="space-y-1.5">
                    {semResposta.map((o, i) => (
                      <div key={`${o.category_id}-${i}`} className="flex items-center justify-between gap-3 text-[12px]">
                        <span className="text-gray-700">{o.categoria ?? "Sem categoria"}</span>
                        <span className="font-bold tabular-nums text-gray-900">{o.deteccoes}×</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Cartao>

            <Cartao
              titulo="Objeções que mais matam venda"
              sub="Cruzamento com o desfecho do lead e o motivo de perda registrado no QS. Histórico completo, mínimo de 3 calls por objeção."
            >
              {erroMatadoras && <div className="p-4"><ErroBanner erro={erroMatadoras} aoTentar={carregar} titulo="Não foi possível cruzar com os motivos de perda" /></div>}
              {!erroMatadoras && matadoras.length === 0 && (
                <p className="px-5 py-6 text-[13px] text-gray-500">Ainda não há 3 calls com desfecho (ganho/perdido) para a mesma objeção.</p>
              )}
              {matadoras.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: "1px solid #F2F4F7" }}>
                        <Th>Objeção</Th>
                        <Th direita>Calls</Th>
                        <Th direita>Perda</Th>
                        <Th>Motivo de perda no QS</Th>
                        <Th direita>Receita perdida</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {matadoras.map((m, i) => (
                        <tr key={`${m.objection_id ?? m.category_id}-${i}`} style={{ borderBottom: "1px solid #F2F4F7" }}>
                          <Td>
                            <p className="font-medium text-gray-900 truncate" style={{ maxWidth: 220 }}>{m.objecao}</p>
                            <p className="text-[11px] text-gray-400">{m.categoria}</p>
                          </Td>
                          <Td direita>{m.calls_com_objecao}</Td>
                          <Td direita>
                            <Selo cor={(m.taxa_perda_pct ?? 0) >= 50 ? "#B42318" : (m.taxa_perda_pct ?? 0) >= 30 ? "#B54708" : "#027A48"}>{fmtPct(m.taxa_perda_pct)}</Selo>
                            <p className="text-[11px] text-gray-400 mt-0.5">{m.calls_perdidas} de {m.calls_com_objecao}</p>
                          </Td>
                          <Td className="text-[12px] text-gray-600">{m.motivo_perda_predominante ?? "—"}</Td>
                          <Td direita className="text-gray-900">{fmtBRL(m.receita_perdida_estimada, 0)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Cartao>
          </div>
        </>
      )}
    </Pagina>
  );
}
