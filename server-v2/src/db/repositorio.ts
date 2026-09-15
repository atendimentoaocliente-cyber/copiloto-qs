/**
 * Contrato de persistência do copiloto.
 *
 * Duas implementações: `postgres.ts` (Supabase, produção) e `memoria.ts`
 * (dev sem banco e testes determinísticos). O motor e a sessão só conhecem
 * esta interface.
 *
 * Nomes de tabela/coluna seguem a migration da Frente A
 * (`qs_call_sessions`, `qs_call_transcripts`, `qs_copilot_detections`,
 * `qs_call_summaries`, `qs_copilot_objections`, `qs_copilot_categories`,
 * `qs_copilot_settings`) e o legado do QS (`qs_users`, `qs_leads`,
 * `qs_meetings`, `qs_handovers`, `qs_notes`, `qs_tasks`).
 */
import type { Briefing, Temperatura } from "../tipos/protocolo.js";

export type PapelQs = "admin" | "gestor" | "sdr" | "closer";

export interface UsuarioQs {
  id: string;
  nome: string;
  email: string;
  papel: PapelQs;
  ativo: boolean;
}

/** Objeção aprovada do playbook, como o motor a enxerga. */
export interface ObjecaoPlaybook {
  id: string;
  categoriaId: string;
  categoria: string;
  titulo: string;
  exemploLead: string;
  variacoes: string[];
  gatilhos: string[];
  resposta: string;
  respostaCurta: string;
  severidade: "baixa" | "media" | "alta";
  momento: string;
}

/** Resultado da busca híbrida (vetorial + léxica). */
export interface Candidato {
  objecaoId: string;
  categoriaId: string;
  categoria: string;
  titulo: string;
  resposta: string;
  respostaCurta: string;
  similaridade: number;
  rrf: number;
}

export interface ConfigCopiloto {
  limiarSimilaridade: number;
  maxSugestoes: number;
  cooldownSegundos: number;
  minPalavrasGatilho: number;
  janelaContextoTurnos: number;
  categoriasAtivas: string[];
}

export interface NovaSessao {
  /** UUID gerado pela extensão (sessaoId). Se ausente, o banco gera. */
  id?: string;
  closerId: string;
  leadId: string | null;
  meetingId: string | null;
  plataforma: string;
  meetingUrl: string | null;
  sttProvedor: string;
  sttModelo: string;
  /** Prova do consentimento LGPD, gravada em qs_call_sessions.metadata.consentimento. */
  consentimento: { metodo: string; em: string; id?: string; textoVersao?: string };
  metadata?: Record<string, unknown>;
}

