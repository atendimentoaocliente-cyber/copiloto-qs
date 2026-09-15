/**
 * Repositório em memória — dev sem banco e testes determinísticos.
 *
 * `buscarObjecoes` simula a busca híbrida com sobreposição léxica
 * (Jaccard sobre tokens normalizados). Não é vetorial, mas dá ao L1 um
 * comportamento previsível para o teste de integração.
 */
import { randomUUID } from "node:crypto";
import { normalizar } from "../util/texto.js";
import type { Briefing } from "../tipos/protocolo.js";
import { SEED_OBJECOES } from "./seed-objecoes.js";
import {
  briefingResumido,
  type BriefingCompleto,
  type Candidato,
  type CodigoPairing,
  type ConfigCopiloto,
  type Consentimento,
  type CustoSessao,
  type LinhaTranscricao,
  type NovaDeteccao,
  type NovaNota,
  type NovaObjecaoCatalogada,
  type NovaSessao,
  type NovaTarefa,
  type NovoConsentimento,
  type NovoResumo,
  type ObjecaoPlaybook,
  type PatchDeteccao,
  type PatchSessao,
  type RepositorioCopiloto,
  type ResumoCustoPeriodo,
  type ReuniaoQs,
  type UsuarioQs,
} from "./repositorio.js";

export interface EstadoMemoria {
  usuarios: Map<string, UsuarioQs & { senha?: string }>;
  pairing: Map<string, CodigoPairing>;
  objecoes: ObjecaoPlaybook[];
  sessoes: Map<string, { id: string; closerId: string; status: string; startedAt: string | null; endedAt: string | null; sttCostUsd: number; llmCostUsd: number; metadata: Record<string, unknown>; leadId: string | null; errorMessage: string | null }>;
  transcricoes: LinhaTranscricao[];
  deteccoes: Map<string, NovaDeteccao & PatchDeteccao>;
  resumos: Map<string, NovoResumo>;
  tarefas: Array<NovaTarefa & { id: string }>;
  notas: Array<NovaNota & { id: string }>;
  catalogadas: Array<NovaObjecaoCatalogada & { id: string }>;
  briefings: Map<string, BriefingCompleto>;
  reunioes: Array<ReuniaoQs & { closerId: string }>;
  consentimentos: Map<string, Consentimento & NovoConsentimento>;
}

export class RepositorioMemoria implements RepositorioCopiloto {
  readonly estado: EstadoMemoria;

  constructor(inicial?: Partial<EstadoMemoria>) {
    this.estado = {
      usuarios: new Map(),
      pairing: new Map(),
      objecoes: [...SEED_OBJECOES],
      sessoes: new Map(),
      transcricoes: [],
      deteccoes: new Map(),
      resumos: new Map(),
      tarefas: [],
      notas: [],
      catalogadas: [],
      briefings: new Map(),
      reunioes: [],
      consentimentos: new Map(),
      ...inicial,
    };
  }

  async buscarUsuario(id: string): Promise<UsuarioQs | null> {
    const u = this.estado.usuarios.get(id);
    return u ? semSenha(u) : null;
  }
  async buscarUsuarioPorEmail(email: string): Promise<UsuarioQs | null> {
    for (const u of this.estado.usuarios.values()) if (u.email.toLowerCase() === email.toLowerCase()) return semSenha(u);
    return null;
  }
  async validarSenhaLegada(email: string, senha: string): Promise<UsuarioQs | null> {
    for (const u of this.estado.usuarios.values()) {
      if (u.email.toLowerCase() === email.toLowerCase() && u.senha === senha && u.ativo) return semSenha(u);
    }
    return null;
  }

  async salvarCodigoPairing(c: CodigoPairing): Promise<void> {
    this.estado.pairing.set(c.codigo, c);
  }
  async consumirCodigoPairing(codigo: string): Promise<CodigoPairing | null> {
    const c = this.estado.pairing.get(codigo);
    if (!c) return null;
    this.estado.pairing.delete(codigo);
    return c.expiraEm > Date.now() ? c : null;
  }

  async listarObjecoesAtivas(): Promise<ObjecaoPlaybook[]> {
    return [...this.estado.objecoes];
  }

