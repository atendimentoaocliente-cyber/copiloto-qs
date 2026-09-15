/**
 * Rotas REST do contrato da extensão: reuniões, briefing, consentimentos
 * (aceite E recusa) e feedback — inclusive os casos de permissão.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarApp, type AppMontado } from "../../src/app.js";
import { emitirToken } from "../../src/auth/jwt.js";
import { RepositorioMemoria } from "../../src/db/memoria.js";
import type { UsuarioQs } from "../../src/db/repositorio.js";
import { CachePlaybook } from "../../src/motor/playbook.js";
import { janelaDoDia } from "../../src/qs/rotas.js";
import { configTeste, logTeste, metricasTeste } from "../apoio/ambiente.js";
import { ProvedorSttFixture } from "../apoio/stt-fixture.js";

const joana: UsuarioQs = { id: "11111111-1111-4111-8111-111111111111", nome: "Joana", email: "joana@x.com", papel: "closer", ativo: true };
const pedro: UsuarioQs = { id: "11111111-1111-4111-8111-222222222222", nome: "Pedro", email: "pedro@x.com", papel: "closer", ativo: true };
const gestora: UsuarioQs = { id: "11111111-1111-4111-8111-333333333333", nome: "Ana", email: "ana@x.com", papel: "gestor", ativo: true };
const LEAD_JOANA = "22222222-2222-4222-8222-000000000001";
const LEAD_PEDRO = "22222222-2222-4222-8222-000000000002";
const SESSAO_JOANA = "66666666-6666-4666-8666-000000000001";
const DET = "99999999-9999-4999-8999-000000000001";
const hojeSP = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

describe("janelaDoDia", () => {
  it("converte um dia de São Paulo em [00:00, 24:00) UTC", () => {
    expect(janelaDoDia("2026-09-13")).toEqual({ desde: "2026-09-13T03:00:00.000Z", ate: "2026-09-14T03:00:00.000Z", dia: "2026-09-13" });
    expect(janelaDoDia("hoje").dia).toBe(hojeSP);
    expect(() => janelaDoDia("2026-13-45")).toThrow(/dia inválido/);
  });
});

describe("rotas QS (contrato da extensão)", () => {
  let montado: AppMontado;
  let repo: RepositorioMemoria;
  let base: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    const cfg = configTeste();
    const log = logTeste();
    repo = new RepositorioMemoria({
      usuarios: new Map([joana, pedro, gestora].map((u) => [u.id, u])),
      reunioes: [
        { id: "33333333-3333-4333-8333-000000000001", leadId: LEAD_JOANA, leadNome: "Marina", inicio: `${hojeSP}T13:00:00.000Z`, closerId: joana.id },
        { id: "33333333-3333-4333-8333-000000000002", leadId: LEAD_JOANA, leadNome: "Marina", inicio: "2020-01-01T13:00:00.000Z", closerId: joana.id },
        { id: "33333333-3333-4333-8333-000000000003", leadId: LEAD_PEDRO, leadNome: "Bruno", inicio: `${hojeSP}T15:00:00.000Z`, closerId: pedro.id },
      ],
      briefings: new Map([
        [LEAD_JOANA, { lead: { id: LEAD_JOANA, nome: "Marina", primeiroNome: "Marina", ownerId: joana.id, empresa: null, valorEstimado: null }, handover: null, produto: null, historico: [], ultimasCalls: [] }],
        [LEAD_PEDRO, { lead: { id: LEAD_PEDRO, nome: "Bruno", primeiroNome: "Bruno", ownerId: pedro.id, empresa: null, valorEstimado: null }, handover: null, produto: null, historico: [], ultimasCalls: [] }],
      ]),
    });
    const playbook = new CachePlaybook(repo, log, metricasTeste(), 1e9);
    await playbook.iniciar();
    montado = await criarApp({ cfg, log, repo, playbook, ia: null, embedder: null, fabricaStt: () => new ProvedorSttFixture([]) });
    await montado.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = montado.app.server.address();
    base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
    for (const u of [joana, pedro, gestora]) tokens[u.id] = emitirToken(montado.app, u).token;

    await repo.criarSessao({ id: SESSAO_JOANA, closerId: joana.id, leadId: LEAD_JOANA, meetingId: null, plataforma: "google_meet", meetingUrl: null, sttProvedor: "fixture", sttModelo: "v1", consentimento: { metodo: "teste", em: new Date().toISOString() } });
    await repo.inserirDeteccao({ id: DET, callId: SESSAO_JOANA, closerId: joana.id, objecaoId: null, categoriaId: "preco", detectedAtMs: 1000, trecho: "achei caro", similarity: 1, matchMethod: "lexical", suggestionShown: "Caro comparado com o quê?", latencyMs: 10, llmModel: null });
  });
  afterAll(async () => montado.app.close());

  const chamar = (caminho: string, quem: UsuarioQs, init: RequestInit = {}) =>
    fetch(`${base}${caminho}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${tokens[quem.id]}` } });

  it("GET /v1/reunioes filtra por closer e por dia", async () => {
    const hoje = (await (await chamar("/v1/reunioes?dia=hoje", joana)).json()) as Array<{ id: string }>;
    expect(hoje.map((r) => r.id)).toEqual(["33333333-3333-4333-8333-000000000001"]);
    const antiga = (await (await chamar("/v1/reunioes?dia=2020-01-01", joana)).json()) as Array<{ id: string }>;
    expect(antiga).toHaveLength(1);
    const semParam = (await (await chamar("/v1/reunioes", pedro)).json()) as Array<{ leadNome: string }>;
    expect(semParam[0]?.leadNome).toBe("Bruno");
    expect((await chamar("/v1/reunioes?dia=ontem", joana)).status).toBe(400);
    expect((await fetch(`${base}/v1/reunioes`)).status).toBe(401);
  });

  it("GET /v1/leads/:id/briefing: dono vê, outro closer não, gestor vê tudo, lead inexistente 404", async () => {
    expect((await chamar(`/v1/leads/${LEAD_JOANA}/briefing?reuniaoId=x`, joana)).status).toBe(200);
    expect((await chamar(`/v1/leads/${LEAD_PEDRO}/briefing`, joana)).status).toBe(403);
    expect((await chamar(`/v1/leads/${LEAD_PEDRO}/briefing`, gestora)).status).toBe(200);
    expect((await chamar(`/v1/leads/22222222-2222-4222-8222-999999999999/briefing`, joana)).status).toBe(404);
    expect((await chamar(`/v1/leads/nao-e-uuid/briefing`, joana)).status).toBe(400);
  });

  it("POST /v1/consentimentos registra aceite e RECUSA (auditoria de que o lead foi perguntado)", async () => {
    const aceite = await chamar("/v1/consentimentos", joana, { method: "POST", body: JSON.stringify({ reuniaoId: "33333333-3333-4333-8333-000000000001", leadId: LEAD_JOANA, confirmadoEm: new Date().toISOString(), textoVersao: "2026-09-v1" }) });
    expect(aceite.status).toBe(201);
    const { id, aceito } = (await aceite.json()) as { id: string; aceito: boolean };
    expect(aceito).toBe(true);
    expect(repo.estado.consentimentos.get(id)).toMatchObject({ aceito: true, motivoRecusa: null, closerId: joana.id });

    const recusa = await chamar("/v1/consentimentos", joana, { method: "POST", body: JSON.stringify({ leadId: LEAD_JOANA, confirmadoEm: new Date().toISOString(), textoVersao: "2026-09-v1", aceito: false, motivoRecusa: "lead não quis gravação" }) });
    expect(recusa.status).toBe(201);
    const r = (await recusa.json()) as { id: string; aceito: boolean };
    expect(r.aceito).toBe(false);
    expect(repo.estado.consentimentos.get(r.id)).toMatchObject({ aceito: false, motivoRecusa: "lead não quis gravação" });

    const recusaSemMotivo = await chamar("/v1/consentimentos", joana, { method: "POST", body: JSON.stringify({ confirmadoEm: new Date().toISOString(), textoVersao: "2026-09-v1", aceito: false }) });
    expect(repo.estado.consentimentos.get(((await recusaSemMotivo.json()) as { id: string }).id)?.motivoRecusa).toBe("lead não autorizou");

    expect((await chamar("/v1/consentimentos", joana, { method: "POST", body: JSON.stringify({ textoVersao: "x" }) })).status).toBe(400);
  });

  it("POST /v1/sugestoes/:id/feedback: 204 no próprio card, 403 em sessão de outro closer, 404 em card inexistente", async () => {
    const corpo = { sessaoId: SESSAO_JOANA, valor: "usei", em: new Date().toISOString() };
    expect((await chamar(`/v1/sugestoes/${DET}/feedback`, joana, { method: "POST", body: JSON.stringify(corpo) })).status).toBe(204);
    expect(repo.estado.deteccoes.get(DET)?.outcome).toBe("usada");
    expect((await chamar(`/v1/sugestoes/${DET}/feedback`, pedro, { method: "POST", body: JSON.stringify(corpo) })).status).toBe(403);
    expect((await chamar(`/v1/sugestoes/99999999-9999-4999-8999-000000000009/feedback`, joana, { method: "POST", body: JSON.stringify(corpo) })).status).toBe(404);
    expect((await chamar(`/v1/sugestoes/${DET}/feedback`, joana, { method: "POST", body: JSON.stringify({ ...corpo, valor: "top" }) })).status).toBe(400);
    expect((await chamar(`/v1/sugestoes/${DET}/feedback`, joana, { method: "POST", body: JSON.stringify({ ...corpo, sessaoId: "66666666-6666-4666-8666-000000000009" }) })).status).toBe(404);
  });
});
