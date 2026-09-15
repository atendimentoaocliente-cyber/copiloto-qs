import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { criarClienteSql } from "./cliente.js";
import { RepositorioMemoria } from "./memoria.js";
import { RepositorioPostgres } from "./postgres.js";
import type { RepositorioCopiloto } from "./repositorio.js";

export function criarRepositorio(cfg: Config, log: Logger): RepositorioCopiloto {
  if (cfg.DB_MODO === "memoria") {
    log.warn("DB_MODO=memoria: nada será persistido. Use só em dev/testes.");
    return new RepositorioMemoria();
  }
  return new RepositorioPostgres(criarClienteSql(cfg.DATABASE_URL!, log));
}

export * from "./repositorio.js";
export { RepositorioMemoria } from "./memoria.js";
export { RepositorioPostgres } from "./postgres.js";
