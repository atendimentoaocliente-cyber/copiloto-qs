import { describe, expect, it } from "vitest";
import { FLAG_REENVIADO, TAMANHO_CABECALHO, VERSAO_FRAME, lerFrame } from "../../src/tipos/protocolo.js";
import { ErroValidacao } from "../../src/util/erros.js";

function frame(pcmBytes: number, seq: number, flags = 0, versao = VERSAO_FRAME): Buffer {
  const b = Buffer.alloc(TAMANHO_CABECALHO + pcmBytes);
  b.writeUInt8(versao, 0);
  b.writeUInt8(flags, 1);
  b.writeUInt32LE(seq, 4);
  return b;
}

describe("lerFrame — cabeçalho de 8 bytes do contrato qscopilot.v1", () => {
  it("lê seq, flag reenviado e devolve só o PCM", () => {
    const f = lerFrame(frame(4096, 4_000_000_001, FLAG_REENVIADO));
    expect(f.seq).toBe(4_000_000_001);
    expect(f.reenviado).toBe(true);
    expect(f.pcm.length).toBe(4096);
    expect(lerFrame(frame(4096, 7)).reenviado).toBe(false);
  });
  it("rejeita versão desconhecida, frame curto e PCM que não fecha em amostras estéreo", () => {
    expect(() => lerFrame(frame(4096, 1, 0, 2))).toThrow(ErroValidacao);
    expect(() => lerFrame(Buffer.alloc(3))).toThrow(/bytes/);
    expect(() => lerFrame(frame(4097, 1))).toThrow(/estéreo/);
  });
});