export interface PatchSessao {
  status?: "gravando" | "processando" | "concluida" | "erro" | "descartada";
  startedAt?: string;
  endedAt?: string;
  sttCostUsd?: number;
  llmCostUsd?: number;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LinhaTranscricao {
  callId: string;
  closerId: string;
  seq: number;
  speaker: "lead" | "closer";
  speakerTag: 0 | 1;
  content: string;
  tsStartMs: number;
  tsEndMs: number | null;
  confidence: number | null;
}

export interface NovaDeteccao {
  id: string;
  callId: string;
  closerId: string;
  objecaoId: string | null;
  categoriaId: string | null;
  detectedAtMs: number;
  trecho: string;
  similarity: number;
  matchMethod: "vector" | "lexical" | "hibrido" | "llm";
  suggestionShown: string;
  latencyMs: number;
  llmModel: string | null;
}

export interface PatchDeteccao {
  outcome?: "pendente" | "usada" | "ignorada" | "descartada" | "util" | "nao_util";
  feedbackAt?: string;
  feedbackNote?: string | null;
  superada?: boolean;
  // Refinamento do card (L1/L2/L3 substituindo o L0): mesma linha, conteúdo novo.
  suggestionShown?: string;
  objecaoId?: string | null;
  categoriaId?: string | null;
  similarity?: number;
  matchMethod?: "vector" | "lexical" | "hibrido" | "llm";
  latencyMs?: number;
  llmModel?: string | null;
}

/** Reunião do closer (qs_meetings + qs_leads), no formato que a extensão consome. */
export interface ReuniaoQs {
  id: string;
  leadId: string;
  leadNome: string;
  inicio: string;
  fim?: string;
  produto?: string;
  destino?: string;
  ticketEstimado?: number;
  sdrNome?: string;
  plataforma?: "google_meet" | "zoom" | "teams" | "outro";
}

/** Briefing pré-call completo — espelha `Briefing` de extension-v2/tipos.ts (+ ownerId para permissão). */
export interface BriefingCompleto {
  lead: {
    id: string;
    nome: string;
    primeiroNome: string;
    cidade?: string;
    origem?: string;
    status?: string;
    ownerId: string | null;
    empresa: string | null;
    valorEstimado: number | null;
  };
  handover: {
    resumo: string;
    notas: string[];
    sdrNome: string;
    criadoEm: string;
    perfilViagem?: string;
    motivacao?: string;
    orcamentoDeclarado?: number;
    decisores?: string;
  } | null;
  produto: { nome: string; destino: string; duracaoDias?: number; ticketEstimado?: number; periodo?: string } | null;
  historico: Array<{ data: string; tipo: "nota" | "tarefa" | "reuniao" | "status" | "call"; descricao: string; autor?: string }>;
  ultimasCalls: Array<{ data: string; duracaoMin: number; objecoes: number; resultado: "fechou" | "sem_fechamento" | "follow_up" | "perdido" }>;
}

export interface NovoConsentimento {
  closerId: string;
  leadId: string | null;
  meetingId: string | null;
  aceito: boolean;
  confirmadoEm: string;
  textoVersao: string;
  motivoRecusa: string | null;
  ip: string | null;
  userAgent: string | null;
  versaoExtensao: string | null;
}

export interface Consentimento {
  id: string;
  closerId: string;
  leadId: string | null;
  meetingId: string | null;
  aceito: boolean;
  confirmadoEm: string;
  textoVersao: string;
}

/** Deriva o briefing enxuto (prompts) do completo (API). Um único caminho de dados. */
export function briefingResumido(b: BriefingCompleto | null): Briefing | null {
  if (!b) return null;
  const proximaReuniao = b.historico.find((h) => h.tipo === "reuniao")?.data ?? null;
  return {
    leadNome: b.lead.nome || null,
    empresa: b.lead.empresa,
    cidade: b.lead.cidade ?? null,
    valorEstimado: b.lead.valorEstimado,
    handover: b.handover?.resumo ?? null,
    notas: [...(b.handover?.notas ?? []), ...b.historico.filter((h) => h.tipo === "nota").map((h) => h.descricao)].slice(0, 5),
    reuniaoEm: proximaReuniao,
  };
}

export interface NovoResumo {
  callId: string;
  closerId: string;
  resumo: string;
  proximoPasso: string | null;
  proximoPassoPrazo: string | null; // yyyy-mm-dd
  temperatura: Temperatura;
  temperaturaScore: number | null;
  objecoesDetectadas: Array<{ category_id: string | null; objection_id: string | null; ocorrencias: number; superada: boolean | null }>;
  pontosPositivos: string[];
  pontosAtencao: string[];
  destinoMencionado: string | null;
  orcamentoMencionado: number | null;
  janelaViagem: string | null;
  paxMencionado: number | null;
  talkRatioCloser: number | null;
  perguntasCloser: number | null;
  monologoMaxSeg: number | null;
  llmModel: string;
  tokensIn: number;
  tokensOut: number;
  custoUsd: number;
}

export interface NovaTarefa {
  leadId: string;
  ownerId: string;
  channelType: "ligacao" | "whatsapp" | "email";
  priority: "alta" | "media" | "baixa";
  scheduledAt: string;
  notes: string;
}

export interface NovaNota {
  leadId: string;
  authorId: string;
  body: string;
}

export interface NovaObjecaoCatalogada {
  categoriaId: string;
  titulo: string;
  exemploLead: string;
  resposta: string;
  respostaCurta: string;
  createdBy: string;
}

export interface CustoSessao {
  callId: string;
  closerId: string;
  startedAt: string | null;
  endedAt: string | null;
  sttCostUsd: number;
  llmCostUsd: number;
  metadata: Record<string, unknown>;
}

export interface ResumoCustoPeriodo {
  calls: number;
  sttUsd: number;
  llmUsd: number;
  totalUsd: number;
  porCloser: Array<{ closerId: string; calls: number; totalUsd: number }>;
}

export interface CodigoPairing {
  codigo: string;
  closerId: string;
  expiraEm: number; // epoch ms
}

export interface RepositorioCopiloto {
  // Identidade (QS legado)
  buscarUsuario(id: string): Promise<UsuarioQs | null>;
  buscarUsuarioPorEmail(email: string): Promise<UsuarioQs | null>;
  /**
   * Caminho TRANSITÓRIO: o QS hoje guarda senha em texto claro em qs_users.
   * Só é usado quando PAIRING_ACEITA_SENHA_LEGADA=true. Some com Supabase Auth.
   */
  validarSenhaLegada(email: string, senha: string): Promise<UsuarioQs | null>;

