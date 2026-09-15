/**
 * Quem está pedindo o código de pairing?
 *
 * Caminho oficial: `Authorization: Bearer <access_token do Supabase Auth>`
 * (após a Frente A). Mapeia para qs_users pelo claim `qs_user_id` ou pelo e-mail.
 *
 * Caminho transitório (PAIRING_ACEITA_SENHA_LEGADA=true): corpo `{email, senha}`
 * validado contra qs_users — exatamente o que o QS faz hoje no browser, só que
 * do lado do servidor, sob TLS, com rate limit e sem log da senha. Some quando
 * o Supabase Auth entrar.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { RepositorioCopiloto, UsuarioQs } from "../db/repositorio.js";
import { ErroAutenticacao } from "../util/erros.js";
import { verificarJwtSupabase } from "./supabase-jwt.js";

const CorpoLegado = z.object({ email: z.email(), senha: z.string().min(1).max(200) });

export async function identificarCloser(
  req: FastifyRequest,
  cfg: Pick<Config, "SUPABASE_JWT_SECRET" | "PAIRING_ACEITA_SENHA_LEGADA">,
  repo: Pick<RepositorioCopiloto, "buscarUsuario" | "buscarUsuarioPorEmail" | "validarSenhaLegada">,
): Promise<{ usuario: UsuarioQs; via: "supabase" | "senha_legada" }> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") && cfg.SUPABASE_JWT_SECRET) {
    const claims = verificarJwtSupabase(auth.slice(7).trim(), cfg.SUPABASE_JWT_SECRET);
    const usuario =
      (claims.qs_user_id ? await repo.buscarUsuario(claims.qs_user_id) : null) ??
      (claims.email ? await repo.buscarUsuarioPorEmail(claims.email) : null);
    if (!usuario) throw new ErroAutenticacao("usuário do Supabase não existe em qs_users");
    return { usuario, via: "supabase" };
  }

  if (cfg.PAIRING_ACEITA_SENHA_LEGADA) {
    const corpo = CorpoLegado.safeParse(req.body);
    if (!corpo.success) throw new ErroAutenticacao("informe email e senha");
    const usuario = await repo.validarSenhaLegada(corpo.data.email, corpo.data.senha);
    if (!usuario) throw new ErroAutenticacao("e-mail ou senha inválidos");
    return { usuario, via: "senha_legada" };
  }

  throw new ErroAutenticacao("sem credencial: envie o token do Supabase Auth");
}
