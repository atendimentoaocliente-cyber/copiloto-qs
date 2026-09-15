/**
 * Configuração do gateway — validada com Zod na subida do processo.
 *
 * Regra: se uma variável obrigatória faltar, o processo NÃO sobe. Em copiloto
 * ao vivo, subir "meio configurado" é pior que não subir: o closer acha que
 * está coberto e não está.
 */
import { z } from "zod";

const booleano = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const listaSeparadaPorVirgula = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const Esquema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // 0 é válido e é o que os testes usam: o SO escolhe uma porta livre.
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().default("0.0.0.0"),
  // "silent" é nível válido do pino e é o usado nos testes.
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),

  // STT
  STT_PROVEDOR: z.enum(["deepgram"]).default("deepgram"),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  // VALIDADO: pt-BR não funciona. nova-3 + multi é o único combo que transcreve português.
  DEEPGRAM_LANGUAGE: z.string().default("multi"),

  // IA
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_CLASSIFICADOR: z.string().default("claude-haiku-4-5"),
  ANTHROPIC_MODEL_GERADOR: z.string().default("claude-sonnet-5"),
  ANTHROPIC_MODEL_RESUMO: z.string().default("claude-sonnet-5"),

  // Embeddings
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_URL: z.string().url().default("https://api.openai.com/v1/embeddings"),
  EMBEDDINGS_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDINGS_DIMENSOES: z.coerce.number().int().default(1536),

  // Banco
  DB_MODO: z.enum(["postgres", "memoria"]).default("postgres"),
  DATABASE_URL: z.string().optional(),

  // Auth
  JWT_SEGREDO: z.string().min(32, "JWT_SEGREDO precisa de pelo menos 32 caracteres"),
  JWT_TTL: z.string().default("12h"),
  PAIRING_TTL_SEGUNDOS: z.coerce.number().int().positive().default(300),
  SUPABASE_JWT_SECRET: z.string().optional(),
  PAIRING_ACEITA_SENHA_LEGADA: booleano,
  EXTENSAO_ORIGENS: listaSeparadaPorVirgula,
  QS_ORIGEM: z.string().optional(),

  // Custo e limites
  CAMBIO_BRL: z.coerce.number().positive().default(5.4),
  CUSTO_MAX_BRL_POR_CALL: z.coerce.number().positive().default(25),
  SESSAO_MAX_MINUTOS: z.coerce.number().int().positive().default(120),
  SESSOES_MAX_POR_CLOSER: z.coerce.number().int().positive().default(2),
  DRENAGEM_MAX_MS: z.coerce.number().int().positive().default(45 * 60 * 1000),
  PLAYBOOK_CACHE_SEGUNDOS: z.coerce.number().int().positive().default(300),

  // Observabilidade
  METRICS_TOKEN: z.string().optional(),
  INTERNAL_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof Esquema>;

/** Carrega e valida a configuração a partir de `process.env` (ou de um objeto, nos testes). */
export function carregarConfig(fonte: NodeJS.ProcessEnv = process.env): Config {
  const resultado = Esquema.safeParse(fonte);
  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuração inválida:\n${problemas}`);
  }
  const cfg = resultado.data;

  // Validações cruzadas: o Zod não sabe que DATABASE_URL depende de DB_MODO.
  if (cfg.DB_MODO === "postgres" && !cfg.DATABASE_URL) {
    throw new Error("DB_MODO=postgres exige DATABASE_URL (ou use DB_MODO=memoria para dev/testes).");
  }
  if (cfg.STT_PROVEDOR === "deepgram" && !cfg.DEEPGRAM_API_KEY && cfg.NODE_ENV !== "test") {
    throw new Error("STT_PROVEDOR=deepgram exige DEEPGRAM_API_KEY.");
  }
  if (cfg.NODE_ENV === "production" && cfg.EXTENSAO_ORIGENS.length === 0) {
    throw new Error("Em produção, EXTENSAO_ORIGENS precisa listar o ID fixo da extensão (chrome-extension://...).");
  }
  if (cfg.NODE_ENV === "production" && !cfg.SUPABASE_JWT_SECRET && !cfg.PAIRING_ACEITA_SENHA_LEGADA) {
    throw new Error(
      "Nenhum caminho de identidade para o pairing: defina SUPABASE_JWT_SECRET (oficial) ou PAIRING_ACEITA_SENHA_LEGADA=true (transitório).",
    );
  }
  return cfg;
}
