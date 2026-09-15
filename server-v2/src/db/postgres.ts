/**
 * Repositório Postgres (Supabase) — implementação de produção.
 *
 * Toda query lança em caso de erro. Quem chama decide o que fazer (avisar o
 * closer, contar métrica, enfileirar para retry). Nada é engolido aqui.
 */
import pgvector from "pgvector";
import type { ClienteSql } from "./cliente.js";
import { ErroDependencia } from "../util/erros.js";
import type { Briefing } from "../tipos/protocolo.js";
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

const CONFIG_PADRAO: ConfigCopiloto = {
  limiarSimilaridade: 0.78,
  maxSugestoes: 3,
  cooldownSegundos: 20,
  minPalavrasGatilho: 4,
  janelaContextoTurnos: 6,
  categoriasAtivas: ["preco", "timing", "autoridade", "confianca", "concorrente", "escopo", "pagamento", "sinal_compra"],
};

export class RepositorioPostgres implements RepositorioCopiloto {
  constructor(private readonly sql: ClienteSql) {}

  /** Envolve qualquer falha do driver num ErroDependencia com contexto. */
  private async exec<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new ErroDependencia("postgres", `${op}: ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }

  // ── Identidade ────────────────────────────────────────────────────────────

  async buscarUsuario(id: string): Promise<UsuarioQs | null> {
    return this.exec("buscarUsuario", async () => {
      const [u] = await this.sql<UsuarioLinha[]>`
        select id, name, email, role, is_active from public.qs_users where id = ${id} limit 1`;
      return u ? mapUsuario(u) : null;
    });
  }

  async buscarUsuarioPorEmail(email: string): Promise<UsuarioQs | null> {
    return this.exec("buscarUsuarioPorEmail", async () => {
      const [u] = await this.sql<UsuarioLinha[]>`
        select id, name, email, role, is_active from public.qs_users
        where lower(email) = lower(${email}) limit 1`;
      return u ? mapUsuario(u) : null;
    });
  }

  async validarSenhaLegada(email: string, senha: string): Promise<UsuarioQs | null> {
    return this.exec("validarSenhaLegada", async () => {
      // Comparação no banco — a senha nunca é lida para o processo nem logada.
      const [u] = await this.sql<UsuarioLinha[]>`
        select id, name, email, role, is_active from public.qs_users
        where lower(email) = lower(${email}) and password = ${senha} and is_active limit 1`;
      return u ? mapUsuario(u) : null;
    });
  }

  // ── Pairing ───────────────────────────────────────────────────────────────

  async salvarCodigoPairing(c: CodigoPairing): Promise<void> {
    await this.exec("salvarCodigoPairing", async () => {
      await this.sql`
        insert into public.qs_copilot_pairing_codes (codigo, closer_id, expira_em)
        values (${c.codigo}, ${c.closerId}, ${new Date(c.expiraEm).toISOString()})`;
    });
  }

  async consumirCodigoPairing(codigo: string): Promise<CodigoPairing | null> {
    return this.exec("consumirCodigoPairing", async () => {
      // DELETE ... RETURNING é atômico: duas extensões com o mesmo código, só uma ganha.
      const [linha] = await this.sql<Array<{ codigo: string; closer_id: string; expira_em: Date }>>`
        delete from public.qs_copilot_pairing_codes
        where codigo = ${codigo} and expira_em > now()
        returning codigo, closer_id, expira_em`;
      // Limpeza oportunista dos expirados (barata, tabela minúscula).
      await this.sql`delete from public.qs_copilot_pairing_codes where expira_em <= now()`;
      return linha ? { codigo: linha.codigo, closerId: linha.closer_id, expiraEm: linha.expira_em.getTime() } : null;
    });
  }

  // ── Playbook ──────────────────────────────────────────────────────────────

  async listarObjecoesAtivas(): Promise<ObjecaoPlaybook[]> {
    return this.exec("listarObjecoesAtivas", async () => {
      const linhas = await this.sql<ObjecaoLinha[]>`
        select o.id, o.category_id, c.label as categoria, o.titulo, o.exemplo_lead,
               o.variacoes, o.gatilhos, o.resposta,
               coalesce(o.resposta_curta, left(o.resposta, 160)) as resposta_curta,
               o.severidade, o.momento
        from public.qs_copilot_objections o
        join public.qs_copilot_categories c on c.id = o.category_id
        where o.is_active and o.is_approved and c.is_active
        order by o.severidade desc, o.uso_total desc`;
      return linhas.map(mapObjecao);
    });
  }

  async buscarObjecoes(embedding: number[], texto: string, limiar: number, n: number): Promise<Candidato[]> {
    return this.exec("buscarObjecoes", async () => {
      const vetor = pgvector.toSql(embedding);
      return this.sql.begin(async (tx) => {
        // Caminho ao vivo: ef_search baixo = p95 < 10 ms na busca.
        await tx`set local hnsw.ef_search = 40`;
        const linhas = await tx<CandidatoLinha[]>`
          select h.id, h.category_id, c.label as categoria, h.titulo, h.resposta,
                 h.resposta_curta, h.similarity, h.rrf_score
          from public.match_objecao_hibrido(${vetor}::vector, ${texto}, ${limiar}, ${n}) h
          join public.qs_copilot_categories c on c.id = h.category_id`;
        return linhas.map((l) => ({
          objecaoId: l.id,
          categoriaId: l.category_id,
          categoria: l.categoria,
          titulo: l.titulo,
          resposta: l.resposta,
          respostaCurta: l.resposta_curta,
          similaridade: Number(l.similarity),
          rrf: Number(l.rrf_score),
        }));
      });
    });
  }

  async carregarConfiguracao(closerId: string): Promise<ConfigCopiloto> {
    return this.exec("carregarConfiguracao", async () => {
      const [s] = await this.sql<Array<Record<string, unknown>>>`
        select * from public.qs_copilot_effective_settings(${closerId})`;
      if (!s) return CONFIG_PADRAO;
      return {
        limiarSimilaridade: Number(s.similarity_threshold ?? CONFIG_PADRAO.limiarSimilaridade),
        maxSugestoes: Number(s.max_sugestoes ?? CONFIG_PADRAO.maxSugestoes),
        cooldownSegundos: Number(s.cooldown_seconds ?? CONFIG_PADRAO.cooldownSegundos),
        minPalavrasGatilho: Number(s.min_palavras_gatilho ?? CONFIG_PADRAO.minPalavrasGatilho),
        janelaContextoTurnos: Number(s.janela_contexto_turnos ?? CONFIG_PADRAO.janelaContextoTurnos),
        categoriasAtivas: Array.isArray(s.categorias_ativas) ? (s.categorias_ativas as string[]) : CONFIG_PADRAO.categoriasAtivas,
      };
    });
  }

  async listarCategorias(): Promise<Array<{ id: string; label: string }>> {
    return this.exec("listarCategorias", async () => {
      return this.sql<Array<{ id: string; label: string }>>`
        select id, label from public.qs_copilot_categories where is_active order by sort_order`;
    });
  }

  // ── Sessão ────────────────────────────────────────────────────────────────

  async criarSessao(d: NovaSessao): Promise<{ id: string }> {
    return this.exec("criarSessao", async () => {
      const metadata = { ...(d.metadata ?? {}), consentimento: d.consentimento };
      const [linha] = await this.sql<Array<{ id: string }>>`
        insert into public.qs_call_sessions
          (id, closer_id, lead_id, meeting_id, platform, meeting_url, stt_provider, stt_model,
           language, status, started_at, metadata)
        values
          (coalesce(${d.id ?? null}::uuid, gen_random_uuid()), ${d.closerId}, ${d.leadId}, ${d.meetingId}, ${d.plataforma}, ${d.meetingUrl},
           ${d.sttProvedor}, ${d.sttModelo}, 'pt-BR', 'gravando', now(), ${this.sql.json(metadata as never)})
        returning id`;
      if (!linha) throw new Error("insert não devolveu id");
      return { id: linha.id };
    });
  }

  async atualizarSessao(id: string, patch: PatchSessao): Promise<void> {
    await this.exec("atualizarSessao", async () => {
      const campos: Record<string, unknown> = {};
      if (patch.status !== undefined) campos.status = patch.status;
      if (patch.startedAt !== undefined) campos.started_at = patch.startedAt;
      if (patch.endedAt !== undefined) campos.ended_at = patch.endedAt;
      if (patch.sttCostUsd !== undefined) campos.stt_cost_usd = patch.sttCostUsd;
      if (patch.llmCostUsd !== undefined) campos.llm_cost_usd = patch.llmCostUsd;
      if (patch.errorMessage !== undefined) campos.error_message = patch.errorMessage;
      if (Object.keys(campos).length) {
        await this.sql`update public.qs_call_sessions set ${this.sql(campos)} where id = ${id}`;
      }
      if (patch.metadata !== undefined) {
        // Merge de jsonb: não sobrescreve o consentimento gravado na criação.
        await this.sql`update public.qs_call_sessions
          set metadata = metadata || ${this.sql.json(patch.metadata as never)} where id = ${id}`;
      }
    });
  }

  async buscarSessao(id: string): Promise<{ id: string; closerId: string; status: string; startedAt: string | null } | null> {
    return this.exec("buscarSessao", async () => {
      const [s] = await this.sql<Array<{ id: string; closer_id: string; status: string; started_at: Date | null }>>`
        select id, closer_id, status, started_at from public.qs_call_sessions where id = ${id}`;
      return s ? { id: s.id, closerId: s.closer_id, status: s.status, startedAt: s.started_at ? s.started_at.toISOString() : null } : null;
    });
  }

  async contarTranscricoes(callId: string): Promise<number> {
    return this.exec("contarTranscricoes", async () => {
      const [r] = await this.sql<Array<{ n: string }>>`
        select count(*)::text as n from public.qs_call_transcripts where call_id = ${callId}`;
      return Number(r?.n ?? 0);
    });
  }

  // ── Reuniões, briefing e consentimento ────────────────────────────────────

  async listarReunioesDoCloser(closerId: string, desde: string, ate: string): Promise<ReuniaoQs[]> {
    return this.exec("listarReunioesDoCloser", async () => {
      // Reunião do closer: ele é dono da reunião OU dono do lead (após o handover do SDR).
      const linhas = await this.sql<Array<Record<string, unknown>>>`
        select m.id, m.lead_id, m.scheduled_at,
               coalesce(l.full_name, nullif(trim(concat_ws(' ', l.first_name, l.last_name)), ''), 'Lead sem nome') as lead_nome,
               l.estimated_value, l.segment,
               (select u.name from public.qs_handovers h join public.qs_users u on u.id = h.from_user_id
                 where h.lead_id = l.id order by h.created_at desc limit 1) as sdr_nome,
               (select sm.destino_mencionado from public.qs_call_sessions s
                 join public.qs_call_summaries sm on sm.call_id = s.id
                 where s.lead_id = l.id and sm.destino_mencionado is not null
                 order by s.started_at desc limit 1) as destino
        from public.qs_meetings m
        join public.qs_leads l on l.id = m.lead_id
        where m.status = 'agendada'
          and m.scheduled_at >= ${desde} and m.scheduled_at < ${ate}
          and (m.owner_id = ${closerId} or l.owner_id = ${closerId})
        order by m.scheduled_at`;
      return linhas.map((r) => ({
        id: r.id as string,
        leadId: r.lead_id as string,
        leadNome: r.lead_nome as string,
        inicio: (r.scheduled_at as Date).toISOString(),
        ...(r.segment ? { produto: r.segment as string } : {}),
        ...(r.destino ? { destino: r.destino as string } : {}),
        ...(r.estimated_value != null ? { ticketEstimado: Number(r.estimated_value) } : {}),
        ...(r.sdr_nome ? { sdrNome: r.sdr_nome as string } : {}),
      }));
    });
  }

  async carregarBriefingCompleto(leadId: string): Promise<BriefingCompleto | null> {
    return this.exec("carregarBriefingCompleto", async () => {
      const [lead] = await this.sql<Array<Record<string, unknown>>>`
        select id, full_name, first_name, last_name, company_name, city, state, source, status, owner_id, estimated_value
        from public.qs_leads where id = ${leadId}`;
      if (!lead) return null;
      const [handover, notas, reunioes, calls] = await Promise.all([
        this.sql<Array<{ briefing: string | null; created_at: Date; sdr: string | null }>>`
          select h.briefing, h.created_at, u.name as sdr from public.qs_handovers h
          left join public.qs_users u on u.id = h.from_user_id
          where h.lead_id = ${leadId} order by h.created_at desc limit 1`,
        this.sql<Array<{ body: string; created_at: Date; autor: string | null }>>`
          select n.body, n.created_at, u.name as autor from public.qs_notes n
          left join public.qs_users u on u.id = n.author_id
          where n.lead_id = ${leadId} order by n.created_at desc limit 5`,
        this.sql<Array<{ scheduled_at: Date; status: string }>>`
          select scheduled_at, status from public.qs_meetings where lead_id = ${leadId}
          order by scheduled_at desc limit 3`,
        this.sql<Array<Record<string, unknown>>>`
          select s.started_at, s.duration_seconds, sm.temperatura, sm.proximo_passo, sm.destino_mencionado, sm.janela_viagem, sm.orcamento_mencionado,
                 (select count(*) from public.qs_copilot_detections d where d.call_id = s.id) as objecoes
          from public.qs_call_sessions s
          left join public.qs_call_summaries sm on sm.call_id = s.id
          where s.lead_id = ${leadId} and s.status = 'concluida'
          order by s.started_at desc limit 5`,
      ]);
      const nome = (lead.full_name as string | null) || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Lead sem nome";
      const status = lead.status as string | null;
      const h = handover[0];
      const ultimaCall = calls[0];
      const historico: BriefingCompleto["historico"] = [
        ...notas.map((n) => ({ data: n.created_at.toISOString(), tipo: "nota" as const, descricao: n.body, ...(n.autor ? { autor: n.autor } : {}) })),
        ...reunioes.map((r) => ({ data: r.scheduled_at.toISOString(), tipo: "reuniao" as const, descricao: `Reunião ${r.status}` })),
        ...calls.map((c) => ({ data: (c.started_at as Date).toISOString(), tipo: "call" as const, descricao: `Call com copiloto · ${c.temperatura ?? "sem resumo"}` })),
      ].sort((a, b) => b.data.localeCompare(a.data));
      return {
        lead: {
          id: lead.id as string,
          nome,
          primeiroNome: (lead.first_name as string | null) || nome.split(" ")[0] || nome,
          ...(lead.city ? { cidade: [lead.city, lead.state].filter(Boolean).join("/") } : {}),
          ...(lead.source ? { origem: lead.source as string } : {}),
          ...(status ? { status } : {}),
          ownerId: (lead.owner_id as string | null) ?? null,
          empresa: (lead.company_name as string | null) ?? null,
          valorEstimado: lead.estimated_value != null ? Number(lead.estimated_value) : null,
        },
        handover: h
          ? { resumo: h.briefing ?? "", notas: notas.slice(0, 3).map((n) => n.body), sdrNome: h.sdr ?? "SDR", criadoEm: h.created_at.toISOString() }
          : null,
        produto: ultimaCall?.destino_mencionado
          ? {
              nome: ultimaCall.destino_mencionado as string,
              destino: ultimaCall.destino_mencionado as string,
              ...(ultimaCall.orcamento_mencionado != null ? { ticketEstimado: Number(ultimaCall.orcamento_mencionado) } : {}),
              ...(ultimaCall.janela_viagem ? { periodo: ultimaCall.janela_viagem as string } : {}),
            }
          : null,
        historico,
        ultimasCalls: calls.map((c) => ({
          data: (c.started_at as Date).toISOString(),
          duracaoMin: Math.round(Number(c.duration_seconds ?? 0) / 60),
          objecoes: Number(c.objecoes ?? 0),
          resultado: status === "ganho" ? "fechou" : status === "perdido" ? "perdido" : c.proximo_passo ? "follow_up" : "sem_fechamento",
        })),
      };
    });
  }

  async registrarConsentimento(c: NovoConsentimento): Promise<{ id: string }> {
    return this.exec("registrarConsentimento", async () => {
      const [linha] = await this.sql<Array<{ id: string }>>`
        insert into public.qs_copilot_consentimentos
          (closer_id, lead_id, meeting_id, aceito, confirmado_em, texto_versao, motivo_recusa, ip, user_agent, versao_extensao)
        values
          (${c.closerId}, ${c.leadId}, ${c.meetingId}, ${c.aceito}, ${c.confirmadoEm}, ${c.textoVersao}, ${c.motivoRecusa},
           ${c.ip}::inet, ${c.userAgent}, ${c.versaoExtensao})
        returning id`;
      if (!linha) throw new Error("insert em qs_copilot_consentimentos não devolveu id");
      return { id: linha.id };
    });
  }

  async buscarConsentimento(id: string): Promise<Consentimento | null> {
    return this.exec("buscarConsentimento", async () => {
      const [c] = await this.sql<Array<Record<string, unknown>>>`
        select id, closer_id, lead_id, meeting_id, aceito, confirmado_em, texto_versao
        from public.qs_copilot_consentimentos where id = ${id}`;
      if (!c) return null;
      return {
        id: c.id as string,
        closerId: c.closer_id as string,
        leadId: (c.lead_id as string | null) ?? null,
        meetingId: (c.meeting_id as string | null) ?? null,
        aceito: Boolean(c.aceito),
        confirmadoEm: (c.confirmado_em as Date).toISOString(),
        textoVersao: c.texto_versao as string,
      };
    });
  }

  async contarSessoesAtivasDoCloser(closerId: string): Promise<number> {
    return this.exec("contarSessoesAtivasDoCloser", async () => {
      const [r] = await this.sql<Array<{ n: string }>>`
        select count(*)::text as n from public.qs_call_sessions
        where closer_id = ${closerId} and status in ('gravando','processando')
          and started_at > now() - interval '3 hours'`;
      return Number(r?.n ?? 0);
    });
  }

  async carregarBriefing(leadId: string): Promise<Briefing | null> {
    return briefingResumido(await this.carregarBriefingCompleto(leadId));
  }

  // ── Fluxo da call ─────────────────────────────────────────────────────────

  async inserirTranscricoes(linhas: LinhaTranscricao[]): Promise<void> {
    if (!linhas.length) return;
    await this.exec("inserirTranscricoes", async () => {
      const valores = linhas.map((l) => ({
        call_id: l.callId,
        closer_id: l.closerId,
        seq: l.seq,
        speaker: l.speaker,
        speaker_tag: l.speakerTag,
        content: l.content.slice(0, 8000),
        ts_start_ms: l.tsStartMs,
        ts_end_ms: l.tsEndMs,
        confidence: l.confidence,
        is_final: true,
      }));
      await this.sql`insert into public.qs_call_transcripts ${this.sql(valores)}
        on conflict (call_id, seq) do nothing`;
    });
  }

  async inserirDeteccao(d: NovaDeteccao): Promise<void> {
    await this.exec("inserirDeteccao", async () => {
      await this.sql`
        insert into public.qs_copilot_detections
          (id, call_id, closer_id, objection_id, category_id, detected_at_ms, trecho, similarity,
           match_method, suggestion_shown, shown_at, latency_ms, outcome, llm_model)
        values
          (${d.id}, ${d.callId}, ${d.closerId}, ${d.objecaoId}, ${d.categoriaId}, ${d.detectedAtMs},
           ${d.trecho.slice(0, 4000)}, ${Math.max(0, Math.min(1, d.similarity))}, ${d.matchMethod},
           ${d.suggestionShown}, now(), ${d.latencyMs}, 'pendente', ${d.llmModel})`;
    });
  }

  async atualizarDeteccao(id: string, callId: string, patch: PatchDeteccao): Promise<boolean> {
    return this.exec("atualizarDeteccao", async () => {
      const campos: Record<string, unknown> = {};
      if (patch.outcome !== undefined) campos.outcome = patch.outcome;
      if (patch.feedbackAt !== undefined) campos.feedback_at = patch.feedbackAt;
      if (patch.feedbackNote !== undefined) campos.feedback_note = patch.feedbackNote;
      if (patch.superada !== undefined) campos.superada = patch.superada;
      if (patch.suggestionShown !== undefined) campos.suggestion_shown = patch.suggestionShown;
      if (patch.objecaoId !== undefined) campos.objection_id = patch.objecaoId;
      if (patch.categoriaId !== undefined) campos.category_id = patch.categoriaId;
      if (patch.similarity !== undefined) campos.similarity = Math.max(0, Math.min(1, patch.similarity));
      if (patch.matchMethod !== undefined) campos.match_method = patch.matchMethod;
      if (patch.latencyMs !== undefined) campos.latency_ms = patch.latencyMs;
      if (patch.llmModel !== undefined) campos.llm_model = patch.llmModel;
      if (!Object.keys(campos).length) return false;
      const r = await this.sql`update public.qs_copilot_detections set ${this.sql(campos)}
        where id = ${id} and call_id = ${callId}`;
      return r.count > 0;
    });
  }

  // ── Pós-call ──────────────────────────────────────────────────────────────

  async gravarResumo(r: NovoResumo): Promise<void> {
    await this.exec("gravarResumo", async () => {
      await this.sql`
        insert into public.qs_call_summaries
          (call_id, closer_id, resumo, proximo_passo, proximo_passo_prazo, temperatura, temperatura_score,
           objecoes_detectadas, pontos_positivos, pontos_atencao, destino_mencionado, orcamento_mencionado,
           janela_viagem, pax_mencionado, talk_ratio_closer, perguntas_closer, monologo_max_seg,
           llm_model, tokens_in, tokens_out, custo_usd)
        values
          (${r.callId}, ${r.closerId}, ${r.resumo}, ${r.proximoPasso}, ${r.proximoPassoPrazo}, ${r.temperatura},
           ${r.temperaturaScore}, ${this.sql.json(r.objecoesDetectadas as never)}, ${r.pontosPositivos}::text[],
           ${r.pontosAtencao}::text[], ${r.destinoMencionado}, ${r.orcamentoMencionado}, ${r.janelaViagem},
           ${r.paxMencionado}, ${r.talkRatioCloser}, ${r.perguntasCloser}, ${r.monologoMaxSeg},
           ${r.llmModel}, ${r.tokensIn}, ${r.tokensOut}, ${r.custoUsd})
        on conflict (call_id) do update set
          resumo = excluded.resumo, proximo_passo = excluded.proximo_passo,
          proximo_passo_prazo = excluded.proximo_passo_prazo, temperatura = excluded.temperatura,
          temperatura_score = excluded.temperatura_score, objecoes_detectadas = excluded.objecoes_detectadas,
          pontos_positivos = excluded.pontos_positivos, pontos_atencao = excluded.pontos_atencao,
          llm_model = excluded.llm_model, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
          custo_usd = excluded.custo_usd`;
    });
  }

  async criarTarefa(t: NovaTarefa): Promise<{ id: string }> {
    return this.exec("criarTarefa", async () => {
      // Mesmas colunas que o TasksPanel do QS usa ao criar tarefa extra.
      const [linha] = await this.sql<Array<{ id: string }>>`
        insert into public.qs_tasks
          (lead_id, cadence_id, owner_id, channel_type, priority, scheduled_at, status, is_extra, contact_attempts, notes)
        values
          (${t.leadId}, (select cadence_id from public.qs_leads where id = ${t.leadId}), ${t.ownerId},
           ${t.channelType}, ${t.priority}, ${t.scheduledAt}, 'pendente', true, 0, ${t.notes})
        returning id`;
      if (!linha) throw new Error("insert em qs_tasks não devolveu id");
      return { id: linha.id };
    });
  }

  async criarNota(n: NovaNota): Promise<{ id: string }> {
    return this.exec("criarNota", async () => {
      const [linha] = await this.sql<Array<{ id: string }>>`
        insert into public.qs_notes (lead_id, author_id, body)
        values (${n.leadId}, ${n.authorId}, ${n.body}) returning id`;
      if (!linha) throw new Error("insert em qs_notes não devolveu id");
      return { id: linha.id };
    });
  }

  async catalogarObjecao(o: NovaObjecaoCatalogada): Promise<{ id: string; nova: boolean }> {
    return this.exec("catalogarObjecao", async () => {
      // Entra NÃO aprovada: vai para a fila de curadoria do gestor no QS.
      const [linha] = await this.sql<Array<{ id: string }>>`
        insert into public.qs_copilot_objections
          (category_id, titulo, exemplo_lead, resposta, resposta_curta, fonte, is_approved, is_active, created_by)
        values
          (${o.categoriaId}, ${o.titulo}, ${o.exemploLead}, ${o.resposta}, ${o.respostaCurta}, 'call_real', false, true, ${o.createdBy})
        on conflict (titulo) do nothing
        returning id`;
      if (linha) return { id: linha.id, nova: true };
      const [existente] = await this.sql<Array<{ id: string }>>`
        select id from public.qs_copilot_objections where titulo = ${o.titulo}`;
      return { id: existente?.id ?? "", nova: false };
    });
  }

  // ── Custo ─────────────────────────────────────────────────────────────────

  async custoDaSessao(callId: string): Promise<CustoSessao | null> {
    return this.exec("custoDaSessao", async () => {
      const [s] = await this.sql<Array<Record<string, unknown>>>`
        select id, closer_id, started_at, ended_at, stt_cost_usd, llm_cost_usd, metadata
        from public.qs_call_sessions where id = ${callId}`;
      if (!s) return null;
      return {
        callId: s.id as string,
        closerId: s.closer_id as string,
        startedAt: s.started_at ? (s.started_at as Date).toISOString() : null,
        endedAt: s.ended_at ? (s.ended_at as Date).toISOString() : null,
        sttCostUsd: Number(s.stt_cost_usd ?? 0),
        llmCostUsd: Number(s.llm_cost_usd ?? 0),
        metadata: (s.metadata as Record<string, unknown>) ?? {},
      };
    });
  }

  async custoPorPeriodo(desde: string, ate: string, closerId: string | null): Promise<ResumoCustoPeriodo> {
    return this.exec("custoPorPeriodo", async () => {
      const linhas = await this.sql<Array<{ closer_id: string; calls: string; stt: string; llm: string }>>`
        select closer_id, count(*)::text as calls,
               coalesce(sum(stt_cost_usd),0)::text as stt, coalesce(sum(llm_cost_usd),0)::text as llm
        from public.qs_call_sessions
        where started_at >= ${desde} and started_at < ${ate}
          and (${closerId}::uuid is null or closer_id = ${closerId})
        group by closer_id`;
      const porCloser = linhas.map((l) => ({
        closerId: l.closer_id,
        calls: Number(l.calls),
        totalUsd: Number(l.stt) + Number(l.llm),
      }));
      const sttUsd = linhas.reduce((a, l) => a + Number(l.stt), 0);
      const llmUsd = linhas.reduce((a, l) => a + Number(l.llm), 0);
      return {
        calls: linhas.reduce((a, l) => a + Number(l.calls), 0),
        sttUsd,
        llmUsd,
        totalUsd: sttUsd + llmUsd,
        porCloser,
      };
    });
  }

  async fechar(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

// ── mapeamentos ─────────────────────────────────────────────────────────────

interface UsuarioLinha {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
}
function mapUsuario(u: UsuarioLinha): UsuarioQs {
  return { id: u.id, nome: u.name, email: u.email, papel: u.role as UsuarioQs["papel"], ativo: u.is_active };
}

interface ObjecaoLinha {
  id: string;
  category_id: string;
  categoria: string;
  titulo: string;
  exemplo_lead: string;
  variacoes: string[] | null;
  gatilhos: string[] | null;
  resposta: string;
  resposta_curta: string;
  severidade: string;
  momento: string;
}
function mapObjecao(o: ObjecaoLinha): ObjecaoPlaybook {
  return {
    id: o.id,
    categoriaId: o.category_id,
    categoria: o.categoria,
    titulo: o.titulo,
    exemploLead: o.exemplo_lead,
    variacoes: o.variacoes ?? [],
    gatilhos: o.gatilhos ?? [],
    resposta: o.resposta,
    respostaCurta: o.resposta_curta,
    severidade: o.severidade as ObjecaoPlaybook["severidade"],
    momento: o.momento,
  };
}

interface CandidatoLinha {
  id: string;
  category_id: string;
  categoria: string;
  titulo: string;
  resposta: string;
  resposta_curta: string;
  similarity: number | string;
  rrf_score: number | string;
}
