/**
 * Preenche `embedding` das objeções aprovadas que ainda não têm (o seed da
 * Frente A deixa NULL). Sem isto, o L1 não devolve nada.
 *
 *   npm run embeddings:backfill
 *
 * Texto embutido = exemplo_lead + variacoes + titulo (como o lead fala, não a resposta).
 * Idempotente: só toca linhas com embedding IS NULL ou modelo diferente.
 */
import pgvector from "pgvector";
import { carregarConfig } from "../src/config.js";
import { criarClienteSql } from "../src/db/cliente.js";
import { criarLogger } from "../src/logger.js";
import { EmbedderHttp } from "../src/motor/embeddings.js";

const cfg = carregarConfig();
const log = criarLogger("info", "development");
if (!cfg.DATABASE_URL || !cfg.EMBEDDINGS_API_KEY) {
  log.error("precisa de DATABASE_URL e EMBEDDINGS_API_KEY");
  process.exit(2);
}
const sql = criarClienteSql(cfg.DATABASE_URL, log);
const embedder = new EmbedderHttp({ url: cfg.EMBEDDINGS_URL, apiKey: cfg.EMBEDDINGS_API_KEY, modelo: cfg.EMBEDDINGS_MODEL, dimensoes: cfg.EMBEDDINGS_DIMENSOES, timeoutMs: 10_000 });

const pendentes = await sql<Array<{ id: string; titulo: string; exemplo_lead: string; variacoes: string[] | null }>>`
  select id, titulo, exemplo_lead, variacoes from public.qs_copilot_objections
  where is_active and (embedding is null or embedding_model <> ${cfg.EMBEDDINGS_MODEL})`;
log.info({ pendentes: pendentes.length }, "objeções sem embedding");

let ok = 0;
for (const o of pendentes) {
  const texto = [o.exemplo_lead, ...(o.variacoes ?? []), o.titulo].join(". ");
  try {
    const { vetor } = await embedder.embed(texto);
    await sql`update public.qs_copilot_objections
      set embedding = ${pgvector.toSql(vetor)}::vector, embedding_model = ${cfg.EMBEDDINGS_MODEL}, embedding_updated_at = now()
      where id = ${o.id}`;
    ok++;
  } catch (err) {
    log.error({ err, id: o.id, titulo: o.titulo }, "falha ao embutir");
  }
}
log.info({ ok, falhas: pendentes.length - ok }, "backfill concluído");
await sql.end();
process.exit(ok === pendentes.length ? 0 : 1);
