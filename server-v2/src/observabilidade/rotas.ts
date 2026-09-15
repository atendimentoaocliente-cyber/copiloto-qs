/**
 * Saúde, métricas e endpoints internos.
 *
 *   GET  /health              → 200 ok · 503 quando em drenagem (proxy do Fly para de rotear)
 *   GET  /metrics             → Prometheus (Bearer METRICS_TOKEN, se definido)
 *   GET  /internal/sessoes    → sessões ativas (o CI bloqueia deploy se > 0)
 *   GET  /internal/latencias  → p50/p95/p99 por etapa em JSON
 *   POST /internal/drain      → entra em drenagem (scale-in sem derrubar call)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { ErroAutenticacao } from "../util/erros.js";
import type { RegistroSessoes } from "../sessao/registro.js";
import type { Metricas } from "../observabilidade/metricas.js";

export interface DependenciasObs {
  cfg: Config;
  metricas: Metricas;
  registro: RegistroSessoes;
  versao: string;
  iniciarDrenagem: () => void;
  playbookVersao: () => number;
}

export function registrarRotasObservabilidade(app: FastifyInstance, d: DependenciasObs): void {
  app.get("/health", async (_req, reply) => {
    const corpo = {
      ok: !d.registro.emDrenagem,
      drenando: d.registro.emDrenagem,
      sessoesAtivas: d.registro.total,
      versao: d.versao,
      playbookVersao: d.playbookVersao(),
      stt: { provedor: d.cfg.STT_PROVEDOR, modelo: d.cfg.DEEPGRAM_MODEL, idioma: d.cfg.DEEPGRAM_LANGUAGE },
      ia: Boolean(d.cfg.ANTHROPIC_API_KEY),
    };
    return reply.code(d.registro.emDrenagem ? 503 : 200).send(corpo);
  });

  // O scraper do Fly não manda bearer: libera a rede privada 6PN (fdaa::/16) mesmo com token configurado.
  app.get("/metrics", { preHandler: exigirToken(d.cfg.METRICS_TOKEN, (req) => req.ip.startsWith("fdaa:")) }, async (_req, reply) => {
    reply.header("content-type", d.metricas.registro.contentType);
    return d.metricas.exportar();
  });

  app.get("/internal/sessoes", { preHandler: exigirToken(d.cfg.INTERNAL_TOKEN) }, async () => ({
    active_sessions: d.registro.total,
    drenando: d.registro.emDrenagem,
    sessoes: d.registro.listar(),
  }));

  app.get("/internal/latencias", { preHandler: exigirToken(d.cfg.INTERNAL_TOKEN) }, async () => ({
    orcamentoP95Ms: 2000,
    etapas: d.metricas.latenciasJson(),
  }));

  app.post("/internal/drain", { preHandler: exigirToken(d.cfg.INTERNAL_TOKEN) }, async () => {
    d.iniciarDrenagem();
    return { drenando: true, sessoesAtivas: d.registro.total, prazoMs: d.cfg.DRENAGEM_MAX_MS };
  });
}

function exigirToken(token: string | undefined, isento?: (req: FastifyRequest) => boolean) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!token) return; // sem token configurado = aberto (dev). Em produção, configure.
    if (isento?.(req)) return;
    if (req.headers.authorization !== `Bearer ${token}`) throw new ErroAutenticacao("token interno inválido");
  };
}
