/**
 * Métricas Prometheus + reservatório para p50/p95/p99 em JSON.
 *
 * Etapas do pipeline (nomes estáveis — o Grafana depende deles):
 *   stt_primeira_palavra · stt_turno_final · l0_gatilho · l1_embedding ·
 *   l1_busca · l2_classificacao · l3_geracao · resumo_pos_call · e2e_sugestao
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export type Etapa =
  | "stt_primeira_palavra"
  | "stt_turno_final"
  | "l0_gatilho"
  | "l1_embedding"
  | "l1_busca"
  | "l2_classificacao"
  | "l3_geracao"
  | "resumo_pos_call"
  | "e2e_sugestao"
  | "persistencia";

const BUCKETS_MS = [5, 10, 25, 50, 100, 200, 400, 700, 1000, 1500, 2000, 3000, 5000, 10000];

class Reservatorio {
  private readonly amostras: number[] = [];
  constructor(private readonly max = 2000) {}
  add(v: number): void {
    this.amostras.push(v);
    if (this.amostras.length > this.max) this.amostras.shift();
  }
  quantis(): { n: number; p50: number | null; p95: number | null; p99: number | null } {
    const n = this.amostras.length;
    if (!n) return { n: 0, p50: null, p95: null, p99: null };
    const ord = [...this.amostras].sort((a, b) => a - b);
    const q = (p: number) => ord[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]!;
    return { n, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
  }
}

export class Metricas {
  readonly registro = new Registry();
  private readonly reservatorios = new Map<Etapa, Reservatorio>();

  readonly latencia = new Histogram({
    name: "copilot_etapa_latencia_ms",
    help: "Latência por etapa do pipeline (ms)",
    labelNames: ["etapa"] as const,
    buckets: BUCKETS_MS,
    registers: [this.registro],
  });
  readonly sessoesAtivas = new Gauge({ name: "copilot_active_sessions", help: "Sessões de call ativas nesta instância", registers: [this.registro] });
  readonly socketsStt = new Gauge({ name: "copilot_dg_sockets_open", help: "Sockets STT abertos", registers: [this.registro] });
  readonly drenando = new Gauge({ name: "copilot_draining", help: "1 quando a instância está em drenagem", registers: [this.registro] });
  readonly circuito = new Gauge({ name: "copilot_circuit_breaker_state", help: "0=fechado 1=aberto 2=meio-aberto", labelNames: ["servico"] as const, registers: [this.registro] });

  readonly conexoesWs = new Counter({ name: "copilot_ws_connections_total", help: "Conexões WS por desfecho", labelNames: ["estado"] as const, registers: [this.registro] });
  readonly sugestoes = new Counter({ name: "copilot_suggestion_shown_total", help: "Sugestões exibidas", labelNames: ["fonte", "camada"] as const, registers: [this.registro] });
  readonly feedback = new Counter({ name: "copilot_suggestion_feedback_total", help: "Feedback do closer", labelNames: ["resultado"] as const, registers: [this.registro] });
  readonly erros = new Counter({ name: "copilot_erros_total", help: "Erros por origem", labelNames: ["origem"] as const, registers: [this.registro] });
  readonly anthropic429 = new Counter({ name: "copilot_anthropic_429_total", help: "Rate limit da Anthropic", registers: [this.registro] });
  readonly reconexoesStt = new Counter({ name: "copilot_stt_reconnect_total", help: "Reconexões STT", registers: [this.registro] });
  readonly bytesSttDescartados = new Counter({ name: "copilot_stt_bytes_descartados_total", help: "Áudio descartado da fila durante queda", registers: [this.registro] });
  readonly tokens = new Counter({ name: "copilot_llm_tokens_total", help: "Tokens por modelo e tipo", labelNames: ["modelo", "tipo"] as const, registers: [this.registro] });
  readonly custoUsd = new Counter({ name: "copilot_custo_usd_total", help: "Custo acumulado em USD por componente", labelNames: ["componente"] as const, registers: [this.registro] });
  readonly callsConcluidas = new Counter({ name: "copilot_calls_total", help: "Calls encerradas por desfecho", labelNames: ["desfecho"] as const, registers: [this.registro] });

  constructor(coletarPadrao = true) {
    if (coletarPadrao) collectDefaultMetrics({ register: this.registro, prefix: "copilot_" });
  }

  observar(etapa: Etapa, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.latencia.observe({ etapa }, ms);
    let r = this.reservatorios.get(etapa);
    if (!r) {
      r = new Reservatorio();
      this.reservatorios.set(etapa, r);
    }
    r.add(ms);
  }

  /** Cronômetro: `const fim = m.cronometro("l1_busca"); ...; fim();` devolve os ms. */
  cronometro(etapa: Etapa): () => number {
    const t0 = performance.now();
    return () => {
      const ms = performance.now() - t0;
      this.observar(etapa, ms);
      return ms;
    };
  }

  erro(origem: string): void {
    this.erros.inc({ origem });
  }

  latenciasJson(): Record<string, { n: number; p50: number | null; p95: number | null; p99: number | null }> {
    const saida: Record<string, ReturnType<Reservatorio["quantis"]>> = {};
    for (const [etapa, r] of this.reservatorios) saida[etapa] = r.quantis();
    return saida;
  }

  async exportar(): Promise<string> {
    return this.registro.metrics();
  }
}
