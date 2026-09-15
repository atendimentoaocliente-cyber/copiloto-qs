/**
 * Teste de integração — reproduz uma sessão gravada de ponta a ponta, no
 * contrato da extensão v2 (`qscopilot.v1`):
 *
 *   parear (código→JWT) → reuniões → briefing → consentimento → WebSocket
 *   ?token= + subprotocolo → `sessao.iniciar` → frames [8 B + PCM] → STT de
 *   fixture → motor (L0 chip pendente → L1/L2/L3 completam o mesmo id) →
 *   queda do socket + `sessao.retomar` → `encerrar` (a extensão fecha em
 *   seguida) → gateway ESPERA a finalização do STT → pós-call no QS.
 *
 * Determinístico: STT de fixture, IA falsa, repositório em memória.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { criarApp, type AppMontado } from "../../src/app.js";
import { RepositorioMemoria } from "../../src/db/memoria.js";
import type { UsuarioQs } from "../../src/db/repositorio.js";
import { EmbedderDeterministico } from "../../src/motor/embeddings.js";
import { CachePlaybook } from "../../src/motor/playbook.js";
import { FECHAMENTO, SUBPROTOCOLO, TAMANHO_CABECALHO, VERSAO_FRAME, type MensagemGateway, type SugestaoCard } from "../../src/tipos/protocolo.js";
import { configTeste, logTeste, metricasTeste } from "../apoio/ambiente.js";
import { IaFalsa } from "../apoio/ia-falsa.js";
import { BYTES_POR_MS, ProvedorSttFixture, type EventoFixture } from "../apoio/stt-fixture.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(aqui, "..", "fixtures", "call-capadocia.json"), "utf8")) as { eventos: EventoFixture[] };

const closer: UsuarioQs & { senha: string } = {
  id: "11111111-1111-4111-8111-111111111111",
  nome: "Joana Closer",
  email: "joana@inovvatur.com.br",
  papel: "closer",
  ativo: true,
  senha: "senha-ficticia-de-teste",
};
const LEAD_ID = "22222222-2222-4222-8222-222222222222";
const REUNIAO_ID = "33333333-3333-4333-8333-333333333333";
const hojeSP = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

type Card = SugestaoCard & { tipo: "sugestao" };

/** Monta um frame como `montarFrame` da extensão (cabeçalho de 8 bytes + PCM). */
function frame(pcm: Buffer, seq: number, reenviado = false): Buffer {
  const cab = Buffer.alloc(TAMANHO_CABECALHO);
  cab.writeUInt8(VERSAO_FRAME, 0);
  cab.writeUInt8(reenviado ? 1 : 0, 1);
  cab.writeUInt32LE(seq >>> 0, 4);
  return Buffer.concat([cab, pcm]);
}

async function ate(cond: () => boolean, prazoMs = 8000, passoMs = 25): Promise<void> {
  const fim = Date.now() + prazoMs;
  while (!cond()) {
    if (Date.now() > fim) throw new Error("condição não satisfeita no prazo");
    await new Promise((r) => setTimeout(r, passoMs));
  }
}