  async buscarObjecoes(_embedding: number[], texto: string, limiar: number, n: number): Promise<Candidato[]> {
    const alvo = new Set(tokens(texto));
    const pontuados = this.estado.objecoes.map((ob) => {
      const base = new Set(tokens([ob.exemploLead, ...ob.variacoes, ...ob.gatilhos].join(" ")));
      let inter = 0;
      for (const t of alvo) if (base.has(t)) inter++;
      const uniao = alvo.size + base.size - inter;
      const jaccard = uniao ? inter / uniao : 0;
      // Escala o Jaccard (tipicamente 0.05–0.3) para a faixa de cosseno do threshold.
      const similaridade = Math.min(1, jaccard * 4);
      return { ob, similaridade };
    });
    return pontuados
      .filter((p) => p.similaridade >= limiar)
      .sort((a, b) => b.similaridade - a.similaridade)
      .slice(0, n)
      .map((p, i) => ({
        objecaoId: p.ob.id,
        categoriaId: p.ob.categoriaId,
        categoria: p.ob.categoria,
        titulo: p.ob.titulo,
        resposta: p.ob.resposta,
        respostaCurta: p.ob.respostaCurta,
        similaridade: p.similaridade,
        rrf: 1 / (60 + i + 1),
      }));
  }

  async carregarConfiguracao(): Promise<ConfigCopiloto> {
    return {
      limiarSimilaridade: 0.78,
      maxSugestoes: 3,
      cooldownSegundos: 20,
      minPalavrasGatilho: 4,
      janelaContextoTurnos: 6,
      categoriasAtivas: ["preco", "timing", "autoridade", "confianca", "concorrente", "escopo", "pagamento", "sinal_compra"],
    };
  }

  async listarCategorias(): Promise<Array<{ id: string; label: string }>> {
    const m = new Map<string, string>();
    for (const ob of this.estado.objecoes) m.set(ob.categoriaId, ob.categoria);
    m.set("outro", "Outro");
    return [...m].map(([id, label]) => ({ id, label }));
  }

  async listarReunioesDoCloser(closerId: string, desde: string, ate: string): Promise<ReuniaoQs[]> {
    return this.estado.reunioes
      .filter((r) => r.closerId === closerId && r.inicio >= desde && r.inicio < ate)
      .map(({ closerId: _c, ...r }) => r)
      .sort((a, b) => a.inicio.localeCompare(b.inicio));
  }
  async carregarBriefingCompleto(leadId: string): Promise<BriefingCompleto | null> {
    return this.estado.briefings.get(leadId) ?? null;
  }
  async registrarConsentimento(c: NovoConsentimento): Promise<{ id: string }> {
    const id = randomUUID();
    this.estado.consentimentos.set(id, { id, ...c });
    return { id };
  }
  async buscarConsentimento(id: string): Promise<Consentimento | null> {
    const c = this.estado.consentimentos.get(id);
    return c ? { id: c.id, closerId: c.closerId, leadId: c.leadId, meetingId: c.meetingId, aceito: c.aceito, confirmadoEm: c.confirmadoEm, textoVersao: c.textoVersao } : null;
  }
  async contarTranscricoes(callId: string): Promise<number> {
    return this.estado.transcricoes.filter((t) => t.callId === callId).length;
  }

  async criarSessao(d: NovaSessao): Promise<{ id: string }> {
    const id = d.id ?? randomUUID();
    if (this.estado.sessoes.has(id)) throw new Error(`duplicate key: sessão ${id} já existe`);
    this.estado.sessoes.set(id, {
      id,
      closerId: d.closerId,
      leadId: d.leadId,
      status: "gravando",
      startedAt: new Date().toISOString(),
      endedAt: null,
      sttCostUsd: 0,
      llmCostUsd: 0,
      metadata: { ...(d.metadata ?? {}), consentimento: d.consentimento },
      errorMessage: null,
    });
    return { id };
  }
  async atualizarSessao(id: string, patch: PatchSessao): Promise<void> {
    const s = this.estado.sessoes.get(id);
    if (!s) throw new Error(`sessão ${id} não existe`);
    if (patch.status) s.status = patch.status;
    if (patch.endedAt) s.endedAt = patch.endedAt;
    if (patch.startedAt) s.startedAt = patch.startedAt;
    if (patch.sttCostUsd !== undefined) s.sttCostUsd = patch.sttCostUsd;
    if (patch.llmCostUsd !== undefined) s.llmCostUsd = patch.llmCostUsd;
    if (patch.errorMessage !== undefined) s.errorMessage = patch.errorMessage;
    if (patch.metadata) s.metadata = { ...s.metadata, ...patch.metadata };
  }
  async buscarSessao(id: string) {
    const s = this.estado.sessoes.get(id);
    return s ? { id: s.id, closerId: s.closerId, status: s.status, startedAt: s.startedAt } : null;
  }
  async contarSessoesAtivasDoCloser(closerId: string): Promise<number> {
    let n = 0;
    for (const s of this.estado.sessoes.values()) if (s.closerId === closerId && s.status === "gravando") n++;
    return n;
  }
  async carregarBriefing(leadId: string): Promise<Briefing | null> {
    return briefingResumido(await this.carregarBriefingCompleto(leadId));
  }

