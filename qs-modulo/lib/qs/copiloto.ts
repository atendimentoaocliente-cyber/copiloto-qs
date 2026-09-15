// src/lib/qs/copiloto.ts — Camada de dados do módulo Copiloto (QS)
//
// Mesma forma de lib/qs/queries.ts (supabase direto, useEffect/useCallback nas
// telas, sem React Query) com UMA diferença deliberada: NADA é engolido.
// queries.ts faz `console.warn` e devolve `[]`; aqui todo erro vira CopilotoError
// e sobe para a tela. Num módulo que grava conversa com cliente, "lista vazia"
// por falha silenciosa é indistinguível de "não houve call".
//
// Contrato: qs-copilot-spike/sql/001..005 (Frente A) e server-v2 (Frente B).
//
// IDENTIDADE — leia antes de testar: as tabelas qs_copilot_* têm RLS fechada
// para a anon key (003_rls.sql revoga tudo de `anon`). Este módulo só devolve
// dados quando o cliente `supabase` carrega um JWT identificável:
//   · Supabase Auth (MIGRACAO-AUTH.md, Fase 3) → auth.uid() → qs_users.auth_user_id
// Até lá, toda tela mostra o banner de erro — de propósito.

import { supabase } from "@/lib/supabase";
import type { Note, Task } from "@/components/sdr/types";
import type {
  CopilotObjection,
  CopilotObjectionInput,
  CopilotResponse,
  CopilotProduto,
  CopilotLacuna,
  CopilotCall,
  CopilotCallStatus,
  CopilotTurn,
  CopilotDetection,
  CopilotSummary,
  CopilotTemperatura,
  CopilotTom,
  CopilotCodigoPareamento,
  CopilotPeriodo,
  CopilotAnalyticsPeriodo,
  CopilotObjecaoAgregada,
  CopilotRankingCloser,
  CopilotObjecaoLeadPerdido,
  CopilotNovaTarefa,
} from "@/components/sdr/copiloto/types";
import {
  LIMITE_PALAVRAS_RESPOSTA,
  MIN_CARACTERES_RESPOSTA,
  MAX_CARACTERES_RESPOSTA,
  MAX_GATILHOS,
  contarPalavras,
} from "@/components/sdr/copiloto/types";

// ═══════════════════════════════════════════════════════════════════════════════
// ERRO — nunca silencioso
// ═══════════════════════════════════════════════════════════════════════════════

export class CopilotoError extends Error {
  /** Operação que falhou (ex.: "fetchCopilotCalls"). */
  readonly operacao: string;
  /** Mensagem técnica (código PostgREST, detalhe, hint) para o banner e o log. */
  readonly detalhe: string;
  readonly causa: unknown;

  constructor(operacao: string, causa: unknown, mensagem?: string) {
    const detalhe = extrairDetalhe(causa);
    super(mensagem ?? traduzir(detalhe));
    this.name = "CopilotoError";
    this.operacao = operacao;
    this.detalhe = detalhe;
    this.causa = causa;
  }
}

function extrairDetalhe(causa: unknown): string {
  if (!causa) return "erro desconhecido";
  if (typeof causa === "string") return causa;
  if (typeof causa === "object") {
    const c = causa as { message?: string; details?: string; hint?: string; code?: string };
    return [c.code, c.message, c.details, c.hint].filter(Boolean).join(" · ") || JSON.stringify(causa);
  }
  return String(causa);
}

/** Mensagens humanas para as falhas mais prováveis nesta fase. */
function traduzir(detalhe: string): string {
  const d = detalhe.toLowerCase();
  if (d.includes("42501") || d.includes("row-level security") || d.includes("permission denied")) {
    return "Sem permissão nas tabelas do Copiloto. A RLS está fechada para a anon key: o QS precisa estar logado pelo Supabase Auth (MIGRACAO-AUTH.md, Fase 3). Veja INTEGRACAO.md.";
  }
  if (d.includes("42p01") || d.includes("does not exist") || d.includes("pgrst205") || d.includes("could not find the table")) {
    return "Tabela, view ou função do Copiloto não existe no banco. Aplique as migrations 001–007 da Frente A (qs-copilot-spike/sql).";
  }
  if (d.includes("pgrst200") || d.includes("could not find a relationship")) {
    return "Relação entre tabelas não encontrada pelo PostgREST. Confira se as FKs da migration 001/005 foram criadas.";
  }
  if (d.includes("23514")) return "O banco rejeitou o valor (regra CHECK). Verifique o teto de palavras/caracteres e o status da resposta.";
  if (d.includes("23505")) return "Já existe um registro com esse valor (duplicado).";
  if (d.includes("failed to fetch") || d.includes("networkerror") || d.includes("load failed")) {
    return "Sem conexão com o servidor. Verifique a rede ou se o projeto Supabase está pausado.";
  }
  return `Falha ao acessar o banco: ${detalhe}`;
}

