/**
 * Teste end-to-end sem precisar do Chrome.
 *
 * Gera fala em português com a voz do macOS, manda para o Deepgram
 * exatamente no mesmo formato que a extensão manda (PCM 16 kHz, 2 canais,
 * fala no canal 0 = lead) e mostra o que voltou + se o gatilho disparou.
 *
 * Valida de uma vez: qualidade do pt-BR, multichannel e detecção.
 *
 * Uso:  npm run teste
 */

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { detectar } from "../src/gatilhos.js";

const CHAVE = process.env.DEEPGRAM_API_KEY;
const MODELO = process.env.DEEPGRAM_MODEL ?? "nova-3";
const VOZ = process.env.VOZ_TESTE ?? "Luciana";

const FRASES = [
  "Achei meio caro esse pacote, viu.",
  "Vou falar com a minha esposa e depois eu te retorno.",
  "Dá para parcelar em quantas vezes?",
  "Me manda no WhatsApp que eu vejo com calma depois.",
  "E se eu precisar cancelar, como é que fica?",
  "Eu vi bem mais barato no site do hotel.",
  "O dólar está muito alto agora.",
  "Como faço para fechar? Quero garantir logo.",
  "Queria ir para a Capadócia com all inclusive.",
  "Punta Cana em julho tem vaga ainda?",
];

const dir = mkdtempSync(join(tmpdir(), "copiloto-"));

function gerarPcm(frase) {
  const aiff = join(dir, "f.aiff");
  const wav = join(dir, "f.wav");
  execFileSync("say", ["-v", VOZ, "-o", aiff, frase]);
  execFileSync("afconvert", [
    "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav,
  ]);
  const bruto = readFileSync(wav);

  // pula o cabeçalho WAV até o chunk "data"
  let pos = 12;
  while (pos < bruto.length - 8) {
    const id = bruto.toString("ascii", pos, pos + 4);
    const tamanho = bruto.readUInt32LE(pos + 4);
    if (id === "data") {
      pos += 8;
      break;
    }
    pos += 8 + tamanho;
  }
  const mono = bruto.subarray(pos);

  // intercala: canal 0 = lead (a fala), canal 1 = closer (silêncio)
  const amostras = Math.floor(mono.length / 2);
  const estereo = Buffer.alloc(amostras * 4);
  for (let i = 0; i < amostras; i++) {
    estereo.writeInt16LE(mono.readInt16LE(i * 2), i * 4);
    estereo.writeInt16LE(0, i * 4 + 2);
  }

  unlinkSync(aiff);
  unlinkSync(wav);
  return estereo;
}

function transcrever(pcm) {
  return new Promise((resolve) => {
    const p = new URLSearchParams({
      model: MODELO,
      language: process.env.DEEPGRAM_LANGUAGE ?? "multi",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "2",
      multichannel: "true",
      punctuate: "true",
      smart_format: "true",
      interim_results: "true",
      endpointing: "200",
    });
    for (const t of ["Capadócia", "all inclusive", "Punta Cana", "parcelar"]) {
      p.append(MODELO.startsWith("nova-3") ? "keyterm" : "keywords", t);
    }

    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${p}`, {
      headers: { Authorization: `Token ${CHAVE}` },
    });

    let finais = [];
    let inicio = 0;
    let primeiraResposta = null;
    const prazo = setTimeout(() => {
      ws.close();
      resolve({ texto: finais.join(" "), ms: primeiraResposta });
    }, 12000);

    ws.on("open", () => {
      inicio = Date.now();
      // envia em pedaços de 64 ms, imitando o ritmo real da extensão
      const passo = 1024 * 4;
      let i = 0;
      const timer = setInterval(() => {
        if (i >= pcm.length) {
          clearInterval(timer);
          ws.send(JSON.stringify({ type: "CloseStream" }));
          return;
        }
        ws.send(pcm.subarray(i, i + passo));
        i += passo;
      }, 64); // TEMPO REAL: 1024 frames @ 16 kHz = 64 ms.
      // O Deepgram usa o ritmo de chegada para detectar fim de fala.
      // Enviar mais rápido que o tempo real quebra o endpointing.
    });

    ws.on("message", (bruto) => {
      const msg = JSON.parse(bruto.toString());
      if (msg.type === "Results") {
        const t = msg.channel?.alternatives?.[0]?.transcript?.trim();
        if (t && primeiraResposta === null) primeiraResposta = Date.now() - inicio;
        if (t && msg.is_final) finais.push(t);
      }
      if (msg.type === "Metadata") {
        clearTimeout(prazo);
        ws.close();
        resolve({ texto: finais.join(" "), ms: primeiraResposta });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(prazo);
      resolve({ texto: "", erro: err.message });
    });
  });
}

console.log(`\nModelo: ${MODELO} · voz de teste: ${VOZ}\n${"─".repeat(72)}`);

let acertos = 0;
let disparos = 0;

for (const frase of FRASES) {
  const pcm = gerarPcm(frase);
  const { texto, ms, erro } = await transcrever(pcm);

  if (erro) {
    console.log(`❌ ${erro}`);
    continue;
  }

  const esperado = detectar(frase);
  const obtido = detectar(texto);
  const igual = normalizar(texto) === normalizar(frase);
  if (igual) acertos++;
  if (obtido) disparos++;

  console.log(`\n  falado : ${frase}`);
  console.log(`  ouvido : ${texto || "(nada)"}`);
  console.log(
    `  ${igual ? "✅ idêntico" : "≈ diferente"}   ` +
      `primeira resposta: ${ms ?? "?"} ms`
  );
  if (obtido) {
    console.log(`  ⚡ disparou: ${obtido.categoria} → "${obtido.resposta}"`);
  } else if (esperado) {
    console.log(`  ⚠️  deveria ter disparado: ${esperado.categoria}`);
  }
}

function normalizar(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

console.log(
  `\n${"─".repeat(72)}\n` +
    `Transcrição idêntica : ${acertos}/${FRASES.length}\n` +
    `Gatilhos disparados  : ${disparos}/${FRASES.length}\n`
);
