/**
 * Logger estruturado (pino).
 *
 * Redação obrigatória: transcrição de call NUNCA vai para log de aplicação
 * (LGPD — dado de cliente). Tokens e senhas idem.
 */
import pino, { type Logger } from "pino";

export type { Logger };

export function criarLogger(nivel: string, ambiente: string): Logger {
  return pino({
    level: nivel,
    base: { servico: "copiloto-gateway" },
    redact: {
      paths: [
        "*.token",
        "*.senha",
        "*.password",
        "*.authorization",
        "req.headers.authorization",
        "req.headers.cookie",
        "*.texto",
        "*.transcricao",
        "*.trecho",
        "*.body",
      ],
      censor: "[redigido]",
    },
    ...(ambiente === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
      : {}),
  });
}
