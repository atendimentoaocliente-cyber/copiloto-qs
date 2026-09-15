/**
 * Smoke test pós-deploy, no contrato da extensão v2.
 *
 * Sempre: /health, /v1/auth/eu e /v1/reunioes com o JWT.
 * Com --lead e --reuniao (um lead "Smoke Test" fixo no QS): registra consentimento,
 * abre o WebSocket (?token= + "qscopilot.v1"), manda `sessao.iniciar` + 2 s de
 * frames silenciosos, exige `pronto` no prazo e encerra.
 *
 *   npx tsx scripts/smoke-ws.ts --url wss://host/v1/stream --token <jwt> [--lead <uuid> --reuniao <uuid>] [--max-latency-ms 2500]
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? ""] : [])).filter((p) => p.length));
const url = args.url ?? "ws://localhost:8787/v1/stream";
const token = args.token ?? "";
const maxLatencia = Number(args["max-latency-ms"] ?? 2500);
const http = url.replace(/^ws/, "http").replace(/\/v1\/stream$/, "");
if (!token) {
  console.error("faltou --token");
  process.exit(2);
}
const cab = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-copiloto-versao": "smoke" };
const falhar = (m: string): never => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

const saude = await fetch(`${http}/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
if (!saude.ok) falhar("/health não está ok");
console.log("✓ /health ok");
const eu = await fetch(`${http}/v1/auth/eu`, { headers: cab });
if (eu.status !== 200) falhar(`/v1/auth/eu → ${eu.status}`);
console.log("✓ JWT válido");
const reunioes = await fetch(`${http}/v1/reunioes?dia=hoje`, { headers: cab });
if (reunioes.status !== 200) falhar(`/v1/reunioes → ${reunioes.status}`);
console.log(`✓ /v1/reunioes (${((await reunioes.json()) as unknown[]).length} hoje)`);

if (!args.lead || !args.reuniao) {
  console.log("· sem --lead/--reuniao: pulando a sessão WebSocket");
  process.exit(0);
}

const consent = await fetch(`${http}/v1/consentimentos`, {
  method: "POST",
  headers: cab,
  body: JSON.stringify({ reuniaoId: args.reuniao, leadId: args.lead, confirmadoEm: new Date().toISOString(), textoVersao: "smoke" }),
});
if (consent.status !== 201) falhar(`/v1/consentimentos → ${consent.status}`);
const { id: consentimentoId } = (await consent.json()) as { id: string };

const sessaoId = randomUUID();
const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`, "qscopilot.v1");
const t0 = Date.now();
const prazo = setTimeout(() => falhar(`sem 'pronto' em ${maxLatencia * 4} ms`), maxLatencia * 4);

function frame(pcm: Buffer, seq: number): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt8(1, 0);
  h.writeUInt32LE(seq, 4);
  return Buffer.concat([h, pcm]);
}

ws.on("open", () => {
  ws.send(JSON.stringify({
    tipo: "sessao.iniciar", versao: 1, sessaoId, reuniaoId: args.reuniao, leadId: args.lead, consentimentoId, plataforma: "outro",
    audio: { codificacao: "linear16", taxaAmostragem: 16000, canais: 2, temMicrofone: true },
    cliente: { versaoExtensao: "smoke", chrome: "-", so: process.platform },
  }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d.toString()) as { tipo: string; texto?: string; fatal?: boolean };
  if (m.tipo === "pronto") {
    const ms = Date.now() - t0;
    console.log(`✓ pronto em ${ms} ms (sessão ${sessaoId})`);
    if (ms > maxLatencia) falhar(`handshake acima de ${maxLatencia} ms`);
    clearTimeout(prazo);
    const silencio = Buffer.alloc(4096);
    for (let i = 0; i < 30; i++) ws.send(frame(silencio, i));
    setTimeout(() => {
      ws.send(JSON.stringify({ tipo: "encerrar", sessaoId, motivo: "closer" }));
      ws.close(1000, "smoke");
      console.log("✓ encerrada");
      process.exit(0);
    }, 500);
  } else if (m.tipo === "erro" && m.fatal) falhar(`erro fatal: ${m.texto}`);
});
ws.on("close", (c) => {
  if (c !== 1000) falhar(`socket fechou com ${c}`);
});
ws.on("error", (e) => falhar(e.message));
