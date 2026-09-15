/**
 * Copiloto QS — servidor.
 *
 *   extensão  --PCM 16kHz 2 canais-->  este servidor  -->  Deepgram
 *   extensão  <--transcrição+sugestão--  este servidor  <--  Deepgram
 *
 * Canal 0 = lead · Canal 1 = closer (multichannel, sem diarização por IA)
 *
 * Duas camadas de detecção rodando juntas:
 *   L1 gatilho literal  → instantâneo, pega a palavra exata
 *   L2 Claude Haiku 4.5 → ~700ms, entende a intenção
 *
 * Ao fim da call: resumo, objeções catalogadas e custo, salvos em dados/.
 */

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import estaticos from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { detectar } from "./gatilhos.js";
import { analisar, resumirCall, custoUsd, IA_ATIVA } from "./analise.js";
import { Sessao, listarCalls, lerCall } from "./sessoes.js";

const PORTA = Number(process.env.PORT ?? 8787);
const CHAVE = process.env.DEEPGRAM_API_KEY;
const MODELO = process.env.DEEPGRAM_MODEL ?? "nova-3";
const IDIOMA = process.env.DEEPGRAM_LANGUAGE ?? "multi";

if (!CHAVE) {
  console.error("\n❌ Falta DEEPGRAM_API_KEY no arquivo .env\n");
  process.exit(1);
}

const TERMOS = [
  "Maldivas", "Bora Bora", "Punta Cana", "Capadócia", "Phuket", "Krabi",
  "Fernando de Noronha", "all inclusive", "half board", "transfer",
  "Universal", "Epcot", "Magic Kingdom", "overwater", "seguro viagem",
  "eSIM", "Schengen", "ETIAS", "taxa de embarque", "pacote", "roteiro",
  "parcelamento", "sinal", "embarque", "cruzeiro", "traslado",
];

function urlDeepgram() {
  const p = new URLSearchParams({
    model: MODELO,
    language: IDIOMA,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "2",
    multichannel: "true",
    interim_results: "true",
    endpointing: "200",
    utterance_end_ms: "1000",
    punctuate: "true",
    smart_format: "true",
  });
  const chave = MODELO.startsWith("nova-3") ? "keyterm" : "keywords";
  for (const t of TERMOS) p.append(chave, t);
  return `wss://api.deepgram.com/v1/listen?${p}`;
}

const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
await app.register(websocket);
await app.register(estaticos, {
  root: join(dirname(fileURLToPath(import.meta.url)), "..", "publico"),
  prefix: "/",
});

// ── API de histórico ────────────────────────────────────────────────────────

app.get("/health", async () => ({
  ok: true, modelo: MODELO, idioma: IDIOMA, ia: IA_ATIVA,
}));

app.get("/api/calls", async () => listarCalls());

app.get("/api/calls/:id", async (req, reply) => {
  const call = lerCall(req.params.id);
  if (!call) return reply.code(404).send({ erro: "call não encontrada" });
  return call;
});

/** Catálogo agregado: quais objeções mais aparecem na operação */
app.get("/api/objecoes", async () => {
  const contagem = new Map();
  for (const resumo of listarCalls()) {
    const call = lerCall(resumo.id);
    for (const d of call?.deteccoes ?? []) {
      const atual = contagem.get(d.categoria) ??
        { categoria: d.categoria, total: 0, calls: new Set() };
      atual.total++;
      atual.calls.add(call.id);
      contagem.set(d.categoria, atual);
    }
  }
  return [...contagem.values()]
    .map((c) => ({ categoria: c.categoria, total: c.total, calls: c.calls.size }))
    .sort((a, b) => b.total - a.total);
});

// ── Conexão da extensão ─────────────────────────────────────────────────────