function falhar(operacao: string, causa: unknown): never {
  const erro = new CopilotoError(operacao, causa);
  console.error(`[Copiloto] ${operacao} falhou:`, causa);
  throw erro;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYBOOK — objeções e respostas versionadas
// ═══════════════════════════════════════════════════════════════════════════════

// `qs_users!autor_id`: responses tem duas FKs para qs_users (autor_id, aprovado_por) → hint obrigatório.
const SELECT_OBJECAO = "*, responses:qs_copilot_objection_responses(*, autor:qs_users!autor_id(id, name))";

export interface ObjecaoFiltros {
  categoria?: string;
  ativo?: boolean;
}

export async function fetchCopilotObjecoes(filtros?: ObjecaoFiltros): Promise<CopilotObjection[]> {
  let q = supabase.from("qs_copilot_objections").select(SELECT_OBJECAO).order("titulo");
  if (filtros?.categoria) q = q.eq("categoria", filtros.categoria);
  if (filtros?.ativo !== undefined) q = q.eq("is_active", filtros.ativo);
  const { data, error } = await q;
  if (error) falhar("fetchCopilotObjecoes", error);
  const lista = (data ?? []) as CopilotObjection[];
  for (const o of lista) o.responses = ordenarVersoes(o.responses ?? []);
  return lista;
}

export async function fetchCopilotObjecao(id: string): Promise<CopilotObjection> {
  const { data, error } = await supabase.from("qs_copilot_objections").select(SELECT_OBJECAO).eq("id", id).single();
  if (error) falhar("fetchCopilotObjecao", error);
  const o = data as CopilotObjection;
  o.responses = ordenarVersoes(o.responses ?? []);
  return o;
}

function ordenarVersoes(v: CopilotResponse[]): CopilotResponse[] {
  return [...v].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || b.versao - a.versao);
}

export async function fetchCopilotProdutos(): Promise<CopilotProduto[]> {
  const { data, error } = await supabase.from("qs_products").select("id, name, is_active").order("name");
  if (error) falhar("fetchCopilotProdutos", error);
  return ((data ?? []) as CopilotProduto[]).filter((p) => p.is_active !== false);
}

/** Valida a resposta curta pelas regras do produto e do banco. Lança CopilotoError legível. */
export function validarResposta(texto: string): string {
  const limpo = texto.trim().replace(/\s+/g, " ");
  if (limpo.length < MIN_CARACTERES_RESPOSTA) {
    throw new CopilotoError("validarResposta", null, "A resposta ficou curta demais.");
  }
  if (limpo.length > MAX_CARACTERES_RESPOSTA) {
    throw new CopilotoError("validarResposta", null, `A resposta tem ${limpo.length} caracteres; o banco aceita até ${MAX_CARACTERES_RESPOSTA}.`);
  }
  const palavras = contarPalavras(limpo);
  if (palavras > LIMITE_PALAVRAS_RESPOSTA) {
    throw new CopilotoError(
      "validarResposta",
      null,
      `A resposta tem ${palavras} palavras. O teto é ${LIMITE_PALAVRAS_RESPOSTA}: o closer precisa ler em uma olhada, sem o lead perceber.`
    );
  }
  return limpo;
}

function validarObjecao(input: CopilotObjectionInput): CopilotObjectionInput {
  const titulo = input.titulo.trim();
  if (titulo.length < 3 || titulo.length > 120) {
    throw new CopilotoError("validarObjecao", null, "O título precisa ter entre 3 e 120 caracteres.");
  }
  const gatilhos = input.gatilhos.map((g) => g.trim()).filter(Boolean);
  if (gatilhos.length > MAX_GATILHOS) {
    throw new CopilotoError("validarObjecao", null, `No máximo ${MAX_GATILHOS} gatilhos por objeção.`);
  }
  return { ...input, titulo, gatilhos, exemplo_lead: input.exemplo_lead?.trim() || null, produto_id: input.produto_id || null };
}

/**
 * Cria a objeção e a versão 1 da resposta (aprovada e primária).
 * `versao` fica a cargo do trigger before-insert (max+1).
 */
