/**
 * API de custo.
 *
 *   GET /v1/calls/:id/custo           ← JWT (dono da call, gestor ou admin)
 *   GET /v1/custo/resumo?desde&ate&closerId ← JWT gestor/admin ou token interno
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { RepositorioCopiloto } from "../db/repositorio.js";
import { ErroNaoEncontrado, ErroPermissao, ErroValidacao } from "../util/erros.js";
import { exigirJwt } from "../auth/rotas.js";

const Consulta = z.object({
  desde: z.iso.datetime().optional(),
  ate: z.iso.datetime().optional(),
  closerId: z.uuid().optional(),
});

export function registrarRotasCusto(app: FastifyInstance, cfg: Config, repo: RepositorioCopiloto): void {
  app.get<{ Params: { id: string } }>("/v1/calls/:id/custo", { preHandler: exigirJwt }, async (req) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new ErroValidacao("id inválido");
    const c = await repo.custoDaSessao(id.data);
    if (!c) throw new ErroNaoEncontrado("call não encontrada");
    if (c.closerId !== req.user.sub && !["gestor", "admin"].includes(req.user.papel)) throw new ErroPermissao();
    const totalUsd = c.sttCostUsd + c.llmCostUsd;
    return {
      callId: c.callId,
      closerId: c.closerId,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      sttUsd: c.sttCostUsd,
      llmUsd: c.llmCostUsd,
      totalUsd,
      totalBrl: +(totalUsd * cfg.CAMBIO_BRL).toFixed(4),
      cambio: cfg.CAMBIO_BRL,
      detalhe: c.metadata.custo ?? null,
    };
  });

  app.get("/v1/custo/resumo", { preHandler: exigirGestorOuInterno(cfg) }, async (req) => {
    const q = Consulta.safeParse(req.query);
    if (!q.success) throw new ErroValidacao(q.error.issues.map((i) => i.message).join("; "));
    const ate = q.data.ate ?? new Date().toISOString();
    const desde = q.data.desde ?? new Date(Date.parse(ate) - 30 * 86_400_000).toISOString();
    const r = await repo.custoPorPeriodo(desde, ate, q.data.closerId ?? null);
    return {
      periodo: { desde, ate },
      calls: r.calls,
      sttUsd: r.sttUsd,
      llmUsd: r.llmUsd,
      totalUsd: r.totalUsd,
      totalBrl: +(r.totalUsd * cfg.CAMBIO_BRL).toFixed(2),
      mediaPorCallBrl: r.calls ? +((r.totalUsd * cfg.CAMBIO_BRL) / r.calls).toFixed(2) : 0,
      porCloser: r.porCloser.map((c) => ({ ...c, totalBrl: +(c.totalUsd * cfg.CAMBIO_BRL).toFixed(2) })),
      cambio: cfg.CAMBIO_BRL,
    };
  });
}

/** Aceita JWT de gestor/admin OU o token interno (para o painel do QS e o CI). */
function exigirGestorOuInterno(cfg: Config) {
  return async (req: FastifyRequest): Promise<void> => {
    const auth = req.headers.authorization ?? "";
    if (cfg.INTERNAL_TOKEN && auth === `Bearer ${cfg.INTERNAL_TOKEN}`) return;
    await exigirJwt(req);
    if (!["gestor", "admin"].includes(req.user.papel)) throw new ErroPermissao("só gestor/admin");
  };
}
