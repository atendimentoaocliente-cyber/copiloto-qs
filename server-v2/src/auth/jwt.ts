/**
 * JWT do gateway — o único credencial que a extensão carrega.
 *
 * Emitido na troca do código de pairing. Assinado com JWT_SEGREDO (HS256).
 * A extensão NUNCA fala com o Supabase: tudo passa por aqui.
 */
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance } from "fastify";
import type { PapelQs, UsuarioQs } from "../db/repositorio.js";
import { ErroAutenticacao } from "../util/erros.js";

export const ESCOPO_STREAM = "copiloto:stream";

export interface PayloadCopiloto {
  sub: string;
  nome: string;
  papel: PapelQs;
  escopo: typeof ESCOPO_STREAM;
  /** Impressão do Chrome pareado (sem dado pessoal). Base para revogação por dispositivo. */
  dispositivoId?: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: PayloadCopiloto;
    user: PayloadCopiloto & { iat: number; exp: number };
  }
}

export async function registrarJwt(app: FastifyInstance, segredo: string, ttl: string): Promise<void> {
  await app.register(fastifyJwt, { secret: segredo, sign: { expiresIn: ttl } });
}

export function emitirToken(app: FastifyInstance, u: UsuarioQs, dispositivoId?: string): { token: string; expiraEm: string } {
  const token = app.jwt.sign({ sub: u.id, nome: u.nome, papel: u.papel, escopo: ESCOPO_STREAM, ...(dispositivoId ? { dispositivoId } : {}) });
  const decodificado = app.jwt.decode<{ exp?: number }>(token);
  const exp = decodificado?.exp ? new Date(decodificado.exp * 1000).toISOString() : "";
  return { token, expiraEm: exp };
}

/** Verifica um token fora do ciclo de request (handshake do WebSocket). */
export function verificarToken(app: FastifyInstance, token: string): PayloadCopiloto {
  let payload: PayloadCopiloto & { exp?: number };
  try {
    payload = app.jwt.verify<PayloadCopiloto & { exp?: number }>(token);
  } catch (err) {
    throw new ErroAutenticacao("token inválido ou expirado", err);
  }
  if (payload.escopo !== ESCOPO_STREAM || !payload.sub) throw new ErroAutenticacao("token sem escopo de streaming");
  return { sub: payload.sub, nome: payload.nome, papel: payload.papel, escopo: ESCOPO_STREAM, dispositivoId: payload.dispositivoId };
}
