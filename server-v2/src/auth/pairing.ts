/**
 * Pairing: o closer gera um código de 6 dígitos no QS; a extensão troca o
 * código por um JWT do gateway. Uso único, TTL 5 min, guardado no banco
 * (as duas máquinas do Fly precisam enxergar o mesmo código).
 */
import { randomInt } from "node:crypto";
import type { RepositorioCopiloto, UsuarioQs } from "../db/repositorio.js";
import { ErroAutenticacao, ErroDependencia, ErroPermissao } from "../util/erros.js";

export const PAPEIS_QUE_PODEM_PAREAR = new Set(["closer", "gestor", "admin"]);

export async function gerarCodigoPairing(
  repo: Pick<RepositorioCopiloto, "salvarCodigoPairing">,
  closer: UsuarioQs,
  ttlSegundos: number,
  agora: () => number = Date.now,
): Promise<{ codigo: string; expiraEm: string }> {
  if (!closer.ativo) throw new ErroPermissao("usuário inativo");
  if (!PAPEIS_QUE_PODEM_PAREAR.has(closer.papel)) throw new ErroPermissao(`papel "${closer.papel}" não usa o copiloto`);
  const expiraEm = agora() + ttlSegundos * 1000;
  // Colisão de PK é raríssima (1e6 códigos, TTL 5 min), mas existe: tenta 3x.
  let ultimoErro: unknown;
  for (let i = 0; i < 3; i++) {
    const codigo = randomInt(0, 1_000_000).toString().padStart(6, "0");
    try {
      await repo.salvarCodigoPairing({ codigo, closerId: closer.id, expiraEm });
      return { codigo, expiraEm: new Date(expiraEm).toISOString() };
    } catch (err) {
      ultimoErro = err;
      if (!(err instanceof ErroDependencia) || !/duplicate|unique|pairing_codes_pkey/i.test(err.message)) throw err;
    }
  }
  throw new ErroDependencia("postgres", "não conseguiu gerar código único", ultimoErro);
}

export async function trocarCodigoPairing(
  repo: Pick<RepositorioCopiloto, "consumirCodigoPairing" | "buscarUsuario">,
  codigo: string,
): Promise<UsuarioQs> {
  const registro = await repo.consumirCodigoPairing(codigo);
  if (!registro) throw new ErroAutenticacao("código inválido, expirado ou já usado", undefined, "codigo_invalido_ou_expirado");
  const usuario = await repo.buscarUsuario(registro.closerId);
  if (!usuario || !usuario.ativo) throw new ErroAutenticacao("usuário do código não está ativo", undefined, "usuario_inativo");
  return usuario;
}