class Cliente {
  readonly recebidas: MensagemGateway[] = [];
  private readonly ouvintes = new Set<(m: MensagemGateway) => void>();
  readonly ws: WebSocket;
  readonly fechado: Promise<number>;
  seq = 0;
  constructor(url: string, protocolo: string | string[] = SUBPROTOCOLO) {
    this.ws = new WebSocket(url, protocolo);
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as MensagemGateway;
      this.recebidas.push(m);
      for (const cb of [...this.ouvintes]) cb(m);
    });
    this.fechado = new Promise((res) => this.ws.on("close", (c) => res(c)));
  }
  aberto(): Promise<void> {
    return new Promise((res) => this.ws.on("open", () => res()));
  }
  enviar(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  audio(pcm: Buffer, reenviado = false): void {
    this.ws.send(frame(pcm, this.seq++, reenviado));
  }
  esperar<T extends MensagemGateway>(pred: (m: MensagemGateway) => m is T, prazoMs = 8000): Promise<T>;
  esperar(pred: (m: MensagemGateway) => boolean, prazoMs?: number): Promise<MensagemGateway>;
  esperar(pred: (m: MensagemGateway) => boolean, prazoMs = 8000): Promise<MensagemGateway> {
    return new Promise((res, rej) => {
      const ja = this.recebidas.find(pred);
      if (ja) return res(ja);
      const t = setTimeout(() => rej(new Error(`esperava mensagem: ${pred.toString().slice(0, 90)}`)), prazoMs);
      const cb = (m: MensagemGateway) => {
        if (pred(m)) {
          clearTimeout(t);
          this.ouvintes.delete(cb);
          res(m);
        }
      };
      this.ouvintes.add(cb);
    });
  }
  cards(): Card[] {
    return this.recebidas.filter((m): m is Card => m.tipo === "sugestao");
  }
}

