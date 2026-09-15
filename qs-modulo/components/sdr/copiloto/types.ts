// src/components/sdr/copiloto/types.ts — Tipos do módulo Copiloto (QS)
//
// Espelham EXATAMENTE as tabelas criadas pela Frente A em
// qs-copilot-spike/sql/001_schema.sql (+ 002 embeddings, 004 views, 005 qs_meetings).
// Enums do banco são TEXT + CHECK → aqui são uniões de string, como em ../types.ts.

import type { Lead, Meeting, SdrUser, ChannelType, PriorityLevel } from "../types";

// ── Enums (uniões de string) ─────────────────────────────────────────────────

/** qs_copilot_calls.status */
export type CopilotCallStatus =
  | "aguardando"
  | "gravando"
  | "pausada"
  | "processando"
  | "concluida"
  | "erro"
  | "descartada";

export type CopilotPlatform = "google_meet" | "zoom" | "teams" | "whatsapp" | "telefone" | "presencial" | "outro";

/** qs_copilot_calls.consent_status */
export type CopilotConsentStatus = "pendente" | "concedido" | "recusado" | "nao_aplicavel";

/** qs_copilot_transcript_turns.speaker */
export type CopilotSpeaker = "lead" | "closer" | "sistema";

/** qs_copilot_objections.categoria — 14 categorias do produto (CHECK no banco). */
export type CopilotCategoria =
  | "preco"
  | "concorrente"
  | "decisor"
  | "procrastinacao"
  | "timing"
  | "parcelamento"
  | "confianca"
  | "cancelamento_seguro"
  | "seguranca_destino"
  | "documentacao"
  | "cambio"
  | "pesquisando"
  | "sinal_compra"
  | "outro";

export type CopilotSeveridade = "baixa" | "media" | "alta";
export type CopilotMomento = "abertura" | "diagnostico" | "apresentacao" | "proposta" | "fechamento" | "pos_proposta" | "qualquer";
export type CopilotFonteObjecao = "curadoria" | "call_real" | "mentoria" | "importacao" | "ia";

/** qs_copilot_objection_responses.status */
export type CopilotRespostaStatus = "rascunho" | "aprovada" | "arquivada";
export type CopilotTom = "consultivo" | "direto" | "empatico" | "urgencia";

/** qs_copilot_detections.fonte — camada que detectou (L0 gatilho · L1 vetor · L2/L3 ia). */
export type CopilotFonteDeteccao = "gatilho" | "vetor" | "ia" | "hibrido";
export type CopilotTemperatura = "quente" | "morno" | "frio";

/** qs_copilot_feedback.resultado / motivo */
export type CopilotFeedbackResultado = "usei" | "nao_serviu" | "ignorei";
export type CopilotFeedbackMotivo =
  | "resposta_errada"
  | "fora_de_contexto"
  | "chegou_tarde"
  | "ja_sabia"
  | "lead_nao_disse_isso"
  | "texto_ruim"
  | "outro";

// ── Playbook ─────────────────────────────────────────────────────────────────

/**
 * Uma versão da resposta curta. A `is_primary` (sempre `aprovada`) é a que vai
 * para o card do closer. Histórico nunca é apagado: arquiva-se.
 */
export interface CopilotResponse {
  id: string;
  org_id: string;
  objection_id: string;
  versao: number;
  texto: string; // 5–220 chars; ≤ 25 palavras no banco, ≤ 20 pela regra do produto
  contexto_uso: string | null; // quando usar esta variação
  tom: CopilotTom | null;
  status: CopilotRespostaStatus;
  is_primary: boolean;
  substitui_id: string | null;
  autor_id: string | null;
  aprovado_por: string | null;
  aprovado_at: string | null;
  created_at: string;
  updated_at: string;
  autor?: Pick<SdrUser, "id" | "name"> | null;
}

export interface CopilotObjection {
  id: string;
  org_id: string;
  categoria: CopilotCategoria;
  titulo: string;
  exemplo_lead: string | null; // como o lead fala, literalmente
  gatilhos: string[]; // L0: match léxico instantâneo (máx. 20)
  severidade: CopilotSeveridade;
  momento: CopilotMomento;
  produto_id: string | null;
  fonte: CopilotFonteObjecao;
  uso_total: number;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  embedding_updated_at?: string | null; // adicionado em 002_pgvector.sql
  created_at: string;
  updated_at: string;
  responses?: CopilotResponse[];
}

export type CopilotObjectionInput = Pick<
  CopilotObjection,
  "categoria" | "titulo" | "exemplo_lead" | "gatilhos" | "severidade" | "momento" | "produto_id"
>;

export interface CopilotProduto {
  id: string;
  name: string;
  is_active?: boolean;
}

