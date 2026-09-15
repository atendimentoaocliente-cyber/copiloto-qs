/**
 * Fila circular de áudio para sobreviver a quedas do WebSocket.
 *
 * Guarda os últimos N segundos de pacotes PCM (com o `seq` de cada um).
 * Quando o socket volta, tudo que ficou preso é reenviado com a flag
 * `reenviado`, para o gateway transcrever (a call não perde nada) sem
 * gerar sugestão ao vivo sobre fala do passado.
 */

export interface PacoteAudio {
  seq: number;
  pcm: ArrayBuffer;
}

export class FilaAudio {
  private itens: PacoteAudio[] = [];
  private readonly capacidade: number;

  /**
   * @param segundos       quanto áudio guardar
   * @param msPorPacote    duração de cada pacote (64 ms no worklet atual)
   */
  constructor(segundos: number, msPorPacote: number) {
    this.capacidade = Math.max(1, Math.ceil((segundos * 1000) / msPorPacote));
  }

  empurrar(p: PacoteAudio): void {
    this.itens.push(p);
    if (this.itens.length > this.capacidade) this.itens.shift();
  }

  /** Esvazia a fila devolvendo os pacotes em ordem. */
  drenar(): PacoteAudio[] {
    const tudo = this.itens;
    this.itens = [];
    return tudo;
  }

  limpar(): void {
    this.itens = [];
  }

  get tamanho(): number {
    return this.itens.length;
  }

  /** Segundos de áudio represados. */
  segundos(msPorPacote: number): number {
    return Math.round((this.itens.length * msPorPacote) / 1000);
  }
}
