/**
 * Montagem do Fastify — separada do `server.ts` para os testes subirem o app
 * com dependências falsas (STT de fixture, IA falsa, repositório em memória).
 */
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registrarJwt, verificarToken } from "./auth/jwt.js";
import { registrarRotasAuth } from "./auth/rotas.js";
import type { Config } from "./config.js";
import { registrarRotasCusto } from "./custo/rotas.js";
import type { RepositorioCopiloto } from "./db/repositorio.js";
import type { Logger } from "./logger.js";
import type { Embedder } from "./motor/embeddings.js";
import type { CachePlaybook } from "./motor/playbook.js";
import type { ClienteIa } from "./motor/tipos.js";
import { Metricas } from "./observabilidade/metricas.js";
import { registrarRotasObservabilidade } from "./observabilidade/rotas.js";
import { RegistroSessoes } from "./sessao/registro.js";
import { registrarRotaStream } from "./sessao/ws.js";
import { registrarRotasQs } from "./qs/rotas.js";
import { SUBPROTOCOLO } from "./tipos/protocolo.js";
import type { FabricaStt } from "./stt/provedor.js";
import { ErroCopiloto } from "./util/erros.js";

export interface DependenciasApp {
  cfg: Config;
  log: Logger;
  repo: RepositorioCopiloto;
  fabricaStt: FabricaStt;
  playbook: CachePlaybook;
  ia: ClienteIa | null;
  embedder: Embedder | null;
  metricas?: Metricas;
  versao?: string;
  agora?: () => number;
}

export interface AppMontado {
  app: FastifyInstance;
  registro: RegistroSessoes;
  metricas: Metricas;
  drenar: () => Promise<{ restantes: number }>;
}

export async function criarApp(d: DependenciasApp): Promise<AppMontado> {
  const metricas = d.metricas ?? new Metricas(d.cfg.NODE_ENV !== "test");
  const registro = new RegistroSessoes(metricas, d.log);
  // Cast: o pino.Logger tem mais métodos que o FastifyBaseLogger; sem o cast o Fastify
  // infere um FastifyInstance especializado que não casa com as assinaturas dos módulos.
  const app: FastifyInstance = Fastify({ loggerInstance: d.log as unknown as FastifyBaseLogger, bodyLimit: 256 * 1024, trustProxy: true });

  // A extensão manda Content-Type: application/json só quando há corpo; um POST sem corpo
  // (ex.: /v1/dispositivos/renovar) não pode virar 400 por causa do cabeçalho.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, corpo, done) => {
    const texto = typeof corpo === "string" ? corpo : corpo.toString("utf8");
    if (!texto.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(texto));
    } catch (err) {
      done(Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 400 }), undefined);
    }
  });

  await app.register(cors, {
    origin: d.cfg.QS_ORIGEM ? [d.cfg.QS_ORIGEM, ...d.cfg.EXTENSAO_ORIGENS] : true,
    methods: ["GET", "POST", "OPTIONS"],
  });
  await app.register(rateLimit, { global: false });
  await registrarJwt(app, d.cfg.JWT_SEGREDO, d.cfg.JWT_TTL);
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
      // Extensão v2: subprotocolo "qscopilot.v1" + ?token=. Mantemos "bearer, <token>" (clientes antigos/smoke).
      handleProtocols: (protocolos: Set<string>) =>
        protocolos.has(SUBPROTOCOLO) ? SUBPROTOCOLO : protocolos.has("bearer") ? "bearer" : false,
    },
  });

  // Erros tipados → status + JSON estável. Nada de 500 genérico escondendo a causa.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ErroCopiloto) {
      if (err.status >= 500) req.log.error({ err, codigo: err.codigo }, err.message);
      else req.log.warn({ codigo: err.codigo }, err.message);
      return reply.code(err.status).send({ erro: err.codigo, mensagem: err.message });
    }
    const status = typeof (err as { statusCode?: number }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, "erro não tratado");
      metricas.erro("http_500");
    }
    return reply.code(status).send({ erro: status === 429 ? "limite" : "interno", mensagem: status >= 500 ? "erro interno" : (err as Error).message });
  });

  let drenagem: Promise<{ restantes: number }> | null = null;
  const drenar = () => {
    if (!drenagem) drenagem = registro.drenar(d.cfg.DRENAGEM_MAX_MS);
    return drenagem;
  };

  registrarRotasObservabilidade(app, {
    cfg: d.cfg,
    metricas,
    registro,
    versao: d.versao ?? process.env.GIT_SHA ?? "dev",
    iniciarDrenagem: () => void drenar(),
    playbookVersao: () => d.playbook.versao,
  });
  registrarRotasAuth(app, d.cfg, d.repo, d.log);
  registrarRotasCusto(app, d.cfg, d.repo);
  registrarRotasQs(app, d.repo, d.playbook);
  registrarRotaStream(app, {
    cfg: d.cfg,
    log: d.log,
    metricas,
    repo: d.repo,
    registro,
    fabricaStt: d.fabricaStt,
    playbook: d.playbook,
    ia: d.ia,
    embedder: d.embedder,
    verificarToken: (token) => verificarToken(app, token),
    agora: d.agora,
  });

  return { app, registro, metricas, drenar };
}