  // Pairing (multi-instância: precisa viver fora do processo)
  salvarCodigoPairing(c: CodigoPairing): Promise<void>;
  consumirCodigoPairing(codigo: string): Promise<CodigoPairing | null>;

  // Playbook / configuração
  listarObjecoesAtivas(): Promise<ObjecaoPlaybook[]>;
  buscarObjecoes(embedding: number[], texto: string, limiar: number, n: number): Promise<Candidato[]>;
  carregarConfiguracao(closerId: string): Promise<ConfigCopiloto>;
  listarCategorias(): Promise<Array<{ id: string; label: string }>>;

  // Reuniões, briefing e consentimento (contrato da extensão)
  listarReunioesDoCloser(closerId: string, desde: string, ate: string): Promise<ReuniaoQs[]>;
  carregarBriefingCompleto(leadId: string): Promise<BriefingCompleto | null>;
  registrarConsentimento(c: NovoConsentimento): Promise<{ id: string }>;
  buscarConsentimento(id: string): Promise<Consentimento | null>;

  // Sessão
  criarSessao(d: NovaSessao): Promise<{ id: string }>;
  atualizarSessao(id: string, patch: PatchSessao): Promise<void>;
  buscarSessao(id: string): Promise<{ id: string; closerId: string; status: string; startedAt: string | null } | null>;
  contarSessoesAtivasDoCloser(closerId: string): Promise<number>;
  /** Briefing enxuto para os prompts. Implementação padrão: briefingResumido(carregarBriefingCompleto()). */
  carregarBriefing(leadId: string): Promise<Briefing | null>;
  /** Para retomar uma sessão noutra máquina sem colidir o `seq` de qs_call_transcripts. */
  contarTranscricoes(callId: string): Promise<number>;

  // Fluxo da call
  inserirTranscricoes(linhas: LinhaTranscricao[]): Promise<void>;
  inserirDeteccao(d: NovaDeteccao): Promise<void>;
  atualizarDeteccao(id: string, callId: string, patch: PatchDeteccao): Promise<boolean>;

  // Pós-call
  gravarResumo(r: NovoResumo): Promise<void>;
  criarTarefa(t: NovaTarefa): Promise<{ id: string }>;
  criarNota(n: NovaNota): Promise<{ id: string }>;
  catalogarObjecao(o: NovaObjecaoCatalogada): Promise<{ id: string; nova: boolean }>;

  // Custo
  custoDaSessao(callId: string): Promise<CustoSessao | null>;
  custoPorPeriodo(desde: string, ate: string, closerId: string | null): Promise<ResumoCustoPeriodo>;

  fechar(): Promise<void>;
}
