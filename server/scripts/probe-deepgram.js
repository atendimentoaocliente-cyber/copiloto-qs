/**
 * Valida a chave do Deepgram e descobre qual modelo funciona melhor em pt-BR
 * ANTES de você perder tempo testando numa call real.
 *
 * Gera 3 segundos de áudio sintético e tenta conectar com cada modelo.
 * Uso:  npm run probe
 */

import WebSocket from "ws";

const CHAVE = process.env.DEEPGRAM_API_KEY;
if (!CHAVE) {
  console.error("❌ Falta DEEPGRAM_API_KEY no .env");
  process.exit(1);
}

const MODELOS = ["nova-3", "nova-2", "nova-2-general"];

function audioDeTeste() {
  // 2 segundos de silêncio com um tom baixo — só para abrir o stream
  const amostras = 16000 * 2 * 2; // 2s, 2 canais
  const buf = Buffer.alloc(amostras * 2);
  for (let i = 0; i < amostras; i++) {
    buf.writeInt16LE(Math.round(Math.sin(i / 40) * 600), i * 2);
  }
  return buf;
}

function testar(modelo) {
  return new Promise((resolve) => {
    const p = new URLSearchParams({
      model: modelo,
      language: "pt-BR",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "2",
      multichannel: "true",
    });
    const inicio = Date.now();
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${p}`, {
      headers: { Authorization: `Token ${CHAVE}` },
    });

    const prazo = setTimeout(() => {
      ws.close();
      resolve({ modelo, ok: false, erro: "timeout" });
    }, 8000);

    ws.on("open", () => {
      ws.send(audioDeTeste());
      setTimeout(() => ws.send(JSON.stringify({ type: "CloseStream" })), 200);
    });

    ws.on("message", (bruto) => {
      const msg = JSON.parse(bruto.toString());
      if (msg.type === "Results" || msg.type === "Metadata") {
        clearTimeout(prazo);
        ws.close();
        resolve({ modelo, ok: true, ms: Date.now() - inicio });
      }
    });

    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(prazo);
      resolve({ modelo, ok: false, erro: `HTTP ${res.statusCode}` });
    });

    ws.on("error", (err) => {
      clearTimeout(prazo);
      resolve({ modelo, ok: false, erro: err.message });
    });
  });
}

console.log("\nTestando modelos do Deepgram em pt-BR…\n");
const aprovados = [];
for (const modelo of MODELOS) {
  const r = await testar(modelo);
  if (r.ok) {
    aprovados.push(modelo);
    console.log(`  ✅ ${modelo.padEnd(16)} conectou em ${r.ms} ms`);
  } else {
    console.log(`  ❌ ${modelo.padEnd(16)} ${r.erro}`);
  }
}

if (aprovados.length) {
  console.log(`\n👉 Use no .env:  DEEPGRAM_MODEL=${aprovados[0]}\n`);
} else {
  console.log("\n⚠️  Nenhum modelo respondeu. Verifique a chave e o saldo.\n");
  process.exit(1);
}