export async function createCopilotObjecao(
  input: CopilotObjectionInput,
  respostaCurta: string,
  userId: string,
  opcoes?: { tom?: CopilotTom | null; contexto_uso?: string | null }
): Promise<CopilotObjection> {
  const texto = validarResposta(respostaCurta);
  const valido = validarObjecao(input);

  const { data: obj, error } = await supabase
    .from("qs_copilot_objections")
    .insert({ ...valido, fonte: "curadoria", is_active: true, created_by: userId, updated_by: userId })
    .select("id")
    .single();
  if (error) falhar("createCopilotObjecao", error);

  const { error: errResp } = await supabase.from("qs_copilot_objection_responses").insert({
    objection_id: (obj as { id: string }).id,
    texto,
    tom: opcoes?.tom ?? "consultivo",
    contexto_uso: opcoes?.contexto_uso?.trim() || null,
    status: "aprovada",
    is_primary: true,
    autor_id: userId,
    aprovado_por: userId,
    aprovado_at: new Date().toISOString(),
  });
  if (errResp) falhar("createCopilotObjecao.resposta", errResp);

  return fetchCopilotObjecao((obj as { id: string }).id);
}

export async function updateCopilotObjecao(id: string, input: CopilotObjectionInput, userId: string): Promise<CopilotObjection> {
  const valido = validarObjecao(input);
  const { error } = await supabase
    .from("qs_copilot_objections")
    .update({ ...valido, updated_by: userId })
    .eq("id", id);
  if (error) falhar("updateCopilotObjecao", error);
  return fetchCopilotObjecao(id);
}

export async function toggleCopilotObjecao(id: string, ativa: boolean, userId: string): Promise<void> {
  const { error } = await supabase.from("qs_copilot_objections").update({ is_active: ativa, updated_by: userId }).eq("id", id);
  if (error) falhar("toggleCopilotObjecao", error);
}

/**
 * Nova versão da resposta. O trigger numera (max+1); se `tornarPrimaria`, o trigger
 * `promote` rebaixa a anterior. `substitui_id` mantém a linhagem para auditoria.
 */
export async function createCopilotResposta(
  objectionId: string,
  textoBruto: string,
  userId: string,
  opcoes?: { contexto_uso?: string; tom?: CopilotTom | null; tornarPrimaria?: boolean; substitui_id?: string | null }
): Promise<CopilotResponse> {
  const texto = validarResposta(textoBruto);
  const agora = new Date().toISOString();
  const { data, error } = await supabase
    .from("qs_copilot_objection_responses")
    .insert({
      objection_id: objectionId,
      texto,
      contexto_uso: opcoes?.contexto_uso?.trim() || null,
      tom: opcoes?.tom ?? null,
      status: "aprovada",
      is_primary: opcoes?.tornarPrimaria ?? false,
      substitui_id: opcoes?.substitui_id ?? null,
      autor_id: userId,
      aprovado_por: userId,
      aprovado_at: agora,
    })
    .select("*")
    .single();
  if (error) falhar("createCopilotResposta", error);
  return data as CopilotResponse;
}

/** Marca a versão como primária (o trigger `promote` rebaixa a anterior). Só versão aprovada. */
export async function setCopilotRespostaPrimaria(responseId: string): Promise<void> {
  const { data, error: errBusca } = await supabase.from("qs_copilot_objection_responses").select("status").eq("id", responseId).single();
  if (errBusca) falhar("setCopilotRespostaPrimaria.buscar", errBusca);
  if ((data as { status: string }).status !== "aprovada") {
    throw new CopilotoError("setCopilotRespostaPrimaria", null, "Só uma versão aprovada pode ser a primária. Restaure a versão antes.");
  }
  const { error } = await supabase.from("qs_copilot_objection_responses").update({ is_primary: true }).eq("id", responseId);
  if (error) falhar("setCopilotRespostaPrimaria", error);
}

/** Arquiva uma versão (nunca apaga). A primária não pode ser arquivada: escolha outra antes. */
export async function arquivarCopilotResposta(responseId: string): Promise<void> {
  const { data, error: errBusca } = await supabase.from("qs_copilot_objection_responses").select("is_primary").eq("id", responseId).single();
  if (errBusca) falhar("arquivarCopilotResposta.buscar", errBusca);
  if ((data as { is_primary: boolean }).is_primary) {
    throw new CopilotoError("arquivarCopilotResposta", null, "Esta é a versão exibida ao closer. Torne outra primária antes de arquivar.");
  }
  const { error } = await supabase.from("qs_copilot_objection_responses").update({ status: "arquivada" }).eq("id", responseId);
  if (error) falhar("arquivarCopilotResposta", error);
}

export async function restaurarCopilotResposta(responseId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("qs_copilot_objection_responses")
    .update({ status: "aprovada", aprovado_por: userId, aprovado_at: new Date().toISOString() })
    .eq("id", responseId);
  if (error) falhar("restaurarCopilotResposta", error);
}