describe("sessão gravada — ponta a ponta (contrato extensão v2)", () => {
  let montado: AppMontado;
  let repo: RepositorioMemoria;
  let ia: IaFalsa;
  let provedores: ProvedorSttFixture[];
  let base: string;
  let wsBase: string;
  let token: string;
  let consentimentoId: string;

  beforeAll(async () => {
    const cfg = configTeste();
    const log = logTeste();
    const metricas = metricasTeste();
    repo = new RepositorioMemoria({
      usuarios: new Map([[closer.id, closer]]),
      reunioes: [{ id: REUNIAO_ID, leadId: LEAD_ID, leadNome: "Marina Souza", inicio: `${hojeSP}T13:00:00.000Z`, sdrNome: "Carlos SDR", closerId: closer.id }],
      briefings: new Map([
        [
          LEAD_ID,
          {
            lead: { id: LEAD_ID, nome: "Marina Souza", primeiroNome: "Marina", cidade: "São Paulo/SP", status: "em_prospeccao", ownerId: closer.id, empresa: null, valorEstimado: 32000 },
            handover: { resumo: "Casal, 10 anos de casados, quer Capadócia em julho", notas: ["Prefere contato à noite"], sdrNome: "Carlos SDR", criadoEm: new Date().toISOString() },
            produto: { nome: "Capadócia Romântica", destino: "Capadócia", periodo: "julho" },
            historico: [{ data: new Date().toISOString(), tipo: "nota", descricao: "Lead pediu proposta por WhatsApp", autor: "Carlos SDR" }],
            ultimasCalls: [],
          },
        ],
      ]),
    });
    const playbook = new CachePlaybook(repo, log, metricas, 1e9);
    await playbook.iniciar();
    ia = new IaFalsa();
    provedores = [];
    montado = await criarApp({
      cfg,
      log,
      repo,
      playbook,
      ia,
      embedder: new EmbedderDeterministico(16),
      metricas,
      fabricaStt: (op) => {
        const p = new ProvedorSttFixture(fixture.eventos, op);
        provedores.push(p);
        return p;
      },
    });
    await montado.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = montado.app.server.address();
    base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
    wsBase = base.replace("http", "ws");
  });

  afterAll(async () => {
    await montado.app.close();
  });

  const json = (caminho: string, init: RequestInit & { token?: string } = {}) =>
    fetch(`${base}${caminho}`, {
      ...init,
      // Como o `chamar()` da extensão: Content-Type só quando há corpo.
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), "x-copiloto-versao": "2.0.0", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    });

  it("parear: e-mail+senha (legado) → código → POST /v1/dispositivos/parear → JWT com dispositivoId", async () => {
    const r1 = await json("/v1/pairing/codigo", { method: "POST", body: JSON.stringify({ email: closer.email, senha: closer.senha }) });
    expect(r1.status).toBe(201);
    const { codigo } = (await r1.json()) as { codigo: string };
    expect(codigo).toMatch(/^\d{6}$/);

    const impressao = "9f1c2a3b-0000-4000-8000-aaaaaaaaaaaa";
    const r2 = await json("/v1/dispositivos/parear", { method: "POST", body: JSON.stringify({ codigo, rotulo: "Chrome · macOS", impressao }) });
    expect(r2.status).toBe(200);
    const cred = (await r2.json()) as { token: string; expiraEm: string; dispositivoId: string; usuario: { id: string; nome: string; papel: string } };
    expect(cred.usuario).toEqual({ id: closer.id, nome: closer.nome, papel: "closer" });
    expect(cred.dispositivoId).toBe(impressao);
    expect(cred.expiraEm).toMatch(/^\d{4}-/);
    token = cred.token;

    // Código é uso único, com o código de erro que a extensão traduz.
    const r3 = await json("/v1/dispositivos/parear", { method: "POST", body: JSON.stringify({ codigo, rotulo: "x", impressao }) });
    expect(r3.status).toBe(401);
    expect(((await r3.json()) as { erro: string }).erro).toBe("codigo_invalido_ou_expirado");

    const r4 = await json("/v1/dispositivos/renovar", { method: "POST", token });
    expect(r4.status).toBe(200);
    const novo = (await r4.json()) as { token: string; expiraEm: string };
    expect(novo.token).toBeTypeOf("string");

    const semToken = await json("/v1/dispositivos/renovar", { method: "POST" });
    expect(semToken.status).toBe(401);
    expect(((await semToken.json()) as { erro: string }).erro).toBe("unauthorized");
  });

  it("GET /v1/reunioes?dia=hoje, GET /v1/leads/:id/briefing e POST /v1/consentimentos", async () => {
    const r = await json("/v1/reunioes?dia=hoje", { token });
    expect(r.status).toBe(200);
    const reunioes = (await r.json()) as Array<{ id: string; leadId: string; leadNome: string; inicio: string; sdrNome?: string }>;
    expect(reunioes).toHaveLength(1);
    expect(reunioes[0]).toMatchObject({ id: REUNIAO_ID, leadId: LEAD_ID, leadNome: "Marina Souza", sdrNome: "Carlos SDR" });

    const b = await json(`/v1/leads/${LEAD_ID}/briefing?reuniaoId=${REUNIAO_ID}`, { token });
    expect(b.status).toBe(200);
    const briefing = (await b.json()) as { lead: { nome: string; primeiroNome: string }; handover: { resumo: string; sdrNome: string }; produto: { destino: string }; playbook: { totalObjecoes: number }; historico: unknown[] };
    expect(briefing.lead).toMatchObject({ nome: "Marina Souza", primeiroNome: "Marina" });
    expect(briefing.handover.resumo).toContain("Capadócia");
    expect(briefing.produto.destino).toBe("Capadócia");
    expect(briefing.playbook.totalObjecoes).toBeGreaterThan(10);
    expect((briefing as unknown as { lead: { ownerId?: string } }).lead.ownerId).toBeUndefined(); // não vaza campo interno

    const c = await json("/v1/consentimentos", {
      method: "POST",
      token,
      body: JSON.stringify({ reuniaoId: REUNIAO_ID, leadId: LEAD_ID, confirmadoEm: new Date().toISOString(), textoVersao: "2026-09-v1" }),
    });
    expect(c.status).toBe(201);
    consentimentoId = ((await c.json()) as { id: string }).id;
    expect(consentimentoId).toMatch(/[0-9a-f-]{36}/);
    const gravado = repo.estado.consentimentos.get(consentimentoId)!;
    expect(gravado).toMatchObject({ closerId: closer.id, leadId: LEAD_ID, meetingId: REUNIAO_ID, aceito: true, textoVersao: "2026-09-v1", versaoExtensao: "2.0.0" });
  });

  it("WebSocket sem token fecha com 4401; consentimento inválido fecha com 4404", async () => {
    const c1 = new Cliente(`${wsBase}/v1/stream`);
    expect(await c1.fechado).toBe(FECHAMENTO.naoAutorizado);

    const c2 = new Cliente(`${wsBase}/v1/stream?token=${encodeURIComponent(token)}`);
    await c2.aberto();
    c2.enviar({
      tipo: "sessao.iniciar", versao: 1, sessaoId: "44444444-4444-4444-8444-444444444444", reuniaoId: REUNIAO_ID, leadId: LEAD_ID,
      consentimentoId: "55555555-5555-4555-8555-555555555555", plataforma: "google_meet",
      audio: { codificacao: "linear16", taxaAmostragem: 16000, canais: 2, temMicrofone: true },
      cliente: { versaoExtensao: "2.0.0", chrome: "129", so: "MacIntel" },
    });
    const erro = await c2.esperar((m) => m.tipo === "erro");
    expect((erro as { codigo?: string }).codigo).toBe("consentimento_invalido");
    expect(await c2.fechado).toBe(FECHAMENTO.sessaoInvalida);
  });

  it("reproduz a call: frames, cards (pendente → completo), retirada, retomada de sessão, finalização e pós-call", async () => {
    const sessaoId = "66666666-6666-4666-8666-666666666666";
    const iniciar = {
      tipo: "sessao.iniciar", versao: 1, sessaoId, reuniaoId: REUNIAO_ID, leadId: LEAD_ID, consentimentoId, plataforma: "google_meet",
      audio: { codificacao: "linear16", taxaAmostragem: 16000, canais: 2, temMicrofone: true },
      cliente: { versaoExtensao: "2.0.0", chrome: "129.0", so: "MacIntel" },
    };
    let c = new Cliente(`${wsBase}/v1/stream?token=${encodeURIComponent(token)}`);
    await c.aberto();
    expect(c.ws.protocol).toBe(SUBPROTOCOLO);
    c.enviar(iniciar);
    const pronto = await c.esperar((m): m is Extract<MensagemGateway, { tipo: "pronto" }> => m.tipo === "pronto");
    expect(pronto).toMatchObject({ sessaoId, ia: true, heartbeatMs: 10000 });
    expect(pronto.modelo).toContain("claude-haiku-4-5");

    c.enviar({ tipo: "ping", ts: 123 });
    const pong = await c.esperar((m): m is Extract<MensagemGateway, { tipo: "pong" }> => m.tipo === "pong");
    expect(pong.ts).toBe(123);

    // Áudio silencioso cobrindo toda a call, em frames de 64 ms (4096 B de PCM), como a extensão manda.
    const ultimo = Math.max(...fixture.eventos.filter((e) => !e.soAoFinalizar).map((e) => e.aoMs)) + 1000;
    const total = Buffer.alloc(ultimo * BYTES_POR_MS);
    const byteEm = (ms: number) => Math.floor((ms * BYTES_POR_MS) / 4096) * 4096;
    // Cede o event loop a cada ~0,5 s de áudio: o `ws` entrega as mensagens de um mesmo chunk TCP de forma
    // síncrona, e sem ceder várias falas do lead cairiam num único burst (em produção chegam a cada 64 ms).
    const enviarTrecho = async (cli: Cliente, de: number, ate: number, reenviado = false) => {
      let n = 0;
      for (let off = de; off < ate; off += 4096) {
        cli.audio(total.subarray(off, Math.min(off + 4096, ate)), reenviado);
        if (++n % 8 === 0) await new Promise((r) => setImmediate(r));
      }
    };
    // Trecho 1 (ao vivo): até pouco antes da fala "parcelar" (82 s).
    const corte = byteEm(79_000);
    await enviarTrecho(c, 0, corte);
    await c.esperar((m) => m.tipo === "transcricao" && m.final && m.texto.startsWith("É que eu vi bem mais barato"));
    // Última fala do trecho 1 (closer, 70 s): garante que nada fica "a caminho" quando o socket cair.
    await c.esperar((m) => m.tipo === "transcricao" && m.final && m.texto.startsWith("Faz sentido você comparar"));

    // ── Queda de internet: socket morre sem `encerrar`; a call continua viva no gateway. ──
    const seqAntes = c.seq;
    const recebidasAntes = [...c.recebidas];
    c.ws.terminate();
    await c.fechado;
    await ate(() => montado.registro.total === 1, 2000); // a call NÃO foi encerrada
    c = new Cliente(`${wsBase}/v1/stream?token=${encodeURIComponent(token)}`);
    await c.aberto();
    c.enviar({ tipo: "sessao.retomar", versao: 1, sessaoId, ultimoSeq: seqAntes - 1 });
    const retomada = await c.esperar((m): m is Extract<MensagemGateway, { tipo: "sessao.retomada" }> => m.tipo === "sessao.retomada");
    expect(retomada.sessaoId).toBe(sessaoId);
    // `terminate()` descarta o que ainda estava no buffer de envio: o gateway diz de onde reenviar.
    expect(retomada.aPartirDoSeq).toBeGreaterThan(0);
    expect(retomada.aPartirDoSeq).toBeLessThanOrEqual(seqAntes);
    expect(provedores).toHaveLength(1); // mesmo STT, mesma call

    // Fila da extensão: reenvia (flag `reenviado`) do que o gateway não recebeu até cobrir a fala
    // "parcelar" (82 s). Tudo isso é TRANSCRITO (vai para o histórico), mas NÃO vira card fora de hora.
    c.seq = retomada.aPartirDoSeq;
    const fimReenvio = byteEm(84_000);
    await enviarTrecho(c, retomada.aPartirDoSeq * 4096, fimReenvio, true);
    await c.esperar((m) => m.tipo === "transcricao" && m.final && m.texto.startsWith("Entendi. E dá para parcelar"));
    await new Promise((r) => setTimeout(r, 1_600)); // janela de reenvio do gateway (1,5 s)
    // Trecho 3 (ao vivo de novo): o resto da call.
    await enviarTrecho(c, fimReenvio, total.length);
    // Última transcrição final antes do CloseStream (closer, 148 s): só então contar.
    await c.esperar((m) => m.tipo === "transcricao" && m.final && m.texto.startsWith("Ótima pergunta. Tem política"));

    const transcricoes = [...recebidasAntes, ...c.recebidas].filter((m): m is Extract<MensagemGateway, { tipo: "transcricao" }> => m.tipo === "transcricao");
    expect(transcricoes.filter((t) => t.final).length).toBeGreaterThanOrEqual(fixture.eventos.filter((e) => e.final && !e.soAoFinalizar).length);
    expect(transcricoes.some((t) => t.falante === "closer")).toBe(true);
    for (const t of transcricoes) expect(Object.keys(t).sort()).toEqual(["falante", "final", "texto", "tipo"]);

    // ── Cards no formato da extensão ──
    await c.esperar((m) => m.tipo === "sugestao" && (m as Card).fonte === "ia");
    const cards = [...recebidasAntes, ...c.recebidas].filter((m): m is Card => m.tipo === "sugestao");
    for (const k of cards) {
      expect(k.id).toMatch(/[0-9a-f-]{36}/);
      expect(k.frase.split(/\s+/).length).toBeLessThanOrEqual(20);
      expect(k.frase).not.toMatch(/^[-•]/);
      expect(["playbook", "ia"]).toContain(k.fonte);
      expect(["sugestao", "atencao"]).toContain(k.nivel);
      expect(k.eco!.length).toBeLessThanOrEqual(52);
      expect(k.geradoEm).toBeTypeOf("number");
      expect(k.latenciaMs).toBeLessThan(2000);
    }
    const categorias = new Set(cards.map((k) => k.categoria));
    expect(categorias.has("Preço / Investimento")).toBe(true);
    expect(categorias.has("Confiança / Risco")).toBe(true);
    // A fala "parcelar" chegou como áudio reenviado: transcrita, mas sem card.
    expect(categorias.has("Forma de Pagamento")).toBe(false);
    expect(cards.some((k) => k.eco?.includes("parcelar"))).toBe(false);

    // Falso positivo do regex ("meu marido adorou") vira `sugestao.retirar` do card.
    const retirada = await c.esperar((m): m is Extract<MensagemGateway, { tipo: "sugestao.retirar" }> => m.tipo === "sugestao.retirar");
    const falsoPositivo = cards.find((k) => k.eco?.includes("adorou"));
    expect(falsoPositivo?.categoria).toBe("Autoridade / Cônjuge");
    expect(retirada.sugestaoId).toBe(falsoPositivo!.id);

    // L0 vai como chip pendente e a camada seguinte completa o MESMO id (nunca um id novo) — ou retira.
    const pendentes = cards.filter((k) => k.pendente);
    expect(pendentes.length).toBeGreaterThan(0);
    for (const p of pendentes) {
      const completo = cards.find((k) => k.id === p.id && !k.pendente);
      expect(completo !== undefined || p.id === retirada.sugestaoId, `chip ${p.categoria} sem conclusão nem retirada`).toBe(true);
    }
    // Critério de pronto #2 — objeção SEM a palavra óbvia ("não sei se vale o investimento"): nenhum gatilho
    // casou (não houve chip pendente) e mesmo assim o caminho semântico (L1/L2/L3) trouxe o card de Preço.
    const semGatilho = cards.filter((k) => k.eco?.includes("investimento"));
    expect(semGatilho.length).toBeGreaterThan(0);
    expect(semGatilho.every((k) => !k.pendente)).toBe(true);
    expect(semGatilho[0]!.categoria).toBe("Preço / Investimento");
    // L3 (Sonnet) só quando nada no banco serve: chega como conclusão do mesmo id, frase podada (≤ 20 palavras).
    const l3 = cards.find((k) => k.fonte === "ia")!;
    expect(l3).toBeDefined();
    expect(l3.pendente).toBeUndefined();
    expect(ia.chamadas.gerar).toBeGreaterThan(0);

    // Feedback pelos dois caminhos: WS e REST (mesmo id de card).
    const cardPreco = cards.find((k) => k.categoria === "Preço / Investimento" && !k.pendente)!;
    c.enviar({ tipo: "feedback", sessaoId, sugestaoId: cardPreco.id, valor: "usei", em: new Date().toISOString() });
    const cardConfianca = cards.find((k) => k.categoria === "Confiança / Risco" && !k.pendente)!;
    const fb = await json(`/v1/sugestoes/${cardConfianca.id}/feedback`, { method: "POST", token, body: JSON.stringify({ sessaoId, valor: "nao_serviu", em: new Date().toISOString() }) });
    expect(fb.status).toBe(204);
    const fb404 = await json(`/v1/sugestoes/77777777-7777-4777-8777-777777777777/feedback`, { method: "POST", token, body: JSON.stringify({ sessaoId, valor: "ignorou", em: new Date().toISOString() }) });
    expect(fb404.status).toBe(404);

    // ── Encerrar como a extensão faz: manda `encerrar` e fecha o socket em seguida. ──
    expect(cards.some((k) => k.nivel === "atencao")).toBe(false); // sinal de compra só sai após CloseStream
    c.enviar({ tipo: "encerrar", sessaoId, motivo: "closer" });
    c.ws.close(1000, "encerrado pelo closer");
    await ate(() => repo.estado.sessoes.get(sessaoId)?.status === "concluida", 8000);

    // O gateway esperou a finalização do STT: a última fala (sinal de compra + CPF) foi transcrita e detectada.
    expect(provedores[0]!.finalizado).toBe(true);
    expect(provedores[0]!.destruido).toBe(true);
    const trans = repo.estado.transcricoes.filter((t) => t.callId === sessaoId);
    expect(trans.length).toBe(fixture.eventos.filter((e) => e.final || e.soAoFinalizar).length);
    expect(new Set(trans.map((t) => t.seq)).size).toBe(trans.length); // seq contínuo mesmo após a retomada
    expect(trans.some((t) => t.content.includes("parcelar"))).toBe(true); // reenviado: transcrito, sem card
    const ultimaFala = trans.find((t) => t.content.includes("Como faço para fechar"))!;
    expect(ultimaFala.content).toContain("[CPF]");
    expect(ultimaFala.content).not.toContain("123.456.789-09");
    const detSinal = [...repo.estado.deteccoes.values()].find((d) => d.categoriaId === "sinal_compra");
    expect(detSinal).toBeDefined();
    expect(detSinal!.trecho).toContain("[CPF]");

    // Uma linha por card em qs_copilot_detections, refinada (não duplicada) e com o feedback certo.
    expect(repo.estado.deteccoes.has(cardPreco.id)).toBe(true);
    expect(repo.estado.deteccoes.get(cardPreco.id)?.outcome).toBe("usada");
    expect(repo.estado.deteccoes.get(cardConfianca.id)?.outcome).toBe("nao_util");
    expect(repo.estado.deteccoes.get(falsoPositivo!.id)?.outcome).toBe("descartada");
    const idsCards = new Set(cards.map((k) => k.id));
    for (const id of repo.estado.deteccoes.keys()) if (id !== detSinal!.id) expect(idsCards.has(id)).toBe(true);
    const detL3 = repo.estado.deteccoes.get(l3.id)!;
    expect(detL3.matchMethod).toBe("llm");
    expect(detL3.suggestionShown).toBe(l3.frase);

    // Pós-call no QS: resumo, nota, tarefa, catalogação, custo.
    const sessao = repo.estado.sessoes.get(sessaoId)!;
    expect(sessao.metadata.consentimento).toMatchObject({ id: consentimentoId, metodo: "extensao_v2", textoVersao: "2026-09-v1" });
    expect((sessao.metadata.posCall as { erros: string[] }).erros).toEqual([]);
    expect(sessao.sttCostUsd).toBeGreaterThan(0);
    expect(sessao.llmCostUsd).toBeGreaterThan(0);
    expect(repo.estado.resumos.get(sessaoId)?.temperatura).toBe("quente");
    expect(repo.estado.tarefas).toHaveLength(1);
    expect(repo.estado.tarefas[0]).toMatchObject({ leadId: LEAD_ID, ownerId: closer.id, channelType: "whatsapp", priority: "alta" });
    expect(repo.estado.tarefas[0]!.scheduledAt).toMatch(/T09:00:00-03:00$/);
    expect(repo.estado.notas).toHaveLength(1);
    expect(repo.estado.notas[0]!.body).toContain("Capadócia");
    expect(repo.estado.catalogadas.length).toBeGreaterThanOrEqual(1);
    expect(ia.chamadas.resumir).toBe(1);

    const custo = await json(`/v1/calls/${sessaoId}/custo`, { token });
    expect(custo.status).toBe(200);
    const cst = (await custo.json()) as { totalBrl: number; detalhe: { cacheHitRatio: number } };
    expect(cst.totalBrl).toBeGreaterThan(0);
    expect(cst.totalBrl).toBeLessThan(5);

    const metricas = await (await fetch(`${base}/metrics`)).text();
    expect(metricas).toContain("copilot_active_sessions 0");
    expect(metricas).toMatch(/copilot_ws_connections_total\{estado="retomada"\} 1/);
    const lat = (await (await fetch(`${base}/internal/latencias`)).json()) as { etapas: Record<string, { n: number; p95: number }> };
    expect(lat.etapas.e2e_sugestao!.p95).toBeLessThan(2000);
    expect(montado.registro.total).toBe(0);
  });

  it("drenagem: /health vira 503 e conexão nova é recusada com 1013 (a extensão reconecta noutra máquina)", async () => {
    const r = await fetch(`${base}/internal/drain`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(503);
    const c = new Cliente(`${wsBase}/v1/stream?token=${encodeURIComponent(token)}`);
    expect(await c.fechado).toBe(1013);
  });
});
