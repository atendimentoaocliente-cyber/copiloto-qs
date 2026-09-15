/**
 * Fábrica de provedores STT. Trocar de provedor é configuração, não refatoração.
 */
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { ProvedorDeepgram } from "./deepgram.js";
import type { FabricaStt } from "./provedor.js";

export function criarFabricaStt(cfg: Config, log: Logger): FabricaStt {
  switch (cfg.STT_PROVEDOR) {
    case "deepgram":
      if (!cfg.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY ausente");
      return (opcoes) =>
        new ProvedorDeepgram(
          { apiKey: cfg.DEEPGRAM_API_KEY!, modelo: cfg.DEEPGRAM_MODEL, idioma: cfg.DEEPGRAM_LANGUAGE, log },
          opcoes,
        );
    // Plano B (Azure Speech / Google STT): implementar ProvedorStt e adicionar o case aqui.
    default: {
      const nunca: never = cfg.STT_PROVEDOR;
      throw new Error(`provedor STT desconhecido: ${String(nunca)}`);
    }
  }
}

export { ProvedorStt, type EventoTranscricao, type EstadoStt, type OpcoesStt, type FabricaStt } from "./provedor.js";
