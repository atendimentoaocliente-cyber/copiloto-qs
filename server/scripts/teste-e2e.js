// Teste ponta a ponta: simula a extensão enviando áudio real e verifica
// se a call é salva com transcrição, detecções e custo.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import WebSocket from "ws";

function pcm(frase) {
  execFileSync("say", ["-v","Luciana","-o","/tmp/e.aiff", frase]);
  execFileSync("afconvert", ["-f","WAVE","-d","LEI16@16000","-c","1","/tmp/e.aiff","/tmp/e.wav"]);
  const b = readFileSync("/tmp/e.wav");
  let p=12; while(p<b.length-8){const id=b.toString("ascii",p,p+4);const sz=b.readUInt32LE(p+4);if(id==="data"){p+=8;break;}p+=8+sz;}
  const mono=b.subarray(p), n=Math.floor(mono.length/2), st=Buffer.alloc(n*4);
  for(let i=0;i<n;i++){ st.writeInt16LE(mono.readInt16LE(i*2), i*4); st.writeInt16LE(0, i*4+2); }
  return st;
}

const FRASES = [
  "Achei meio caro esse pacote para a Capadócia.",
  "Vou falar com a minha esposa e depois eu te retorno.",
];

const ws = new WebSocket("ws://localhost:8787/ws");
const recebidas = { transcricao: 0, sugestao: 0 };

ws.on("open", async () => {
  ws.send(JSON.stringify({ tipo:"config", canais:2, taxaAmostragem:16000, temMicrofone:true }));
  for (const f of FRASES) {
    const dados = pcm(f);
    for (let i=0; i<dados.length; i+=4096) {
      ws.send(dados.subarray(i, i+4096));
      await new Promise(r => setTimeout(r, 64));
    }
    // silêncio real entre as frases — é o que dispara o is_final
    const silencio = Buffer.alloc(4096);
    for (let k = 0; k < 25; k++) { ws.send(silencio); await new Promise(r => setTimeout(r, 64)); }
  }
  await new Promise(r => setTimeout(r, 2500));
  ws.close();
});

ws.on("message", (b) => {
  const m = JSON.parse(b.toString());
  if (m.tipo === "transcricao" && m.final) { recebidas.transcricao++; console.log(`  [${m.falante}] ${m.texto}`); }
  if (m.tipo === "sugestao") { recebidas.sugestao++; console.log(`  ⚡ ${m.categoria} (${m.fonte}, ${m.latenciaMs}ms)`); }
});

ws.on("close", async () => {
  await new Promise(r => setTimeout(r, 2500));
  const calls = await (await fetch("http://localhost:8787/api/calls")).json();
  console.log(`\n── RESULTADO ──`);
  console.log(`transcrições finais : ${recebidas.transcricao}`);
  console.log(`sugestões recebidas : ${recebidas.sugestao}`);
  console.log(`calls salvas        : ${calls.length}`);
  if (calls.length) {
    const c = calls[0];
    console.log(`última call         : ${c.totalTurnos} turnos · ${c.objecoes} objeções · R$ ${c.custoBrl.toFixed(4)}`);
  }
  const obj = await (await fetch("http://localhost:8787/api/objecoes")).json();
  console.log(`catálogo objeções   : ${obj.map(o=>o.categoria+"("+o.total+")").join(", ") || "vazio"}`);
  process.exit(0);
});