  async inserirTranscricoes(linhas: LinhaTranscricao[]): Promise<void> {
    this.estado.transcricoes.push(...linhas);
  }
  async inserirDeteccao(d: NovaDeteccao): Promise<void> {
    this.estado.deteccoes.set(d.id, { ...d, outcome: "pendente" });
  }
  async atualizarDeteccao(id: string, callId: string, patch: PatchDeteccao): Promise<boolean> {
    const d = this.estado.deteccoes.get(id);
    if (!d || d.callId !== callId) return false;
    Object.assign(d, patch);
    return true;
  }

  async gravarResumo(r: NovoResumo): Promise<void> {
    this.estado.resumos.set(r.callId, r);
  }
  async criarTarefa(t: NovaTarefa): Promise<{ id: string }> {
    const id = randomUUID();
    this.estado.tarefas.push({ ...t, id });
    return { id };
  }
  async criarNota(n: NovaNota): Promise<{ id: string }> {
    const id = randomUUID();
    this.estado.notas.push({ ...n, id });
    return { id };
  }
  async catalogarObjecao(o: NovaObjecaoCatalogada): Promise<{ id: string; nova: boolean }> {
    const existente = this.estado.catalogadas.find((c) => c.titulo === o.titulo);
    if (existente) return { id: existente.id, nova: false };
    const id = randomUUID();
    this.estado.catalogadas.push({ ...o, id });
    return { id, nova: true };
  }

  async custoDaSessao(callId: string): Promise<CustoSessao | null> {
    const s = this.estado.sessoes.get(callId);
    if (!s) return null;
    return {
      callId: s.id,
      closerId: s.closerId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      sttCostUsd: s.sttCostUsd,
      llmCostUsd: s.llmCostUsd,
      metadata: s.metadata,
    };
  }
  async custoPorPeriodo(desde: string, ate: string, closerId: string | null): Promise<ResumoCustoPeriodo> {
    const porCloser = new Map<string, { calls: number; totalUsd: number }>();
    let sttUsd = 0;
    let llmUsd = 0;
    let calls = 0;
    for (const s of this.estado.sessoes.values()) {
      if (!s.startedAt || s.startedAt < desde || s.startedAt >= ate) continue;
      if (closerId && s.closerId !== closerId) continue;
      calls++;
      sttUsd += s.sttCostUsd;
      llmUsd += s.llmCostUsd;
      const c = porCloser.get(s.closerId) ?? { calls: 0, totalUsd: 0 };
      c.calls++;
      c.totalUsd += s.sttCostUsd + s.llmCostUsd;
      porCloser.set(s.closerId, c);
    }
    return { calls, sttUsd, llmUsd, totalUsd: sttUsd + llmUsd, porCloser: [...porCloser].map(([k, v]) => ({ closerId: k, ...v })) };
  }

  async fechar(): Promise<void> {
    /* nada a fechar */
  }
}

function semSenha(u: UsuarioQs & { senha?: string }): UsuarioQs {
  const { senha: _s, ...resto } = u;
  return resto;
}

const PARADAS = new Set(["a", "o", "e", "de", "da", "do", "que", "eu", "um", "uma", "em", "no", "na", "com", "pra", "para", "se", "é", "ta", "tá", "meu", "minha", "isso", "esse", "essa"]);
function tokens(texto: string): string[] {
  return normalizar(texto)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !PARADAS.has(t));
}
