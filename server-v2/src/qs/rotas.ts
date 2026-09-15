/**
 * Rotas que a extensão v2 chama antes/depois da call (contrato em
 * extension-v2/src/compartilhado/gateway.ts):
 *
 *   GET  /v1/reunioes?dia=hoje|YYYY-MM-DD       → Reuniao[]
 *   GET  /v1/leads/:leadId/briefing?reuniaoId=… → Briefing
 *   POST /v1/consentimentos                     → 201 { id }   (aceite OU recusa)
 *   POST /v1/sugestoes/:id/feedback             → 204
 *
 * Todas exigem o JWT do gateway. A extensão nunca fala com o Supabase.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { exigirJwt } from "../auth/rotas.js";
import type { RepositorioCopiloto } from "../db/repositorio.js";
import type { CachePlaybook } from "../motor/playbook.js";
import { OUTCOME_POR_FEEDBACK, ValorFeedback } from "../tipos/protocolo.js";
import { ErroNaoEncontrado, ErroPermissao, ErroValidacao } from "../util/erros.js";

const ConsultaReunioes = z.object({
  dia: z.union([z.literal("hoje"), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default("hoje"),
});

const CorpoConsentimento = z.object({
  reuniaoId: z.uuid().nullable().optional(),
  leadId: z.uuid().nullable().optional(),
  confirmadoEm: z.iso.datetime(),
  textoVersao: z.string().min(1).max(40),
  /** A extensão hoje só manda aceite; a recusa entra pelo mesmo endpoint para auditoria. */
  aceito: z.boolean().default(true),
  motivoRecusa: z.string().max(500).nullable().optional(),
});

const CorpoFeedback = z.object({
  sessaoId: z.uuid(),
  valor: ValorFeedback,
  em: z.iso.datetime(),
});

/** Janela [00:00, 24:00) de um dia em São Paulo, em ISO UTC. */
export function janelaDoDia(dia: "hoje" | string, agora: Date = new Date()): { desde: string; ate: string; dia: string } {
  const ymd = dia === "hoje" ? agora.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) : dia;
  const desde = new Date(`${ymd}T00:00:00-03:00`);
  const ate = new Date(desde.getTime() + 86_400_000);
  if (Number.isNaN(desde.getTime())) throw new ErroValidacao(`dia inválido: ${dia}`);
  return { desde: desde.toISOString(), ate: ate.toISOString(), dia: ymd };
}

export function registrarRotasQs(app: FastifyInstance, repo: RepositorioCopiloto, playbook: CachePlaybook): void {
  app.get("/v1/reunioes", { preHandler: exigirJwt }, async (req) => {
    const q = ConsultaReunioes.safeParse(req.query);
    if (!q.success) throw new ErroValidacao(q.error.issues.map((i) => i.message).join("; "));
    const { desde, ate } = janelaDoDia(q.data.dia);
    return repo.listarReunioesDoCloser(req.user.sub, desde, ate);
  });

  app.get<{ Params: { leadId: string }; Querystring: { reuniaoId?: string } }>(
    "/v1/leads/:leadId/briefing",
    { preHandler: exigirJwt },
    async (req) => {
      const leadId = z.uuid().safeParse(req.params.leadId);
      if (!leadId.success) throw new ErroValidacao("leadId inválido");
      const b = await repo.carregarBriefingCompleto(leadId.data);
      if (!b) throw new ErroNaoEncontrado("lead não encontrado");
      // Closer vê o lead dele (ou sem dono ainda — o handover pode não ter fechado); gestor/admin veem todos.
      const gestor = req.user.papel === "gestor" || req.user.papel === "admin";
      if (!gestor && b.lead.ownerId && b.lead.ownerId !== req.user.sub) throw new ErroPermissao("lead de outro closer");
      const { ownerId: _o, empresa: _e, valorEstimado: _v, ...lead } = b.lead;
      return {
        lead,
        handover: b.handover,
        produto: b.produto,
        historico: b.historico,
        ultimasCalls: b.ultimasCalls,
        playbook: { id: "inovvatur", nome: "Playbook Inovvatur", totalObjecoes: playbook.todas.length },
      };
    },
  );

  app.post("/v1/consentimentos", { preHandler: exigirJwt }, async (req, reply) => {
    const corpo = CorpoConsentimento.safeParse(req.body);
    if (!corpo.success) throw new ErroValidacao(corpo.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const c = corpo.data;
    if (!c.aceito && !c.motivoRecusa) {
      // Recusa sem motivo é aceita, mas registrada como tal — o QS audita que o lead foi perguntado.
      c.motivoRecusa = "lead não autorizou";
    }
    const { id } = await repo.registrarConsentimento({
      closerId: req.user.sub,
      leadId: c.leadId ?? null,
      meetingId: c.reuniaoId ?? null,
      aceito: c.aceito,
      confirmadoEm: c.confirmadoEm,
      textoVersao: c.textoVersao,
      motivoRecusa: c.aceito ? null : (c.motivoRecusa ?? null),
      ip: req.ip ?? null,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 300) : null,
      versaoExtensao: typeof req.headers["x-copiloto-versao"] === "string" ? req.headers["x-copiloto-versao"] : null,
    });
    req.log.info({ consentimentoId: id, leadId: c.leadId ?? null, aceito: c.aceito }, "consentimento registrado");
    return reply.code(201).send({ id, aceito: c.aceito });
  });

  app.post<{ Params: { id: string } }>("/v1/sugestoes/:id/feedback", { preHandler: exigirJwt }, async (req, reply) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new ErroValidacao("id da sugestão inválido");
    const corpo = CorpoFeedback.safeParse(req.body);
    if (!corpo.success) throw new ErroValidacao(corpo.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const sessao = await repo.buscarSessao(corpo.data.sessaoId);
    if (!sessao) throw new ErroNaoEncontrado("sessão não encontrada");
    if (sessao.closerId !== req.user.sub) throw new ErroPermissao("sessão de outro closer");
    const ok = await repo.atualizarDeteccao(id.data, corpo.data.sessaoId, {
      outcome: OUTCOME_POR_FEEDBACK[corpo.data.valor],
      feedbackAt: corpo.data.em,
    });
    if (!ok) throw new ErroNaoEncontrado("sugestão não encontrada nesta sessão");
    return reply.code(204).send();
  });
}
