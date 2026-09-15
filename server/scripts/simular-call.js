/**
 * Simula uma call de venda completa contra o servidor.
 *
 * Gera as falas com as vozes do macOS, coloca o LEAD no canal 0 e o
 * CLOSER no canal 1 — exatamente como a extensão faz — e envia em tempo
 * real. No fim, a call aparece em /calls.html como qualquer call de verdade.
 *
 * Uso:  npm run simular
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const VOZ_LEAD = "Luciana";
const VOZ_CLOSER = "Joana";
const dir = mkdtempSync(join(tmpdir(), "sim-"));

// Diálogo realista de venda de viagem de alto ticket
const DIALOGO = [
  ["closer", "Oi Marina, tudo bem? Antes da gente começar, esta reunião é gravada e transcrita, e a gente usa uma ferramenta de inteligência artificial para montar seu roteiro. Tudo bem para você?"],
  ["lead",   "Tudo bem, sem problema."],
  ["closer", "Perfeito. Me conta, para quando vocês estão pensando nessa viagem?"],
  ["lead",   "A gente queria ir para a Capadócia em julho, eu e meu marido, para comemorar dez anos de casados."],
  ["closer", "Que ocasião linda. Já montei esse roteiro para vários casais. Deixa eu te apresentar o que eu pensei."],
  ["lead",   "Olha, achei meio caro esse pacote. Está bem acima do que eu tinha imaginado."],
  ["closer", "Entendo. Me diz uma coisa, caro comparado a quê? O que você tinha em mente?"],
  ["lead",   "É que eu vi bem mais barato no site do hotel direto, sabe."],
  ["closer", "Faz sentido você comparar. A diferença é que ali é só a hospedagem, e aqui entra voo, traslado, seguro e assistência."],
  ["lead",   "Entendi. E dá para parcelar em quantas vezes?"],
  ["closer", "Dá para montar do jeito que caiba no seu mês. Quanto você imaginava por parcela?"],
  ["lead",   "Preciso ver isso com calma. Vou falar com o meu marido e depois eu te retorno."],
  ["closer", "Claro, faz todo sentido decidirem juntos. O que ele precisa ouvir para ficar tão seguro quanto você?"],
  ["lead",   "Ele sempre pergunta o que acontece se precisar cancelar."],
  ["closer", "Ótima pergunta. Tem política de remarcação e o seguro cobre imprevisto. Te explico as duas agora."],
  ["lead",   "Então tá. Como faço para fechar? Quero garantir logo essa data de julho."],
];

const FALAS = DIALOGO;

function pcmMono(voz, frase) {
  const aiff = join(dir, "s.aiff");
  const wav = join(dir, "s.wav");
  execFileSync("say", ["-v", voz, "-o", aiff, frase]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const b = readFileSync(wav);
  let p = 12;
  while (p < b.length - 8) {
    const id = b.toString("ascii", p, p + 4);
    const sz = b.readUInt32LE(p + 4);
    if (id === "data") { p += 8; break; }
    p += 8 + sz;
  }
  return b.subarray(p);
}

/** Coloca a fala no canal certo: lead = 0, closer = 1 */
function paraEstereo(mono, canal) {
  const n = Math.floor(mono.length / 2);
  const st = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = mono.readInt16LE(i * 2);
    st.writeInt16LE(canal === 0 ? v : 0, i * 4);
    st.writeInt16LE(canal === 1 ? v : 0, i * 4 + 2);
  }
  return st;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket("ws://localhost:8787/ws");
let sugestoes = 0;

ws.on("open", async () => {
  console.log("\n🎬 Simulando call de venda…\n" + "─".repeat(64));
  ws.send(JSON.stringify({
    tipo: "config", canais: 2, taxaAmostragem: 16000, temMicrofone: true,
  }));
  ws.send(JSON.stringify({
    tipo: "identificar", leadNome: "Marina (simulação)", closerNome: "Everton",
  }));

  for (const [quem, frase] of FALAS) {
    const canal = quem === "lead" ? 0 : 1;
    const audio = paraEstereo(pcmMono(quem === "lead" ? VOZ_LEAD : VOZ_CLOSER, frase), canal);

    process.stdout.write(`\n  ${quem === "lead" ? "LEAD  " : "CLOSER"} │ ${frase.slice(0, 58)}…\n`);

    for (let i = 0; i < audio.length; i += 4096) {
      ws.send(audio.subarray(i, i + 4096));
      await espera(64);
    }
    // pausa natural entre falas — é ela que fecha o turno no Deepgram
    const silencio = Buffer.alloc(4096);
    for (let k = 0; k < 18; k++) { ws.send(silencio); await espera(64); }
  }

  await espera(2500);
  ws.close();
});

ws.on("message", (b) => {
  const m = JSON.parse(b.toString());
  if (m.tipo === "sugestao") {
    sugestoes++;
    console.log(`         ⚡ ${m.categoria} (${m.fonte}) → "${m.resposta}"`);
  }
});

ws.on("close", async () => {
  console.log("\n" + "─".repeat(64));
  console.log("Aguardando o resumo pós-call…");
  await espera(9000);

  const calls = await (await fetch("http://localhost:8787/api/calls")).json();
  const c = calls[0];
  if (!c) { console.log("nenhuma call salva"); process.exit(1); }

  console.log(`\n📞 Call salva`);
  console.log(`   duração   : ${(c.duracaoMs / 60000).toFixed(1)} min`);
  console.log(`   turnos    : ${c.totalTurnos}`);
  console.log(`   objeções  : ${c.objecoes}`);
  console.log(`   custo     : R$ ${c.custoBrl.toFixed(3)}`);
  if (c.resumo) {
    console.log(`\n🧠 Resumo (IA)`);
    console.log(`   ${c.resumo.resumo}`);
    console.log(`   temperatura   : ${c.resumo.temperatura}`);
    console.log(`   próximo passo : ${c.resumo.proximoPasso}`);
  } else {
    console.log(`\n⚠️  Sem resumo — análise por IA desligada (falta ANTHROPIC_API_KEY)`);
  }

  const obj = await (await fetch("http://localhost:8787/api/objecoes")).json();
  console.log(`\n📊 Catálogo de objeções`);
  for (const o of obj) console.log(`   ${String(o.total).padStart(2)}×  ${o.categoria}`);
  console.log(`\n→ Abra http://localhost:8787/calls.html\n`);
  process.exit(0);
});
