/**
 * Rotas de autenticação.
 *
 *   POST /v1/pairing/codigo        ← QS (closer autenticado)   → { codigo, expiraEm }
 *   POST /v1/dispositivos/parear   ← extensão v2 (CONTRATO)     → { token, expiraEm, dispositivoId, usuario }
 *   POST /v1/dispositivos/renovar  ← extensão v2 (CONTRATO)     → { token, expiraEm }
 *   POST /v1/pairing/trocar        ← alias antigo de parear     → { token, expiraEm, closer }
 *   POST /v1/auth/renovar          ← alias antigo de renovar
 *   GET  /v1/auth/eu               ← extensão (JWT)             → identidade
 *
 * Contrato: extension-v2/src/compartilhado/gateway.ts. Os códigos de erro
 * (`codigo_invalido_ou_expirado`, `usuario_inativo`, `unauthorized`) são os
 * que a extensão traduz para mensagem humana.
 *
 * Rate limit por IP nos dois endpoints de pairing: força bruta em 6 dígitos
 * com 5 tentativas/min leva ~140 dias por código de 5 min de vida.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { RepositorioCopiloto } from "../db/repositorio.js";
import type { Logger } from "../logger.js";
import { ErroAutenticacao, ErroValidacao } from "../util/erros.js";
import { identificarCloser } from "./identidade.js";
import { emitirToken } from "./jwt.js";
import { gerarCodigoPairing, trocarCodigoPairing } from "./pairing.js";

const CorpoTrocar = z.object({
  codigo: z.string().regex(/^\d{6}$/, "código deve ter 6 dígitos"),
  extensaoVersao: z.string().max(40).optional(),
});

const CorpoParear = z.object({
  codigo: z.string().regex(/^\d{6}$/, "código deve ter 6 dígitos"),
  /** Ex.: "Chrome · macOS". Só para o gestor reconhecer o dispositivo. */
  rotulo: z.string().max(80).default("Chrome"),
  /** UUID estável do Chrome (sem dado pessoal). Vira dispositivoId no JWT. */
  impressao: z.string().min(8).max(80),
});

export function registrarRotasAuth(app: FastifyInstance, cfg: Config, repo: RepositorioCopiloto, log: Logger): void {
  app.post(
    "/v1/pairing/codigo",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { usuario, via } = await identificarCloser(req, cfg, repo);
      const r = await gerarCodigoPairing(repo, usuario, cfg.PAIRING_TTL_SEGUNDOS);
      log.info({ closerId: usuario.id, via }, "código de pairing emitido");
      return reply.code(201).send({ codigo: r.codigo, expiraEm: r.expiraEm, ttlSegundos: cfg.PAIRING_TTL_SEGUNDOS });
    },
  );

  app.post(
    "/v1/pairing/trocar",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const corpo = CorpoTrocar.safeParse(req.body);
      if (!corpo.success) throw new ErroValidacao(corpo.error.issues.map((i) => i.message).join("; "));
      const usuario = await trocarCodigoPairing(repo, corpo.data.codigo);
      const { token, expiraEm } = emitirToken(app, usuario);
      log.info({ closerId: usuario.id, extensaoVersao: corpo.data.extensaoVersao ?? null }, "extensão pareada");
      return reply.code(200).send({
        token,
        expiraEm,
        closer: { id: usuario.id, nome: usuario.nome, papel: usuario.papel },
        wsPath: "/v1/stream",
      });
    },
  );

  // ── Contrato da extensão v2 ────────────────────────────────────────────────
  app.post(
    "/v1/dispositivos/parear",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const corpo = CorpoParear.safeParse(req.body);
      if (!corpo.success) throw new ErroValidacao(corpo.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const usuario = await trocarCodigoPairing(repo, corpo.data.codigo);
      const { token, expiraEm } = emitirToken(app, usuario, corpo.data.impressao);
      log.info(
        { closerId: usuario.id, dispositivoId: corpo.data.impressao, rotulo: corpo.data.rotulo, extensaoVersao: req.headers["x-copiloto-versao"] ?? null },
        "dispositivo pareado",
      );
      return reply.code(200).send({
        token,
        expiraEm,
        dispositivoId: corpo.data.impressao,
        usuario: { id: usuario.id, nome: usuario.nome, papel: usuario.papel },
      });
    },
  );

  app.post("/v1/dispositivos/renovar", { preHandler: exigirJwt }, async (req) => {
    const usuario = await repo.buscarUsuario(req.user.sub);
    if (!usuario || !usuario.ativo) throw new ErroAutenticacao("usuário inativo", undefined, "usuario_inativo");
    return emitirToken(app, usuario, req.user.dispositivoId);
  });

  app.get("/v1/auth/eu", { preHandler: exigirJwt }, async (req) => {
    return { id: req.user.sub, nome: req.user.nome, papel: req.user.papel, expiraEm: new Date(req.user.exp * 1000).toISOString() };
  });

  app.post("/v1/auth/renovar", { preHandler: exigirJwt }, async (req) => {
    const usuario = await repo.buscarUsuario(req.user.sub);
    if (!usuario || !usuario.ativo) throw new ErroAutenticacao("usuário inativo", undefined, "usuario_inativo");
    return emitirToken(app, usuario, req.user.dispositivoId);
  });
}

/** preHandler: exige JWT do gateway. */
export async function exigirJwt(req: FastifyRequest): Promise<void> {
  try {
    await req.jwtVerify();
  } catch (err) {
    throw new ErroAutenticacao("token inválido ou expirado", err);
  }
}
