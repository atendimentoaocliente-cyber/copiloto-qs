import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gerarCodigoPairing, trocarCodigoPairing } from "../../src/auth/pairing.js";
import { verificarJwtSupabase } from "../../src/auth/supabase-jwt.js";
import { RepositorioMemoria } from "../../src/db/memoria.js";
import type { UsuarioQs } from "../../src/db/repositorio.js";
import { ErroAutenticacao, ErroPermissao } from "../../src/util/erros.js";

const closer: UsuarioQs = { id: "11111111-1111-4111-8111-111111111111", nome: "Joana", email: "joana@inovvatur.com.br", papel: "closer", ativo: true };

describe("pairing", () => {
  it("gera código de 6 dígitos, uso único, com TTL", async () => {
    const repo = new RepositorioMemoria({ usuarios: new Map([[closer.id, closer]]) });
    const { codigo } = await gerarCodigoPairing(repo, closer, 300);
    expect(codigo).toMatch(/^\d{6}$/);
    const u = await trocarCodigoPairing(repo, codigo);
    expect(u.id).toBe(closer.id);
    await expect(trocarCodigoPairing(repo, codigo)).rejects.toBeInstanceOf(ErroAutenticacao);
  });

  it("código expirado não troca", async () => {
    const repo = new RepositorioMemoria({ usuarios: new Map([[closer.id, closer]]) });
    const { codigo } = await gerarCodigoPairing(repo, closer, 1, () => Date.now() - 10_000);
    await expect(trocarCodigoPairing(repo, codigo)).rejects.toBeInstanceOf(ErroAutenticacao);
  });

  it("SDR não pareia (só closer/gestor/admin)", async () => {
    const repo = new RepositorioMemoria();
    await expect(gerarCodigoPairing(repo, { ...closer, papel: "sdr" }, 300)).rejects.toBeInstanceOf(ErroPermissao);
  });
});

describe("verificarJwtSupabase", () => {
  const segredo = "super-secret-jwt-token-with-at-least-32-characters-long";
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const assinar = (payload: Record<string, unknown>, s = segredo) => {
    const cab = b64({ alg: "HS256", typ: "JWT" });
    const corpo = b64(payload);
    const ass = createHmac("sha256", s).update(`${cab}.${corpo}`).digest("base64url");
    return `${cab}.${corpo}.${ass}`;
  };

  it("aceita token válido e extrai claims", () => {
    const t = assinar({ sub: "abc", email: "x@y.com", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 60, qs_user_id: closer.id });
    const c = verificarJwtSupabase(t, segredo);
    expect(c.email).toBe("x@y.com");
    expect(c.qs_user_id).toBe(closer.id);
  });

  it("rejeita assinatura errada, expirado e alg diferente", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(() => verificarJwtSupabase(assinar({ sub: "a", exp }, "outro-segredo-qualquer-com-32-caracteres!!"), segredo)).toThrow(ErroAutenticacao);
    expect(() => verificarJwtSupabase(assinar({ sub: "a", exp: exp - 120 }), segredo)).toThrow(/expirado/);
    const semAlg = `${b64({ alg: "none" })}.${b64({ sub: "a", exp })}.x`;
    expect(() => verificarJwtSupabase(semAlg, segredo)).toThrow(/algoritmo/);
  });
});