app.get("/ws", { websocket: true }, (conexao) => {
  const cliente = conexao.socket ?? conexao;
  const sessao = new Sessao();

  let deepgram = null;
  let pronto = false;
  let encerrando = false;
  let tentativas = 0;
  const fila = [];
  let inicioFalaLead = 0;

  console.log(`\n→ call iniciada  ${sessao.id.slice(0, 8)}`);

  function enviar(obj) {
    if (cliente.readyState === WebSocket.OPEN) cliente.send(JSON.stringify(obj));
  }

  // ── Deepgram com reconexão automática ─────────────────────────────────────
  function conectarDeepgram() {
    deepgram = new WebSocket(urlDeepgram(), {
      headers: { Authorization: `Token ${CHAVE}` },
    });

    deepgram.on("open", () => {
      pronto = true;
      tentativas = 0;
      console.log(`✓ Deepgram ok (${MODELO} · ${IDIOMA})`);
      while (fila.length) deepgram.send(fila.shift());
      enviar({ tipo: "pronto", modelo: MODELO, ia: IA_ATIVA });
    });

    deepgram.on("message", (bruto) => {
      let msg;
      try { msg = JSON.parse(bruto.toString()); } catch { return; }
      if (msg.type !== "Results") return;

      const texto = msg.channel?.alternatives?.[0]?.transcript?.trim();
      if (!texto) return;

      const falante = (msg.channel_index?.[0] ?? 0) === 0 ? "lead" : "closer";
      const final = Boolean(msg.is_final);

      enviar({ tipo: "transcricao", texto, falante, final });
      if (!final) {
        if (falante === "lead" && !inicioFalaLead) inicioFalaLead = Date.now();
        return;
      }

      sessao.registrarTurno(falante, texto);
      if (falante !== "lead") return;

      const latencia = inicioFalaLead ? Date.now() - inicioFalaLead : null;
      inicioFalaLead = 0;

      // L1 — gatilho literal, instantâneo
      const achado = detectar(texto);
      if (achado) {
        console.log(`  ⚡ ${achado.categoria} (${latencia ?? "?"}ms) "${texto}"`);
        const d = { ...achado, latenciaMs: latencia, fonte: "gatilho" };
        sessao.registrarDeteccao(d);
        enviar({ tipo: "sugestao", ...d });
      }

      // L2 — IA, entende a intenção mesmo sem a palavra óbvia
      if (IA_ATIVA) {
        analisar(texto, sessao.contexto()).then((ia) => {
          if (!ia) return;
          sessao.somarCustoIa(custoUsd(ia.tokens, "haiku"));
          if (!ia.agir) return;
          console.log(`  🧠 ${ia.categoria} [${ia.temperatura}] (${ia.latenciaIaMs}ms) → "${ia.resposta}"`);
          const d = {
            categoria: ia.categoria,
            resposta: ia.resposta,
            temperatura: ia.temperatura,
            latenciaMs: (latencia ?? 0) + ia.latenciaIaMs,
            fonte: "ia",
          };
          sessao.registrarDeteccao(d);
          enviar({ tipo: "sugestao", ...d });
        });
      }
    });

    deepgram.on("error", (err) => {
      console.error("✗ Deepgram:", err.message);
      enviar({ tipo: "erro", texto: "Transcrição: " + err.message });
    });

    deepgram.on("close", (codigo) => {
      pronto = false;
      if (encerrando) return;
      // queda no meio da call: reconecta com recuo progressivo
      tentativas++;
      if (tentativas > 6) {
        enviar({ tipo: "erro", texto: "Transcrição caiu e não reconectou." });
        return;
      }
      const espera = Math.min(500 * 2 ** (tentativas - 1), 8000);
      console.log(`  ↻ reconectando em ${espera}ms (tentativa ${tentativas}, código ${codigo})`);
      enviar({ tipo: "reconectando", tentativa: tentativas });
      setTimeout(conectarDeepgram, espera);
    });
  }

  conectarDeepgram();

  // ── Áudio da extensão ─────────────────────────────────────────────────────
  cliente.on("message", (dados, binario) => {
    if (!binario) {
      try {
        const msg = JSON.parse(dados.toString());
        if (msg.tipo === "config") {
          console.log(`  ${msg.canais} canais @ ${msg.taxaAmostragem}Hz` +
            (msg.temMicrofone ? "" : "  (sem microfone)"));
        }
        if (msg.tipo === "identificar") {
          sessao.leadNome = msg.leadNome ?? null;
          sessao.closerNome = msg.closerNome ?? null;
        }
      } catch {}
      return;
    }

    sessao.pacotes++;
    if (sessao.pacotes % 300 === 0) {
      console.log(`  … ${Math.round(sessao.pacotes * 0.064)}s`);
    }

    if (pronto && deepgram.readyState === WebSocket.OPEN) deepgram.send(dados);
    else if (fila.length < 300) fila.push(dados);
  });

  // ── Fim da call ───────────────────────────────────────────────────────────
  cliente.on("close", async () => {
    encerrando = true;

    // O Deepgram só marca is_final depois de silêncio ou de CloseStream.
    // Sem esperar por isso aqui, as últimas falas da call se perdem.
    await new Promise((resolve) => {
      if (!deepgram || deepgram.readyState !== WebSocket.OPEN) return resolve();
      const pronto = () => { clearTimeout(prazo); resolve(); };
      const prazo = setTimeout(() => { try { deepgram.close(); } catch {} resolve(); }, 5000);
      deepgram.once("close", pronto);
      try {
        deepgram.send(JSON.stringify({ type: "CloseStream" }));
      } catch { pronto(); }
    });

    sessao.encerrar();
    const min = (sessao.duracaoMs / 60000).toFixed(1);
    console.log(`← call encerrada  ${min}min · ${sessao.turnos.length} turnos · ${sessao.deteccoes.length} objeções`);

    if (IA_ATIVA && sessao.turnos.length >= 4) {
      console.log("  gerando resumo…");
      const resumo = await resumirCall(sessao.transcricaoCompleta());
      if (resumo) {
        sessao.resumo = resumo;
        sessao.somarCustoIa(custoUsd(resumo.tokens, "sonnet"));
        sessao.encerrar();
        console.log(`  ✓ ${String(resumo.temperatura).toUpperCase()} · ${resumo.proximoPasso ?? ""}`);
      }
    }

    const arquivo = sessao.salvar();
    console.log(`  💾 ${arquivo.split("/").pop()}  ·  R$ ${sessao.custo.totalBrl.toFixed(2)}\n`);
  });
});

await app.listen({ port: PORTA, host: "0.0.0.0" });
console.log(`
╭────────────────────────────────────────────────────╮
│  Copiloto QS                                       │
│  http://localhost:${PORTA}                             │
│  transcrição : ${(MODELO + " · " + IDIOMA).padEnd(34)}│
│  análise IA  : ${(IA_ATIVA ? "Haiku 4.5 + Sonnet 5" : "DESLIGADA (falta a chave)").padEnd(34)}│
│  histórico   : http://localhost:${PORTA}/calls.html     │
╰────────────────────────────────────────────────────╯
`);