/** O que o Copiloto ouviu nos últimos N dias sem objeção correspondente (objection_id NULL). */
export async function fetchCopilotLacunas(dias = 30, limite = 8): Promise<CopilotLacuna[]> {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("qs_copilot_detections")
    .select("trecho, categoria, created_at")
    .is("objection_id", null)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) falhar("fetchCopilotLacunas", error);

  const mapa = new Map<string, CopilotLacuna>();
  for (const l of (data ?? []) as Array<{ trecho: string; categoria: string; created_at: string }>) {
    const chave = normalizarTrecho(l.trecho);
    const atual = mapa.get(chave);
    if (atual) {
      atual.ocorrencias += 1;
      if (l.created_at > atual.ultima_em) atual.ultima_em = l.created_at;
    } else {
      mapa.set(chave, { trecho: l.trecho, categoria: l.categoria, ocorrencias: 1, ultima_em: l.created_at });
    }
  }
  return [...mapa.values()].sort((a, b) => b.ocorrencias - a.ocorrencias).slice(0, limite);
}

function normalizarTrecho(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALLS
// ═══════════════════════════════════════════════════════════════════════════════

// `qs_users!closer_id`: calls tem duas FKs para qs_users (closer_id, consent_by).
const SELECT_CALL =
  "*, lead:qs_leads(id, full_name, company_name, status, closed_value, estimated_value, loss_reason_id), closer:qs_users!closer_id(id, name), meeting:qs_meetings!meeting_id(id, scheduled_at, status, meeting_url), summary:qs_copilot_summaries(*)";

/** O embed 1:1 de summaries pode vir como objeto ou array conforme a versão do PostgREST. */
function normalizarCall(c: CopilotCall): CopilotCall {
  const s = c.summary as unknown;
  c.summary = Array.isArray(s) ? ((s[0] as CopilotSummary | undefined) ?? null) : ((s as CopilotSummary | null) ?? null);
  return c;
}

export interface CallFiltros {
  closer_id?: string;
  inicio?: string;
  fim?: string;
  temperatura?: CopilotTemperatura;
  status?: CopilotCallStatus;
  limite?: number;
}

export async function fetchCopilotCalls(filtros?: CallFiltros): Promise<CopilotCall[]> {
  // Com filtro de temperatura o embed vira inner join, senão call sem resumo passaria.
  const select = filtros?.temperatura ? SELECT_CALL.replace("summary:qs_copilot_summaries(*)", "summary:qs_copilot_summaries!inner(*)") : SELECT_CALL;
  let q = supabase
    .from("qs_copilot_calls")
    .select(select)
    .neq("status", "descartada")
    .order("created_at", { ascending: false })
    .limit(filtros?.limite ?? 200);
  if (filtros?.closer_id) q = q.eq("closer_id", filtros.closer_id);
  if (filtros?.inicio) q = q.gte("created_at", filtros.inicio);
  if (filtros?.fim) q = q.lt("created_at", filtros.fim);
  if (filtros?.status) q = q.eq("status", filtros.status);
  if (filtros?.temperatura) q = q.eq("summary.temperatura", filtros.temperatura);

  const { data, error } = await q;
  if (error) falhar("fetchCopilotCalls", error);
  const calls = ((data ?? []) as CopilotCall[]).map(normalizarCall);
  if (calls.length === 0) return calls;

  // Objeções e sugestões usadas por call: uma query, agregação no cliente.
  const { data: det, error: errDet } = await supabase
    .from("qs_copilot_detections")
    .select("call_id, closer_usou")
    .in("call_id", calls.map((c) => c.id));
  if (errDet) falhar("fetchCopilotCalls.deteccoes", errDet);

  const contagem = new Map<string, { total: number; usadas: number }>();
  for (const d of (det ?? []) as Array<{ call_id: string; closer_usou: boolean | null }>) {
    const c = contagem.get(d.call_id) ?? { total: 0, usadas: 0 };
    c.total += 1;
    if (d.closer_usou === true) c.usadas += 1;
    contagem.set(d.call_id, c);
  }
  for (const c of calls) {
    c._deteccoes = contagem.get(c.id)?.total ?? 0;
    c._usadas = contagem.get(c.id)?.usadas ?? 0;
  }
  return calls;
}

export async function fetchCopilotCall(id: string): Promise<CopilotCall> {
  const { data, error } = await supabase.from("qs_copilot_calls").select(SELECT_CALL).eq("id", id).single();
  if (error) falhar("fetchCopilotCall", error);
  return normalizarCall(data as CopilotCall);
}

export async function fetchCopilotTranscricao(callId: string): Promise<CopilotTurn[]> {
  const { data, error } = await supabase
    .from("qs_copilot_transcript_turns")
    .select("*")
    .eq("call_id", callId)
    .eq("is_final", true)
    .order("seq", { ascending: true })
    .limit(5000);
  if (error) falhar("fetchCopilotTranscricao", error);
  return (data ?? []) as CopilotTurn[];
}

export async function fetchCopilotDeteccoes(callId: string): Promise<CopilotDetection[]> {
  const { data, error } = await supabase
    .from("qs_copilot_detections")
    .select(
      "*, objection:qs_copilot_objections(id, titulo), response:qs_copilot_objection_responses(id, texto, versao), feedback:qs_copilot_feedback(resultado, motivo, comentario)"
    )
    .eq("call_id", callId)
    .order("detected_at_ms", { ascending: true });
  if (error) falhar("fetchCopilotDeteccoes", error);
  return ((data ?? []) as CopilotDetection[]).map((d) => {
    const f = d.feedback as unknown;
    d.feedback = Array.isArray(f) ? ((f[0] as CopilotDetection["feedback"]) ?? null) : ((f as CopilotDetection["feedback"]) ?? null);
    return d;
  });
}

/**
 * Calls vinculadas a reuniões (botão "Ver call" na MeetingsPage).
 * `qs_meetings.copilot_call_id` só é preenchido pelo trigger ao concluir; para call
 * em andamento, o vínculo é por `meeting_id`. Devolve a mais recente por reunião.
 */
export async function fetchCallsPorReunioes(meetingIds: string[]): Promise<Map<string, Pick<CopilotCall, "id" | "meeting_id" | "status" | "closer_id" | "started_at">>> {
  const mapa = new Map<string, Pick<CopilotCall, "id" | "meeting_id" | "status" | "closer_id" | "started_at">>();
  if (meetingIds.length === 0) return mapa;
  const { data, error } = await supabase
    .from("qs_copilot_calls")
    .select("id, meeting_id, status, closer_id, started_at")
    .in("meeting_id", meetingIds)
    .neq("status", "descartada")
    .order("created_at", { ascending: false });
  if (error) falhar("fetchCallsPorReunioes", error);
  for (const c of (data ?? []) as Array<Pick<CopilotCall, "id" | "meeting_id" | "status" | "closer_id" | "started_at">>) {
    if (c.meeting_id && !mapa.has(c.meeting_id)) mapa.set(c.meeting_id, c);
  }
  return mapa;
}

/** Grava o link da sala na reunião (coluna de 005). A extensão casa a aba com a reunião por ele. */
export async function salvarLinkDaReuniao(meetingId: string, url: string): Promise<void> {
  const limpo = url.trim();
  if (!/^https?:\/\//i.test(limpo)) throw new CopilotoError("salvarLinkDaReuniao", null, "Cole o link completo da sala (começa com https://).");
  const { error } = await supabase.from("qs_meetings").update({ meeting_url: limpo }).eq("id", meetingId);
  if (error) falhar("salvarLinkDaReuniao", error);
}

// ── Pós-call → QS (Q-3 / Q-4 manuais; o gateway também faz automático) ────────

export async function criarTarefaDaCall(input: CopilotNovaTarefa, summaryId?: string | null): Promise<Task> {
  const { data, error } = await supabase
    .from("qs_tasks")
    .insert({
      lead_id: input.lead_id,
      cadence_id: null,
      owner_id: input.owner_id,
      channel_type: input.channel_type,
      priority: input.priority,
      scheduled_at: input.scheduled_at,
      status: "pendente",
      is_extra: true,
      notes: input.notes,
    })
    .select("*")
    .single();
  if (error) falhar("criarTarefaDaCall", error);
  const tarefa = data as Task;
  if (summaryId) {
    const { error: errLink } = await supabase.from("qs_copilot_summaries").update({ proximo_passo_task_id: tarefa.id }).eq("id", summaryId);
    if (errLink) falhar("criarTarefaDaCall.vincular", errLink);
  }
  return tarefa;
}

export async function salvarResumoComoNota(leadId: string, authorId: string, corpo: string, summaryId?: string | null): Promise<Note> {
  const { data, error } = await supabase.from("qs_notes").insert({ lead_id: leadId, author_id: authorId, body: corpo }).select("*").single();
  if (error) falhar("salvarResumoComoNota", error);
  const nota = data as Note;
  if (summaryId) {
    const { error: errLink } = await supabase.from("qs_copilot_summaries").update({ nota_id: nota.id }).eq("id", summaryId);
    if (errLink) falhar("salvarResumoComoNota.vincular", errLink);
  }
  return nota;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS — agregação no cliente por período (as views da Frente A têm janela
// fixa de 30/90 dias; aqui o gestor escolhe o período)
// ═══════════════════════════════════════════════════════════════════════════════

export function periodoDias(dias: number): CopilotPeriodo {
  const fim = new Date();
  fim.setHours(23, 59, 59, 999);
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - (dias - 1));
  inicio.setHours(0, 0, 0, 0);
  return { inicio: inicio.toISOString(), fim: new Date(fim.getTime() + 1).toISOString() };
}

interface CallAgregavel {
  id: string;
  closer_id: string;
  status: CopilotCallStatus;
  duration_seconds: number | null;
  stt_cost_usd: number;
  llm_cost_usd: number;
  total_cost_brl: number;
  lead: { status: string } | null;
  closer: { name: string } | null;
  summary: { talk_ratio_closer: number | null } | { talk_ratio_closer: number | null }[] | null;
}

interface DeteccaoAgregavel {
  call_id: string;
  closer_id: string;
  categoria: string;
  objection_id: string | null;
  shown_at: string | null;
  closer_usou: boolean | null;
  latency_ms: number | null;
  objection: { titulo: string } | null;
}

function percentil(valores: number[], p: number): number | null {
  if (valores.length === 0) return null;
  const s = [...valores].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function pct(num: number, den: number, casas = 1): number | null {
  if (den <= 0) return null;
  const f = 10 ** casas;
  return Math.round((num / den) * 100 * f) / f;
}

export async function fetchAnalyticsPeriodo(periodo: CopilotPeriodo, closerId?: string): Promise<CopilotAnalyticsPeriodo> {
  let qc = supabase
    .from("qs_copilot_calls")
    .select("id, closer_id, status, duration_seconds, stt_cost_usd, llm_cost_usd, total_cost_brl, lead:qs_leads(status), closer:qs_users!closer_id(name), summary:qs_copilot_summaries(talk_ratio_closer)")
    .neq("status", "descartada")
    .gte("created_at", periodo.inicio)
    .lt("created_at", periodo.fim)
    .limit(5000);
  if (closerId) qc = qc.eq("closer_id", closerId);
  const { data: callsRaw, error: errC } = await qc;
  if (errC) falhar("fetchAnalyticsPeriodo.calls", errC);
  const calls = (callsRaw ?? []) as unknown as CallAgregavel[];

  let qd = supabase
    .from("qs_copilot_detections")
    .select("call_id, closer_id, categoria, objection_id, shown_at, closer_usou, latency_ms, objection:qs_copilot_objections(titulo)")
    .gte("created_at", periodo.inicio)
    .lt("created_at", periodo.fim)
    .limit(20000);
  if (closerId) qd = qd.eq("closer_id", closerId);
  const { data: detRaw, error: errD } = await qd;
  if (errD) falhar("fetchAnalyticsPeriodo.deteccoes", errD);
  const deteccoes = (detRaw ?? []) as unknown as DeteccaoAgregavel[];

  const desfechoPorCall = new Map<string, string | null>();
  for (const c of calls) desfechoPorCall.set(c.id, c.lead?.status ?? null);

  // ── KPIs ──
  const exibidas = deteccoes.filter((d) => d.shown_at);
  const usadas = deteccoes.filter((d) => d.closer_usou === true);
  const comFeedback = deteccoes.filter((d) => d.closer_usou !== null);
  const latencias = deteccoes.map((d) => d.latency_ms).filter((v): v is number => v !== null);
  const ganhas = calls.filter((c) => c.lead?.status === "ganho").length;
  const perdidas = calls.filter((c) => c.lead?.status === "perdido").length;
  const minutos = calls.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / 60;
  const custoBrl = calls.reduce((s, c) => s + Number(c.total_cost_brl ?? 0), 0);

  const kpis = {
    calls: calls.length,
    concluidas: calls.filter((c) => c.status === "concluida").length,
    minutos: Math.round(minutos),
    objecoes: deteccoes.length,
    objecoes_por_call: calls.length > 0 ? Math.round((deteccoes.length / calls.length) * 10) / 10 : 0,
    exibidas: exibidas.length,
    usadas: usadas.length,
    taxa_uso_pct: pct(usadas.length, exibidas.length, 0),
    taxa_feedback_pct: pct(comFeedback.length, exibidas.length, 0),
    latencia_p50_ms: percentil(latencias, 0.5),
    latencia_p95_ms: percentil(latencias, 0.95),
    calls_ganhas: ganhas,
    calls_perdidas: perdidas,
    fechamento_pct: pct(ganhas, ganhas + perdidas, 0),
    custo_brl: Math.round(custoBrl * 100) / 100,
  };

  // ── Agregação por categoria e por objeção ──
  function agregar(chave: (d: DeteccaoAgregavel) => string, montar: (d: DeteccaoAgregavel) => Pick<CopilotObjecaoAgregada, "categoria" | "objection_id" | "titulo">) {
    const mapa = new Map<string, CopilotObjecaoAgregada & { _calls: Set<string>; _lat: number[]; _callsDesfecho: Map<string, string | null> }>();
    for (const d of deteccoes) {
      const k = chave(d);
      let r = mapa.get(k);
      if (!r) {
        r = {
          ...montar(d),
          deteccoes: 0,
          calls: 0,
          exibidas: 0,
          usadas: 0,
          nao_serviram: 0,
          taxa_uso_pct: null,
          latencia_p50_ms: null,
          calls_ganhas: 0,
          calls_perdidas: 0,
          _calls: new Set(),
          _lat: [],
          _callsDesfecho: new Map(),
        };
        mapa.set(k, r);
      }
      r.deteccoes += 1;
      r._calls.add(d.call_id);
      r._callsDesfecho.set(d.call_id, desfechoPorCall.get(d.call_id) ?? null);
      if (d.shown_at) r.exibidas += 1;
      if (d.closer_usou === true) r.usadas += 1;
      if (d.closer_usou === false) r.nao_serviram += 1;
      if (d.latency_ms !== null) r._lat.push(d.latency_ms);
    }
    return [...mapa.values()]
      .map(({ _calls, _lat, _callsDesfecho, ...r }) => ({
        ...r,
        calls: _calls.size,
        taxa_uso_pct: pct(r.usadas, r.exibidas),
        latencia_p50_ms: percentil(_lat, 0.5),
        calls_ganhas: [..._callsDesfecho.values()].filter((s) => s === "ganho").length,
        calls_perdidas: [..._callsDesfecho.values()].filter((s) => s === "perdido").length,
      }))
      .sort((a, b) => b.deteccoes - a.deteccoes);
  }

  const por_categoria = agregar(
    (d) => d.categoria,
    (d) => ({ categoria: d.categoria, objection_id: null, titulo: null })
  );
  const por_objecao = agregar(
    (d) => d.objection_id ?? `_sem:${d.categoria}`,
    (d) => ({ categoria: d.categoria, objection_id: d.objection_id, titulo: d.objection?.titulo ?? null })
  );

  // ── Ranking por closer ──
  const porCloser = new Map<string, CopilotRankingCloser & { _lat: number[]; _talk: number[] }>();
  function pegar(id: string, nome: string) {
    let r = porCloser.get(id);
    if (!r) {
      r = {
        closer_id: id,
        closer: nome,
        calls: 0,
        minutos: 0,
        objecoes: 0,
        objecoes_por_call: 0,
        exibidas: 0,
        usadas: 0,
        taxa_uso_pct: null,
        latencia_p50_ms: null,
        talk_ratio_medio: null,
        calls_ganhas: 0,
        calls_perdidas: 0,
        fechamento_pct: null,
        custo_brl: 0,
        _lat: [],
        _talk: [],
      };
      porCloser.set(id, r);
    }
    return r;
  }
  for (const c of calls) {
    const r = pegar(c.closer_id, c.closer?.name ?? "Closer");
    r.calls += 1;
    r.minutos += (c.duration_seconds ?? 0) / 60;
    if (c.lead?.status === "ganho") r.calls_ganhas += 1;
    if (c.lead?.status === "perdido") r.calls_perdidas += 1;
    r.custo_brl += Number(c.total_cost_brl ?? 0);
    const s = Array.isArray(c.summary) ? c.summary[0] : c.summary;
    if (s?.talk_ratio_closer !== null && s?.talk_ratio_closer !== undefined) r._talk.push(Number(s.talk_ratio_closer));
  }
  for (const d of deteccoes) {
    const r = pegar(d.closer_id, porCloser.get(d.closer_id)?.closer ?? "Closer");
    r.objecoes += 1;
    if (d.shown_at) r.exibidas += 1;
    if (d.closer_usou === true) r.usadas += 1;
    if (d.latency_ms !== null) r._lat.push(d.latency_ms);
  }
  const ranking = [...porCloser.values()]
    .map(({ _lat, _talk, ...r }) => ({
      ...r,
      minutos: Math.round(r.minutos),
      objecoes_por_call: r.calls > 0 ? Math.round((r.objecoes / r.calls) * 10) / 10 : 0,
      taxa_uso_pct: pct(r.usadas, r.exibidas),
      latencia_p50_ms: percentil(_lat, 0.5),
      talk_ratio_medio: _talk.length ? Math.round(_talk.reduce((a, b) => a + b, 0) / _talk.length) : null,
      fechamento_pct: pct(r.calls_ganhas, r.calls_ganhas + r.calls_perdidas),
      custo_brl: Math.round(r.custo_brl * 100) / 100,
    }))
    .sort((a, b) => (b.fechamento_pct ?? -1) - (a.fechamento_pct ?? -1) || (b.taxa_uso_pct ?? -1) - (a.taxa_uso_pct ?? -1));

  // ── Custo ──
  const stt = calls.reduce((s, c) => s + Number(c.stt_cost_usd ?? 0), 0);
  const llm = calls.reduce((s, c) => s + Number(c.llm_cost_usd ?? 0), 0);
  const custo = {
    calls: calls.length,
    minutos: Math.round(minutos),
    stt_usd: stt,
    llm_usd: llm,
    total_brl: custoBrl,
    media_por_call_brl: calls.length > 0 ? custoBrl / calls.length : 0,
    custo_por_minuto_brl: minutos > 0 ? custoBrl / minutos : 0,
    calls_acima_do_teto: calls.filter((c) => Number(c.total_cost_brl ?? 0) > 5).length,
  };

  return { kpis, por_categoria, por_objecao, ranking, custo };
}

/** View da Frente A: objeções cruzadas com desfecho do lead e qs_loss_reasons (histórico, ≥ 3 calls). */
export async function fetchObjecoesLeadsPerdidos(limite = 12): Promise<CopilotObjecaoLeadPerdido[]> {
  const { data, error } = await supabase.from("qs_copilot_vw_objecoes_leads_perdidos").select("*").limit(limite);
  if (error) falhar("fetchObjecoesLeadsPerdidos", error);
  return ((data ?? []) as CopilotObjecaoLeadPerdido[]).map((r) => ({
    ...r,
    calls_com_objecao: Number(r.calls_com_objecao),
    calls_perdidas: Number(r.calls_perdidas),
    calls_ganhas: Number(r.calls_ganhas),
    taxa_perda_pct: r.taxa_perda_pct === null ? null : Number(r.taxa_perda_pct),
    receita_perdida_estimada: Number(r.receita_perdida_estimada ?? 0),
    receita_ganha: Number(r.receita_ganha ?? 0),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAREAMENTO — via gateway (Frente B). A tabela qs_copilot_pairing_codes é
// exclusiva do service_role; o QS nunca a toca direto.
//
//   POST {VITE_COPILOT_API_URL}/v1/pairing/codigo
//     Authorization: Bearer <access_token do Supabase Auth>      (oficial)
//     ou corpo { email, senha }                                   (PAIRING_ACEITA_SENHA_LEGADA=true)
//   → 201 { codigo, expiraEm, ttlSegundos }
// ═══════════════════════════════════════════════════════════════════════════════

export function urlDoGateway(): string {
  const url = (import.meta.env.VITE_COPILOT_API_URL as string | undefined)?.replace(/\/+$/, "");
  if (!url) {
    throw new CopilotoError("urlDoGateway", null, "VITE_COPILOT_API_URL não está definida no .env do QS. Sem ela não há como falar com o gateway do Copiloto.");
  }
  return url;
}

/** Access token do Supabase Auth, se o QS já estiver logado por ele (Fase 3 da migração). */
export async function tokenSupabaseAtual(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function gerarCodigoPareamento(credencialLegada?: { email: string; senha: string }): Promise<CopilotCodigoPareamento> {
  const base = urlDoGateway();
  const token = await tokenSupabaseAtual();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: string | undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (credencialLegada) body = JSON.stringify({ email: credencialLegada.email.trim().toLowerCase(), senha: credencialLegada.senha });
  else {
    throw new CopilotoError(
      "gerarCodigoPareamento",
      null,
      "O QS ainda não está logado pelo Supabase Auth. Informe e-mail e senha para o gateway validar (modo transitório)."
    );
  }

  let resposta: Response;
  try {
    resposta = await fetch(`${base}/v1/pairing/codigo`, { method: "POST", headers, body: body ?? "{}" });
  } catch (e) {
    throw new CopilotoError("gerarCodigoPareamento", e, `Não foi possível falar com o gateway em ${base}. Ele está no ar?`);
  }
  const texto = await resposta.text();
  let json: Record<string, unknown> = {};
  try {
    json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  } catch {
    json = { message: texto };
  }
  if (!resposta.ok) {
    const msg = (json.mensagem ?? json.message ?? json.error ?? `HTTP ${resposta.status}`) as string;
    throw new CopilotoError("gerarCodigoPareamento", json, `O gateway recusou o pedido: ${msg}`);
  }
  const r = json as unknown as CopilotCodigoPareamento;
  if (!r.codigo || !r.expiraEm) throw new CopilotoError("gerarCodigoPareamento", json, "Resposta inesperada do gateway (sem código).");
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// USUÁRIOS (closers para filtros)
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchClosers(): Promise<Array<{ id: string; name: string; role: string }>> {
  const { data, error } = await supabase
    .from("qs_users")
    .select("id, name, role")
    .eq("is_active", true)
    .in("role", ["closer", "gestor", "admin"])
    .order("name");
  if (error) falhar("fetchClosers", error);
  return (data ?? []) as Array<{ id: string; name: string; role: string }>;
}

export type { CopilotObjecaoAgregada, CopilotRankingCloser };
