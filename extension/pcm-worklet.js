/**
 * AudioWorklet — converte o áudio dos 2 canais para PCM 16-bit a 16 kHz.
 *
 * Canal 0 = LEAD  (áudio da aba do Meet)
 * Canal 1 = CLOSER (microfone)
 *
 * O AudioContext roda na taxa nativa da placa (normalmente 48 kHz) porque
 * esse mesmo contexto devolve o áudio do lead para o fone do closer.
 * O downsample para 16 kHz acontece aqui dentro, com média móvel para
 * reduzir aliasing.
 */

const TAXA_ALVO = 16000;
const FRAMES_POR_ENVIO = 1024; // 1024 frames a 16 kHz = 64 ms por pacote

function paraInt16(amostra) {
  const v = Math.max(-1, Math.min(1, amostra));
  return v < 0 ? v * 0x8000 : v * 0x7fff;
}

class ProcessadorPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.razao = sampleRate / TAXA_ALVO; // ex.: 48000 / 16000 = 3
    this.fase = 0;
    this.somaLead = 0;
    this.somaCloser = 0;
    this.contador = 0;
    this.buffer = new Int16Array(FRAMES_POR_ENVIO * 2); // intercalado L,C,L,C...
    this.posicao = 0;
  }

  process(inputs) {
    const entrada = inputs[0];
    if (!entrada || entrada.length === 0) return true;

    const lead = entrada[0];
    const closer = entrada[1] || entrada[0];
    if (!lead) return true;

    for (let i = 0; i < lead.length; i++) {
      this.somaLead += lead[i];
      this.somaCloser += closer[i] || 0;
      this.contador++;
      this.fase += 1;

      if (this.fase >= this.razao) {
        this.fase -= this.razao;

        const mediaLead = this.somaLead / this.contador;
        const mediaCloser = this.somaCloser / this.contador;
        this.somaLead = 0;
        this.somaCloser = 0;
        this.contador = 0;

        this.buffer[this.posicao++] = paraInt16(mediaLead);
        this.buffer[this.posicao++] = paraInt16(mediaCloser);

        if (this.posicao >= this.buffer.length) {
          // transfere o ArrayBuffer (zero cópia)
          const pacote = this.buffer.slice();
          this.port.postMessage(pacote.buffer, [pacote.buffer]);
          this.posicao = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("processador-pcm", ProcessadorPcm);
