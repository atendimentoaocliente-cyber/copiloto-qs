// src/components/sdr/copiloto/ui.tsx — Peças visuais compartilhadas do módulo Copiloto
//
// Regra do QS: Tailwind é pré-compilado (public/tailwind.css). Toda classe usada
// aqui foi conferida no CSS compilado. Cores da marca e qualquer valor que não
// exista no CSS vão em style={{}} inline.

import { useEffect, type CSSProperties, type ReactNode } from "react";
import { CopilotoError } from "@/lib/qs/copiloto";

// ── Paleta Inovvatur ─────────────────────────────────────────────────────────

export const AZUL = "#0D1B4B";
export const AZUL_VIVO = "#1A55FF";
export const AZUL_CLARO = "#2E6BFF";
export const GRADIENTE_HERO = `linear-gradient(120deg, ${AZUL} 0%, ${AZUL_VIVO} 60%, ${AZUL_CLARO} 100%)`;
export const FONTE: CSSProperties = { fontFamily: "system-ui, -apple-system, sans-serif" };
export const SOMBRA_CARD = "0 1px 3px rgba(0,0,0,0.04)";
export const BORDA_SUTIL = "1px solid rgba(16,24,40,0.06)";

/** Cor hex + alpha (para fundos de selos a partir da cor da categoria). */
export function hexComAlpha(hex: string, alpha: number): string {
  const limpo = hex.replace("#", "");
  const completo = limpo.length === 3 ? limpo.split("").map((c) => c + c).join("") : limpo;
  const n = parseInt(completo, 16);
  if (Number.isNaN(n)) return `rgba(100,116,139,${alpha})`;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export const COR_TEMPERATURA: Record<string, string> = {
  quente: "#B42318",
  morno: "#B54708",
  frio: "#175CD3",
};

export const COR_STATUS_CALL: Record<string, string> = {
  aguardando: "#667085",
  gravando: "#B42318",
  pausada: "#B54708",
  processando: "#175CD3",
  concluida: "#027A48",
  erro: "#B42318",
  descartada: "#98A2B3",
};

export const COR_OUTCOME: Record<string, string> = {
  pendente: "#667085",
  usada: "#027A48",
  ignorada: "#B54708",
  descartada: "#98A2B3",
  util: "#027A48",
  nao_util: "#B42318",
};

// ── Formatadores ─────────────────────────────────────────────────────────────

export function fmtData(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function fmtDataHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Segundos → "41 min" / "1h 12min". */
export function fmtDuracao(segundos: number | null | undefined): string {
  if (!segundos && segundos !== 0) return "—";
  const min = Math.round(segundos / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

/** Milissegundos desde o início da call → "13:58". */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Latência em ms → "1,3 s" ou "820 ms". */
export function fmtLatencia(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

export function fmtBRL(valor: number | null | undefined, casas = 2): string {
  if (valor === null || valor === undefined) return "—";
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: casas, maximumFractionDigits: casas });
}

export function fmtPct(valor: number | null | undefined, casas = 0): string {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return "—";
  return `${valor.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
}

export function fmtNumero(valor: number | null | undefined, casas = 0): string {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return "—";
  return valor.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

export function mensagemDoErro(erro: unknown): string {
  if (erro instanceof CopilotoError) return erro.message;
  if (erro instanceof Error) return erro.message;
  return "Falha inesperada ao falar com o banco.";
}

// ── Página / Hero ────────────────────────────────────────────────────────────

export function Pagina({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F8F9FA] px-6 py-6" style={FONTE}>
      <div className="mx-auto space-y-6" style={{ maxWidth: 1180 }}>{children}</div>
    </div>
  );
}

export interface KpiHero {
  valor: string;
  label: string;
  /** Explicação da sigla ou do cálculo. Ex.: "STT · transcrição de voz". */
  sub?: string;
}

export function Hero({
  titulo,
  subtitulo,
  kpis,
  acoes,
  aoVoltar,
  rotuloVoltar = "Voltar",
}: {
  titulo: ReactNode;
  subtitulo?: ReactNode;
  kpis?: KpiHero[];
  acoes?: ReactNode;
  aoVoltar?: () => void;
  rotuloVoltar?: string;
}) {
  return (
    <div className="rounded-2xl text-white overflow-hidden" style={{ background: GRADIENTE_HERO }}>
      <div className="px-6 py-5">
        {aoVoltar && (
          <button
            onClick={aoVoltar}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-white/80 hover:underline mb-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            {rotuloVoltar}
          </button>
        )}
        <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-white/20 text-white">
                Copiloto
              </span>
              <span className="text-[10px] text-white/60 font-medium">by Inovvatur</span>
            </div>
            <h1 className="text-[22px] font-bold leading-tight">{titulo}</h1>
            {subtitulo && <p className="text-[13px] text-white/80 mt-1">{subtitulo}</p>}
          </div>
          {acoes && <div className="flex items-center gap-2 shrink-0">{acoes}</div>}
        </div>
        {kpis && kpis.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
            {kpis.map((k, i) => (
              <div key={i} className="rounded-xl px-4 py-3 bg-white/10" style={{ border: "1px solid rgba(255,255,255,0.12)" }}>
                <div className="text-[24px] font-bold leading-none tabular-nums">{k.valor}</div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-white/80 mt-1.5">{k.label}</div>
                {k.sub && <div className="text-[11px] text-white/60 mt-0.5">{k.sub}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Cartões e selos ──────────────────────────────────────────────────────────

export function Cartao({
  children,
  className = "",
  style,
  onClick,
  titulo,
  sub,
  acoes,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  titulo?: ReactNode;
  sub?: ReactNode;
  acoes?: ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl ${onClick ? "cursor-pointer hover:shadow-md transition-shadow" : ""} ${className}`}
      style={{ border: BORDA_SUTIL, boxShadow: SOMBRA_CARD, ...style }}
    >
      {(titulo || acoes) && (
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3" style={{ borderBottom: "1px solid #F2F4F7" }}>
          <div className="min-w-0">
            {titulo && <h3 className="text-[13px] font-bold text-gray-900">{titulo}</h3>}
            {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
          </div>
          {acoes && <div className="flex items-center gap-2 shrink-0">{acoes}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** Indicador com sigla explicada: valor grande + rótulo + sublabel. */
export function Indicador({
  valor,
  label,
  sub,
  cor,
  alerta,
}: {
  valor: ReactNode;
  label: string;
  sub?: string;
  cor?: string;
  alerta?: string;
}) {
  return (
    <Cartao className="px-4 py-4">
      <div className="text-[26px] font-bold leading-none tabular-nums" style={{ color: cor ?? AZUL }}>{valor}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mt-2">{label}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
      {alerta && (
        <div className="text-[11px] font-medium mt-1.5" style={{ color: "#B54708" }}>{alerta}</div>
      )}
    </Cartao>
  );
}

export function Selo({
  children,
  cor = "#667085",
  solido = false,
  className = "",
}: {
  children: ReactNode;
  cor?: string;
  solido?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${className}`}
      style={solido ? { background: cor, color: "#fff" } : { background: hexComAlpha(cor, 0.12), color: cor }}
    >
      {children}
    </span>
  );
}

export function Chip({ children, aoRemover }: { children: ReactNode; aoRemover?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-gray-100 text-gray-700">
      {children}
      {aoRemover && (
        <button type="button" onClick={aoRemover} className="text-gray-400 hover:text-red-600" title="Remover">
          ×
        </button>
      )}
    </span>
  );
}

/** Barra horizontal proporcional (rankings). */
export function Barra({ valor, max, cor = AZUL_VIVO, altura = 8 }: { valor: number; max: number; cor?: string; altura?: number }) {
  const pct = max > 0 ? Math.min(100, (valor / max) * 100) : 0;
  return (
    <div className="w-full rounded-full overflow-hidden bg-gray-100" style={{ height: altura }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: cor }} />
    </div>
  );
}

// ── Estados ──────────────────────────────────────────────────────────────────

export function Carregando({ texto = "Carregando..." }: { texto?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <p className="text-sm text-gray-500">{texto}</p>
    </div>
  );
}

/**
 * Erro visível. Nada aqui é engolido: o usuário vê a mensagem e pode tentar de novo.
 */
export function ErroBanner({ erro, aoTentar, titulo = "Não foi possível carregar os dados" }: { erro: unknown; aoTentar?: () => void; titulo?: string }) {
  const detalhe = erro instanceof CopilotoError ? `${erro.operacao}: ${erro.detalhe}` : mensagemDoErro(erro);
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 flex items-start gap-3">
      <svg className="shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-red-700">{titulo}</p>
        <p className="text-[12px] text-red-600 mt-0.5 break-words font-mono">{detalhe}</p>
      </div>
      {aoTentar && (
        <button onClick={aoTentar} className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-red-700 border border-red-200 bg-white hover:bg-red-50 transition-colors">
          Tentar novamente
        </button>
      )}
    </div>
  );
}

export function Vazio({ titulo, texto, acao }: { titulo: string; texto?: ReactNode; acao?: ReactNode }) {
  return (
    <Cartao className="p-12 flex flex-col items-center justify-center text-center">
      <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3" style={{ background: hexComAlpha(AZUL_VIVO, 0.08) }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={AZUL_VIVO} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
        </svg>
      </div>
      <p className="text-sm font-semibold text-gray-900">{titulo}</p>
      {texto && <p className="text-[12px] text-gray-500 mt-1" style={{ maxWidth: 420 }}>{texto}</p>}
      {acao && <div className="mt-4">{acao}</div>}
    </Cartao>
  );
}

// ── Botões / campos ──────────────────────────────────────────────────────────

type Variante = "primario" | "secundario" | "perigo" | "fantasma";

export function Botao({
  children,
  variante = "primario",
  pequeno = false,
  disabled,
  onClick,
  title,
  type = "button",
}: {
  children: ReactNode;
  variante?: Variante;
  pequeno?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  type?: "button" | "submit";
}) {
  const base = `inline-flex items-center gap-2 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    pequeno ? "px-3 py-1.5 text-[12px]" : "px-4 py-2 text-sm"
  }`;
  const estilos: Record<Variante, { className: string; style: CSSProperties }> = {
    primario: { className: "text-white hover:opacity-90", style: { background: AZUL_VIVO } },
    secundario: { className: "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50", style: {} },
    perigo: { className: "border border-red-200 bg-white text-red-600 hover:bg-red-50", style: {} },
    fantasma: { className: "text-gray-600 hover:bg-gray-100", style: {} },
  };
  const e = estilos[variante];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${e.className}`} style={e.style}>
      {children}
    </button>
  );
}

export const CLASSE_INPUT =
  "w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#F97316]/20 focus:border-[#F97316]";

export const CLASSE_SELECT_PILL =
  "rounded-full px-3 py-1.5 text-xs border border-gray-200 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#F97316]/20";

export function Campo({ label, dica, children, erro }: { label: string; dica?: ReactNode; children: ReactNode; erro?: string }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-700 mb-1">{label}</label>
      {dica && <p className="text-[11px] text-gray-400 mb-1.5">{dica}</p>}
      {children}
      {erro && <p className="text-[11px] font-medium mt-1" style={{ color: "#B42318" }}>{erro}</p>}
    </div>
  );
}

/** Pílula de filtro (mesmo padrão dos filtros do LeadsPage, com o azul do módulo). */
export function Pilula({ ativa, onClick, children }: { ativa: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${ativa ? "text-white" : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}
      style={ativa ? { background: AZUL } : undefined}
    >
      {children}
    </button>
  );
}

export function Alternador({ ligado, onChange, disabled, rotulo }: { ligado: boolean; onChange: (v: boolean) => void; disabled?: boolean; rotulo?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={ligado}
      disabled={disabled}
      title={rotulo}
      onClick={() => onChange(!ligado)}
      className="relative inline-flex items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ width: 36, height: 20, background: ligado ? "#027A48" : "#D0D5DD" }}
    >
      <span
        className="absolute rounded-full bg-white transition-transform"
        style={{ width: 16, height: 16, top: 2, left: 2, transform: ligado ? "translateX(16px)" : "translateX(0)", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }}
      />
    </button>
  );
}

// ── Modal e toast ────────────────────────────────────────────────────────────

export function Modal({
  titulo,
  sub,
  aoFechar,
  children,
  rodape,
  largura = 640,
}: {
  titulo: string;
  sub?: ReactNode;
  aoFechar: () => void;
  children: ReactNode;
  rodape?: ReactNode;
  largura?: number;
}) {
  useEffect(() => {
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") aoFechar();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [aoFechar]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={FONTE}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={aoFechar} />
      <div
        className="relative bg-white rounded-xl border border-gray-100 shadow-xl w-full mx-4 flex flex-col max-h-[90vh]"
        style={{ maxWidth: largura }}
      >
        <div className="flex items-start justify-between px-6 pt-5 pb-4" style={{ borderBottom: "1px solid #F2F4F7" }}>
          <div>
            <h2 className="text-lg font-bold text-gray-900">{titulo}</h2>
            {sub && <p className="text-[12px] text-gray-500 mt-0.5">{sub}</p>}
          </div>
          <button onClick={aoFechar} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors" title="Fechar">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
        {rodape && (
          <div className="px-6 py-4 flex items-center justify-end gap-2" style={{ borderTop: "1px solid #F2F4F7" }}>{rodape}</div>
        )}
      </div>
    </div>
  );
}

export interface ToastEstado {
  mensagem: string;
  tipo?: "sucesso" | "erro";
}

export function Toast({ toast }: { toast: ToastEstado | null }) {
  if (!toast) return null;
  return (
    <div
      className="fixed bottom-6 right-6 z-[100] flex items-center gap-3 px-5 py-3.5 rounded-xl text-white shadow-lg"
      style={{ background: toast.tipo === "erro" ? "#B42318" : "#101828", ...FONTE }}
    >
      <span className="text-sm font-semibold">{toast.mensagem}</span>
    </div>
  );
}

/** Cabeçalho de seção dentro da página. */
export function TituloSecao({ children, sub, acoes }: { children: ReactNode; sub?: ReactNode; acoes?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{children}</h2>
        {sub && <p className="text-[12px] text-gray-400 mt-0.5">{sub}</p>}
      </div>
      {acoes}
    </div>
  );
}