/** Fala do lead detectada sem objeção correspondente no playbook (objection_id NULL). */
export interface CopilotLacuna {
  trecho: string;
  categoria: string;
  ocorrencias: number;
  ultima_em: string;
}

// ── Calls ────────────────────────────────────────────────────────────────────

export interface CopilotCall {
  id: string;
  org_id: string;
  lead_id: string | null;
  meeting_id: string | null;
  closer_id: string;
  lead_nome_snapshot: string | null;
  platform: CopilotPlatform;
  meeting_url: string | null;
  stt_provider: string;
  stt_model: string;
  stt_language: string;
  stt_request_id: string | null;
  status: CopilotCallStatus;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  consent_status: CopilotConsentStatus;
  consent_method: string | null;
  consent_at: string | null;
  consent_by: string | null;
  consent_proof: Record<string, unknown>;
  stt_cost_usd: number;
  llm_cost_usd: number;
  fx_rate_brl: number;
  total_cost_brl: number; // coluna gerada: (stt + llm) * fx
  gateway_version: string | null;
  extension_version: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // relações (embed do PostgREST)
  lead?: Pick<Lead, "id" | "full_name" | "company_name" | "status" | "closed_value" | "estimated_value" | "loss_reason_id"> | null;
  closer?: Pick<SdrUser, "id" | "name"> | null;
  meeting?: Pick<Meeting, "id" | "scheduled_at" | "status" | "meeting_url"> | null;
  summary?: CopilotSummary | null;
  // agregados calculados no cliente
  _deteccoes?: number;
  _usadas?: number;
}

export interface CopilotTurn {
  id: number;
  org_id: string;
  call_id: string;
  closer_id: string;
  seq: number;
  speaker: CopilotSpeaker;
  channel: 0 | 1 | null; // 0 = aba (lead) · 1 = microfone (closer)
  content: string;
  offset_ms: number;
  end_offset_ms: number | null;
  confidence: number | null;
  is_final: boolean;
  created_at: string;
}

export interface CopilotFeedback {
  id: string;
  detection_id: string;
  call_id: string;
  closer_id: string;
  resultado: CopilotFeedbackResultado;
  motivo: CopilotFeedbackMotivo | null;
  comentario: string | null;
  created_at: string;
}

export interface CopilotDetection {
  id: string;
  org_id: string;
  call_id: string;
  closer_id: string;
  turn_id: number | null;
  objection_id: string | null;
  response_id: string | null;
  categoria: string; // do playbook, ou rótulo livre da IA
  trecho: string; // o que o lead disse
  detected_at_ms: number;
  fonte: CopilotFonteDeteccao;
  similarity: number | null;
  temperatura: CopilotTemperatura | null;
  sugestao_exibida: string | null; // snapshot do card mostrado
  shown_at: string | null;
  latency_ms: number | null; // fala do lead → card na tela
  closer_usou: boolean | null; // NULL = sem feedback
  feedback_at: string | null;
  llm_model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  custo_usd: number;
  created_at: string;
  // relações
  objection?: Pick<CopilotObjection, "id" | "titulo"> | null;
  response?: Pick<CopilotResponse, "id" | "texto" | "versao"> | null;
  feedback?: Pick<CopilotFeedback, "resultado" | "motivo" | "comentario"> | null;
}

export interface CopilotObjecaoResumo {
  categoria: string;
  objection_id?: string | null;
  ocorrencias: number;
  superada?: boolean;
}

