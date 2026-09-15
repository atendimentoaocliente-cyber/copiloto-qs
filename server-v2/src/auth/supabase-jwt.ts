/**
 * Verificação do access_token do Supabase Auth (HS256) — caminho OFICIAL do
 * pairing depois que a Frente A substituir o backdoor do QS por Supabase Auth.
 *
 * Feito com `node:crypto` de propósito: 25 linhas, zero dependência, e o
 * segredo (SUPABASE_JWT_SECRET) fica só no gateway.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ErroAutenticacao } from "../util/erros.js";

export interface ClaimsSupabase {
  sub: string;
  email: string | null;
  qs_user_id: string | null;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function verificarJwtSupabase(token: string, segredo: string, agora: () => number = Date.now): ClaimsSupabase {
  const partes = token.split(".");
  if (partes.length !== 3) throw new ErroAutenticacao("token Supabase malformado");
  const [cab, corpo, assinatura] = partes as [string, string, string];

  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(cab, "base64url").toString("utf8")) as { alg?: string };
  } catch {
    throw new ErroAutenticacao("cabeçalho do token ilegível");
  }
  if (header.alg !== "HS256") throw new ErroAutenticacao(`algoritmo não suportado: ${header.alg ?? "?"}`);

  const esperado = b64url(createHmac("sha256", segredo).update(`${cab}.${corpo}`).digest());
  const a = Buffer.from(esperado);
  const b = Buffer.from(assinatura);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ErroAutenticacao("assinatura do token Supabase inválida");

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ErroAutenticacao("claims do token ilegíveis");
  }
  const exp = Number(claims.exp ?? 0);
  if (!exp || exp * 1000 < agora()) throw new ErroAutenticacao("token Supabase expirado");
  if (claims.aud && claims.aud !== "authenticated") throw new ErroAutenticacao("audiência inválida");
  if (typeof claims.sub !== "string") throw new ErroAutenticacao("token sem sub");
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    qs_user_id: typeof claims.qs_user_id === "string" ? claims.qs_user_id : null,
    exp,
  };
}
