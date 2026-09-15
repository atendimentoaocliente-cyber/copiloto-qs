/**
 * Ponto de entrada — monta dependências reais e sobe o gateway.
 *
 * Desligamento: SIGTERM → drenagem (health 503, sessões avisadas, espera até
 * 45 min ou zero sessões) → fecha. O Fly limita `kill_timeout` a 300 s, então
 * a drenagem longa de verdade é orquestrada pelo CI/`scripts/drenar-maquina.sh`
 * (que chama /internal/drain e só remove a máquina com zero sessões).
 */
import { criarApp } from "./app.js";
import { carregarConfig } from "./config.js";
import { criarRepositorio } from "./db/index.js";
import { criarLogger } from "./logger.js";
import { EmbedderDeterministico, EmbedderHttp, type Embedder } from "./motor/embeddings.js";
import { ClienteAnthropic } from "./motor/ia.js";
import { CachePlaybook } from "./motor/playbook.js";
import type { ClienteIa } from "./motor/tipos.js";
import { Metricas } from "./observabilidade/metricas.js";
import { criarFabricaStt } from "./stt/index.js";

async function iniciar(): Promise<void> {
  const cfg = carregarConfig();
  const log = criarLogger(cfg.LOG_LEVEL, cfg.NODE_ENV);
  const metricas = new Metricas(true);
  const repo = criarRepositorio(cfg, log);

  const playbook = new CachePlaybook(repo, log, metricas, cfg.PLAYBOOK_CACHE_SEGUNDOS * 1000);
  await playbook.iniciar();

  let ia: ClienteIa | null = null;
  if (cfg.ANTHROPIC_API_KEY) {
    ia = new ClienteAnthropic({
      apiKey: cfg.ANTHROPIC_API_KEY,
      modelos: { classificador: cfg.ANTHROPIC_MODEL_CLASSIFICADOR, gerador: cfg.ANTHROPIC_MODEL_GERADOR, resumo: cfg.ANTHROPIC_MODEL_RESUMO },
      digestPlaybook: () => playbook.digest,
      log,
      metricas,
    });
  } else {
    log.warn("ANTHROPIC_API_KEY ausente: rodando só com L0 (gatilhos) + L1 (banco). Sem L2/L3 nem resumo pós-call.");
  }

  let embedder: Embedder | null = null;
  if (cfg.DB_MODO === "memoria") {
    embedder = new EmbedderDeterministico(cfg.EMBEDDINGS_DIMENSOES);
  } else if (cfg.EMBEDDINGS_API_KEY) {
    embedder = new EmbedderHttp({ url: cfg.EMBEDDINGS_URL, apiKey: cfg.EMBEDDINGS_API_KEY, modelo: cfg.EMBEDDINGS_MODEL, dimensoes: cfg.EMBEDDINGS_DIMENSOES });
  } else {
    log.warn("EMBEDDINGS_API_KEY ausente: L1 (busca vetorial) desligado. Só L0 + L2/L3.");
  }

  const { app, registro, drenar } = await criarApp({
    cfg,
    log,
    repo,
    fabricaStt: criarFabricaStt(cfg, log),
    playbook,
    ia,
    embedder,
    metricas,
    versao: process.env.GIT_SHA ?? "dev",
  });

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  log.info(
    { porta: cfg.PORT, stt: `${cfg.DEEPGRAM_MODEL}·${cfg.DEEPGRAM_LANGUAGE}`, ia: ia ? `${cfg.ANTHROPIC_MODEL_CLASSIFICADOR} + ${cfg.ANTHROPIC_MODEL_GERADOR}` : "desligada", l1: embedder ? "ligado" : "desligado", db: cfg.DB_MODO },
    "Copiloto QS gateway no ar",
  );

  let desligando = false;
  const desligar = async (sinal: string) => {
    if (desligando) return;
    desligando = true;
    log.warn({ sinal, sessoes: registro.total }, "sinal recebido; iniciando drenagem");
    const { restantes } = await drenar();
    if (restantes > 0) log.error({ restantes }, "prazo de drenagem estourou com sessões ativas");
    playbook.parar();
    await app.close();
    await repo.fechar();
    process.exit(restantes > 0 ? 1 : 0);
  };
  process.on("SIGTERM", () => void desligar("SIGTERM"));
  process.on("SIGINT", () => void desligar("SIGINT"));
  process.on("unhandledRejection", (err) => {
    log.error({ err }, "unhandledRejection");
    metricas.erro("unhandled_rejection");
  });
}

iniciar().catch((err) => {
  console.error("Falha ao subir o gateway:", err instanceof Error ? err.message : err);
  process.exit(1);
});