export interface CopilotSummary {
  id: string;
  org_id: string;
  call_id: string;
  closer_id: string;
  lead_id: string | null;
  resumo: string;
  perfil_lead: string | null;
  temperatura: CopilotTemperatura;
  temperatura_score: number | null;
  proximo_passo: string | null;
  proximo_passo_prazo: string | null; // date YYYY-MM-DD
  proximo_passo_task_id: string | null; // Q-3
  nota_id: string | null; // Q-4
  o_que_funcionou: string[];
  o_que_melhorar: string[];
  objecoes: CopilotObjecaoResumo[];
  destino_mencionado: string | null;
  orcamento_mencionado: number | null;
  janela_viagem: string | null;
  pax_mencionado: number | null;
  talk_ratio_closer: number | null; // % de fala do closer
  perguntas_closer: number | null;
  llm_model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  custo_usd: number;
  revisado_por: string | null;
  revisado_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Pareamento (via gateway — a tabela é exclusiva do service_role) ──────────

/** Resposta de POST /v1/pairing/codigo do gateway. */
export interface CopilotCodigoPareamento {
  codigo: string;
  expiraEm: string;
  ttlSegundos: number;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface CopilotPeriodo {
  inicio: string; // ISO, inclusivo
  fim: string; // ISO, exclusivo
}

export interface CopilotKpisPeriodo {
  calls: number;
  concluidas: number;
  minutos: number;
  objecoes: number;
  objecoes_por_call: number;
  exibidas: number;
  usadas: number;
  taxa_uso_pct: number | null; // usadas ÷ exibidas
  taxa_feedback_pct: number | null; // com feedback ÷ exibidas
  latencia_p50_ms: number | null;
  latencia_p95_ms: number | null;
  calls_ganhas: number;
  calls_perdidas: number;
  fechamento_pct: number | null; // ganhas ÷ (ganhas + perdidas)
  custo_brl: number;
}

/** Agregado por categoria e por objeção no período (calculado no cliente). */
export interface CopilotObjecaoAgregada {
  categoria: string;
  objection_id: string | null;
  titulo: string | null; // NULL = não catalogada
  deteccoes: number;
  calls: number;
  exibidas: number;
  usadas: number;
  nao_serviram: number;
  taxa_uso_pct: number | null;
  latencia_p50_ms: number | null;
  calls_ganhas: number;
  calls_perdidas: number;
}

export interface CopilotRankingCloser {
  closer_id: string;
  closer: string;
  calls: number;
  minutos: number;
  objecoes: number;
  objecoes_por_call: number;
  exibidas: number;
  usadas: number;
  taxa_uso_pct: number | null;
  latencia_p50_ms: number | null;
  talk_ratio_medio: number | null;
  calls_ganhas: number;
  calls_perdidas: number;
  fechamento_pct: number | null;
  custo_brl: number;
}

export interface CopilotCustoPeriodo {
  calls: number;
  minutos: number;
  stt_usd: number; // STT · transcrição de voz (Deepgram)
  llm_usd: number; // IA · detecção semântica + resumo (Claude)
  total_brl: number; // soma de total_cost_brl (câmbio de cada call)
  media_por_call_brl: number;
  custo_por_minuto_brl: number;
  calls_acima_do_teto: number; // > R$ 5
}

/** Linha da view qs_copilot_vw_objecoes_leads_perdidos (cruza com qs_loss_reasons). */
export interface CopilotObjecaoLeadPerdido {
  org_id: string;
  categoria: string;
  objection_id: string | null;
  objecao: string;
  calls_com_objecao: number;
  calls_perdidas: number;
  calls_ganhas: number;
  taxa_perda_pct: number | null;
  receita_perdida_estimada: number;
  receita_ganha: number;
  motivo_perda_predominante: string | null;
  motivos_perda: Record<string, number> | null;
}

export interface CopilotAnalyticsPeriodo {
  kpis: CopilotKpisPeriodo;
  por_categoria: CopilotObjecaoAgregada[];
  por_objecao: CopilotObjecaoAgregada[];
  ranking: CopilotRankingCloser[];
  custo: CopilotCustoPeriodo;
}

// ── Labels e catálogo de categorias ──────────────────────────────────────────

export interface CopilotCategoriaInfo {
  label: string;
  descricao: string;
  cor: string;
  ordem: number;
}

/** Catálogo das 14 categorias (o banco guarda só o slug). */
export const CATEGORIAS: Record<CopilotCategoria, CopilotCategoriaInfo> = {
  sinal_compra: { label: "Sinal de compra", descricao: "Lead pergunta como fechar, prazo, vaga", cor: "#16A34A", ordem: 5 },
  preco: { label: "Preço / Investimento", descricao: "Valor alto, comparação, orçamento apertado", cor: "#DC2626", ordem: 10 },
  concorrente: { label: "Concorrência", descricao: "Cotando com outra agência, site de reservas, agente conhecido", cor: "#7C3AED", ordem: 20 },
  decisor: { label: "Decisor / Cônjuge", descricao: "Precisa falar com terceiro para decidir", cor: "#CA8A04", ordem: 30 },
  procrastinacao: { label: "Vou pensar", descricao: "Adia a decisão sem motivo concreto", cor: "#EA580C", ordem: 40 },
  timing: { label: "Timing / Data", descricao: "Não é o momento, calendário, férias", cor: "#F97316", ordem: 50 },
  parcelamento: { label: "Parcelamento", descricao: "Forma de pagamento, entrada, limite do cartão", cor: "#DB2777", ordem: 60 },
  confianca: { label: "Confiança", descricao: "Não conhece a agência, medo de golpe", cor: "#2563EB", ordem: 70 },
  cancelamento_seguro: { label: "Cancelamento / Seguro", descricao: "E se eu precisar cancelar, adoecer, remarcar", cor: "#0891B2", ordem: 80 },
  seguranca_destino: { label: "Segurança no destino", descricao: "Medo do lugar, notícias, idioma", cor: "#0D9488", ordem: 90 },
  documentacao: { label: "Documentação / Visto", descricao: "Passaporte, visto, vacinas, burocracia", cor: "#4F46E5", ordem: 100 },
  cambio: { label: "Câmbio", descricao: "Dólar alto, esperar o câmbio cair", cor: "#059669", ordem: 110 },
  pesquisando: { label: "Só pesquisando", descricao: "Ainda não decidiu viajar, curiosidade", cor: "#64748B", ordem: 120 },
  outro: { label: "Outra", descricao: "Não classificada", cor: "#94A3B8", ordem: 999 },
};

export const LISTA_CATEGORIAS = (Object.keys(CATEGORIAS) as CopilotCategoria[]).sort((a, b) => CATEGORIAS[a].ordem - CATEGORIAS[b].ordem);

export function infoCategoria(slug: string | null | undefined): CopilotCategoriaInfo {
  return (slug && CATEGORIAS[slug as CopilotCategoria]) || { label: slug ?? "Sem categoria", descricao: "", cor: "#94A3B8", ordem: 999 };
}

export const CALL_STATUS_LABELS: Record<CopilotCallStatus, string> = {
  aguardando: "Aguardando",
  gravando: "Ao vivo",
  pausada: "Pausada",
  processando: "Processando",
  concluida: "Concluída",
  erro: "Erro",
  descartada: "Descartada",
};

export const PLATFORM_LABELS: Record<CopilotPlatform, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  teams: "Teams",
  whatsapp: "WhatsApp",
  telefone: "Telefone",
  presencial: "Presencial",
  outro: "Outro",
};

export const CONSENT_LABELS: Record<CopilotConsentStatus, string> = {
  pendente: "Consentimento pendente",
  concedido: "Consentimento registrado",
  recusado: "Consentimento recusado",
  nao_aplicavel: "Sem gravação",
};

export const SPEAKER_LABELS: Record<CopilotSpeaker, string> = {
  lead: "Lead",
  closer: "Closer",
  sistema: "Sistema",
};

export const FONTE_DETECCAO_LABELS: Record<CopilotFonteDeteccao, string> = {
  gatilho: "Gatilho de fala",
  vetor: "Semântica",
  hibrido: "Híbrida",
  ia: "IA generativa",
};

export const SEVERIDADE_LABELS: Record<CopilotSeveridade, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

export const MOMENTO_LABELS: Record<CopilotMomento, string> = {
  abertura: "Abertura",
  diagnostico: "Diagnóstico",
  apresentacao: "Apresentação",
  proposta: "Proposta",
  fechamento: "Fechamento",
  pos_proposta: "Pós-proposta",
  qualquer: "Qualquer momento",
};

export const TEMPERATURA_LABELS: Record<CopilotTemperatura, string> = {
  quente: "Quente",
  morno: "Morno",
  frio: "Frio",
};

export const TOM_LABELS: Record<CopilotTom, string> = {
  consultivo: "Consultivo",
  direto: "Direto",
  empatico: "Empático",
  urgencia: "Urgência",
};

export const RESPOSTA_STATUS_LABELS: Record<CopilotRespostaStatus, string> = {
  rascunho: "Rascunho",
  aprovada: "Aprovada",
  arquivada: "Arquivada",
};

export const FEEDBACK_LABELS: Record<CopilotFeedbackResultado, string> = {
  usei: "Usou",
  nao_serviu: "Não serviu",
  ignorei: "Ignorou",
};

export const FEEDBACK_MOTIVO_LABELS: Record<CopilotFeedbackMotivo, string> = {
  resposta_errada: "resposta errada",
  fora_de_contexto: "fora de contexto",
  chegou_tarde: "chegou tarde",
  ja_sabia: "já sabia",
  lead_nao_disse_isso: "o lead não disse isso",
  texto_ruim: "texto ruim",
  outro: "outro motivo",
};

// ── Regras de conteúdo ───────────────────────────────────────────────────────

/** Teto do produto: o closer lê em uma olhada. (O banco aceita até 25 — CHECK.) */
export const LIMITE_PALAVRAS_RESPOSTA = 20;
/** Recomendação de UX: ≤ 68 caracteres cabe em 2 linhas no painel. */
export const LIMITE_CARACTERES_RESPOSTA = 68;
/** Limites duros do banco (CHECK em qs_copilot_objection_responses.texto). */
export const MIN_CARACTERES_RESPOSTA = 5;
export const MAX_CARACTERES_RESPOSTA = 220;
export const MAX_GATILHOS = 20;

export function contarPalavras(texto: string): number {
  return texto.trim().split(/\s+/).filter(Boolean).length;
}

// ── Pós-call → QS ────────────────────────────────────────────────────────────

export interface CopilotNovaTarefa {
  lead_id: string;
  owner_id: string;
  channel_type: ChannelType;
  priority: PriorityLevel;
  scheduled_at: string;
  notes: string;
}
