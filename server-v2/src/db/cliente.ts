/**
 * Conexão postgres.js com o Supabase.
 *
 * Usa o pooler em modo transação (porta 6543): `prepare: false` é obrigatório
 * nesse modo. `set local` funciona dentro de `sql.begin()`.
 */
import postgres, { type Sql } from "postgres";
import type { Logger } from "../logger.js";

export type ClienteSql = Sql;

export function criarClienteSql(url: string, log: Logger): ClienteSql {
  return postgres(url, {
    prepare: false,
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: (n) => log.debug({ notice: n.message }, "postgres notice"),
    connection: { application_name: "copiloto-gateway" },
  });
}
