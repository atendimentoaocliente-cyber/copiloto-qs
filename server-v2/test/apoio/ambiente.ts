/** Config e logger de teste. */
import { carregarConfig, type Config } from "../../src/config.js";
import { criarLogger } from "../../src/logger.js";
import { Metricas } from "../../src/observabilidade/metricas.js";

export function configTeste(extra: Record<string, string> = {}): Config {
  return carregarConfig({
    NODE_ENV: "test",
    PORT: "0",
    LOG_LEVEL: "silent",
    DB_MODO: "memoria",
    JWT_SEGREDO: "segredo-de-teste-com-pelo-menos-32-caracteres!!",
    JWT_TTL: "1h",
    PAIRING_ACEITA_SENHA_LEGADA: "true",
    DEEPGRAM_API_KEY: "fake",
    CAMBIO_BRL: "5.4",
    CUSTO_MAX_BRL_POR_CALL: "25",
    ...extra,
  });
}

export const logTeste = () => criarLogger("silent", "test");
export const metricasTeste = () => new Metricas(false);
