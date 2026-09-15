/**
 * Cliente de IA (Anthropic) — L2 classificação (Haiku 4.5), L3 geração
 * (Sonnet 5) e resumo pós-call (Sonnet 5).
 *
 * Decisões:
 *   • Structured outputs (`messages.parse` + Zod): o JSON volta validado.
 *     Sem `JSON.parse` de texto solto como no protótipo.
 *   • Prompt caching: sistema fixo + digest do playbook com `cache_control`
 *     (TTL 1 h). Conteúdo do turno vai na mensagem do usuário.
 *   • Latência: Haiku sem thinking; Sonnet no L3 com thinking desligado e
 *     effort baixo (uma frase de 20 palavras não precisa raciocinar 2 s).
 *   • Erros: cadeia tipada (429 → métrica + breaker + degradação Sonnet→Haiku;
 *     5xx/conexão → breaker; 4xx → não recuperável). Tudo vira ErroDependencia.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Candidato } from "../db/repositorio.js";
import type { Logger } from "../logger.js";
import type { Metricas } from "../observabilidade/metricas.js";
import { ErroDependencia } from "../util/erros.js";
import { CircuitBreaker } from "./circuito.js";
import { SISTEMA_CLASSIFICADOR, SISTEMA_GERADOR, SISTEMA_RESUMO, mensagemClassificador, mensagemGerador, mensagemResumo } from "./prompts.js";
import type { ClienteIa, ContextoTurno, RespostaIa, ResultadoClassificacao, ResumoCall } from "./tipos.js";

const EsquemaClassificacao = z.object({
  agir: z.boolean(),
  categoria: z.string(),
  candidato: z.number().int().nullable(),
  sinal_de_compra: z.boolean(),
  temperatura: z.enum(["frio", "morno", "quente"]),
  motivo: z.string(),
});

const EsquemaResumo = z.object({
  resumo: z.string(),
  perfil: z.string(),
  objecoes: z.array(z.object({ categoria: z.string(), descricao: z.string(), superada: z.boolean().nullable() })),
  temperatura: z.enum(["frio", "morno", "quente"]),
  temperatura_score: z.number().int().min(0).max(100),
  proximo_passo: z
    .object({
      descricao: z.string(),
      prazo_dias: z.number().int().nullable(),
      canal: z.enum(["ligacao", "whatsapp", "email"]),
    })
    .nullable(),
  pontos_positivos: z.array(z.string()),
  pontos_atencao: z.array(z.string()),
  destino: z.string().nullable(),
  orcamento: z.number().nullable(),
  janela_viagem: z.string().nullable(),
  pax: z.number().int().nullable(),
  objecoes_novas: z.array(
    z.object({ categoria: z.string(), titulo: z.string(), como_o_lead_falou: z.string(), resposta_sugerida: z.string() }),
  ),
});

export interface ConfigClienteAnthropic {
  apiKey: string;
  modelos: { classificador: string; gerador: string; resumo: string };
  /** Digest estável do playbook (cache do prompt). */
  digestPlaybook: () => string;
  log: Logger;
  metricas: Metricas;
  breaker?: CircuitBreaker;
  /** Injetável nos testes. */
  cliente?: Anthropic;
}

export class ClienteAnthropic implements ClienteIa {
  readonly modelos: ConfigClienteAnthropic["modelos"];
  private readonly cliente: Anthropic;
  private readonly breaker: CircuitBreaker;

  constructor(private readonly cfg: ConfigClienteAnthropic) {
    this.modelos = cfg.modelos;
    this.cliente = cfg.cliente ?? new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1, timeout: 8_000 });
    this.breaker = cfg.breaker ?? new CircuitBreaker();
  }

  get estadoCircuito() {
    return this.breaker.estado;
  }

  private sistema(base: string, comDigest: boolean): Anthropic.TextBlockParam[] {
    const blocos: Anthropic.TextBlockParam[] = [{ type: "text", text: base }];
    if (comDigest) blocos.push({ type: "text", text: this.cfg.digestPlaybook() });
    // cache_control no ÚLTIMO bloco estável: tudo antes dele entra no prefixo cacheado.
    blocos[blocos.length - 1]!.cache_control = { type: "ephemeral", ttl: "1h" };
    return blocos;
  }

  async classificar(ctx: ContextoTurno, candidatos: Candidato[]): Promise<RespostaIa<ResultadoClassificacao>> {
    return this.executar("l2_classificacao", this.modelos.classificador, async (modelo) => {
      const r = await this.cliente.messages.parse({
        model: modelo,
        max_tokens: 300,
        system: this.sistema(SISTEMA_CLASSIFICADOR, true),
        messages: [{ role: "user", content: mensagemClassificador(ctx.historico, ctx.texto, ctx.briefing, candidatos) }],
        output_config: { format: zodOutputFormat(EsquemaClassificacao) },
      });
      if (r.stop_reason === "refusal") {
        this.cfg.log.warn({ categoria: r.stop_details?.category }, "classificador recusou; tratando como conversa normal");
        return { dado: semAcao("recusa do modelo"), uso: r.usage, modelo: r.model };
      }
      const p = r.parsed_output;
      if (!p) throw new ErroDependencia("anthropic", "classificador devolveu JSON inválido", undefined, false);
      const idx = p.candidato != null && p.candidato >= 1 && p.candidato <= candidatos.length ? p.candidato - 1 : null;
      return {
        dado: {
          agir: p.agir,
          categoriaId: p.sinal_de_compra ? "sinal_compra" : p.categoria,
          candidatoEscolhido: p.agir ? idx : null,
          sinalDeCompra: p.sinal_de_compra,
          temperatura: p.temperatura,
          motivo: p.motivo,
        },
        uso: r.usage,
        modelo: r.model,
      };
    });
  }

  async gerar(ctx: ContextoTurno, classificacao: ResultadoClassificacao, candidatos: Candidato[]): Promise<RespostaIa<{ resposta: string }>> {
    return this.executar("l3_geracao", this.modelos.gerador, async (modelo) => {
      const r = await this.cliente.messages.create({
        model: modelo,
        max_tokens: 80,
        // Latência é o produto: uma frase de 20 palavras não precisa de raciocínio estendido.
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: this.sistema(SISTEMA_GERADOR, false),
        messages: [
          {
            role: "user",
            content: mensagemGerador(ctx.historico, ctx.texto, ctx.briefing, classificacao.categoriaId, classificacao.sinalDeCompra, candidatos),
          },
        ],
      });
      if (r.stop_reason === "refusal") {
        throw new ErroDependencia("anthropic", `gerador recusou (${r.stop_details?.category ?? "sem categoria"})`, undefined, false);
      }
      const texto = r.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text?.trim() ?? "";
      return { dado: { resposta: texto }, uso: r.usage, modelo: r.model };
    });
  }

  async resumir(transcricao: string, briefing: string | null, _categorias: Array<{ id: string; label: string }>): Promise<RespostaIa<ResumoCall>> {
    return this.executar("resumo_pos_call", this.modelos.resumo, async (modelo) => {
      const r = await this.cliente.messages.parse(
        {
          model: modelo,
          max_tokens: 4000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: zodOutputFormat(EsquemaResumo) },
          system: this.sistema(SISTEMA_RESUMO, true),
          messages: [{ role: "user", content: mensagemResumo(transcricao, briefing) }],
        },
        { timeout: 90_000 },
      );
      if (r.stop_reason === "refusal") {
        throw new ErroDependencia("anthropic", `resumo recusado (${r.stop_details?.category ?? "sem categoria"})`, undefined, false);
      }
      const p = r.parsed_output;
      if (!p) throw new ErroDependencia("anthropic", "resumo devolveu JSON inválido", undefined, false);
      const dado: ResumoCall = {
        resumo: p.resumo,
        perfil: p.perfil,
        objecoes: p.objecoes.map((o) => ({ categoriaId: o.categoria, descricao: o.descricao, superada: o.superada })),
        temperatura: p.temperatura,
        temperaturaScore: p.temperatura_score,
        proximoPasso: p.proximo_passo
          ? { descricao: p.proximo_passo.descricao, prazoDias: p.proximo_passo.prazo_dias, canal: p.proximo_passo.canal }
          : null,
        pontosPositivos: p.pontos_positivos,
        pontosAtencao: p.pontos_atencao,
        destino: p.destino,
        orcamento: p.orcamento,
        janelaViagem: p.janela_viagem,
        pax: p.pax,
        objecoesNovas: p.objecoes_novas.map((o) => ({
          categoriaId: o.categoria,
          titulo: o.titulo,
          comoOLeadFalou: o.como_o_lead_falou,
          respostaSugerida: o.resposta_sugerida,
        })),
      };
      return { dado, uso: r.usage, modelo: r.model };
    });
  }

  // ── infraestrutura comum ──────────────────────────────────────────────────

  /**
   * Executa uma chamada com breaker, métrica de latência, tokens e cadeia de
   * erros. Em 429 no Sonnet, degrada para Haiku uma vez (nunca falha por
   * rate limit se houver alternativa).
   */
  private async executar<T>(
    etapa: "l2_classificacao" | "l3_geracao" | "resumo_pos_call",
    modelo: string,
    fn: (modelo: string) => Promise<Omit<RespostaIa<T>, "ms">>,
    tentativaDegradada = false,
  ): Promise<RespostaIa<T>> {
    if (this.breaker.bloqueado()) {
      this.cfg.metricas.circuito.set({ servico: "anthropic" }, 1);
      throw new ErroDependencia("anthropic", "circuito aberto (falhas recentes); L2/L3 pausados por 30 s", undefined, true);
    }
    const fim = this.cfg.metricas.cronometro(etapa);
    try {
      const r = await fn(modelo);
      const ms = fim();
      this.breaker.registrarSucesso();
      this.cfg.metricas.circuito.set({ servico: "anthropic" }, 0);
      this.contarTokens(r.modelo, r.uso);
      return { ...r, ms };
    } catch (err) {
      fim();
      if (err instanceof ErroDependencia) throw err;
      return this.traduzirErro(err, etapa, modelo, fn, tentativaDegradada);
    }
  }

  private async traduzirErro<T>(
    err: unknown,
    etapa: "l2_classificacao" | "l3_geracao" | "resumo_pos_call",
    modelo: string,
    fn: (modelo: string) => Promise<Omit<RespostaIa<T>, "ms">>,
    tentativaDegradada: boolean,
  ): Promise<RespostaIa<T>> {
    if (err instanceof Anthropic.RateLimitError) {
      this.cfg.metricas.anthropic429.inc();
      this.breaker.registrarFalha();
      // Degrada Sonnet → Haiku uma vez. Sugestão do Haiku > silêncio.
      if (!tentativaDegradada && modelo !== this.modelos.classificador) {
        this.cfg.log.warn({ etapa, de: modelo, para: this.modelos.classificador }, "429: degradando para o classificador");
        return this.executar(etapa, this.modelos.classificador, fn, true);
      }
      throw new ErroDependencia("anthropic", `rate limit (429) em ${modelo}`, err, true);
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new ErroDependencia("anthropic", `credencial inválida (${err.status})`, err, false);
    }
    if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
      throw new ErroDependencia("anthropic", `requisição rejeitada (${err.status}): ${err.message}`, err, false);
    }
    if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) {
      this.breaker.registrarFalha();
      throw new ErroDependencia("anthropic", `indisponível: ${err.message}`, err, true);
    }
    if (err instanceof Anthropic.APIError) {
      this.breaker.registrarFalha();
      throw new ErroDependencia("anthropic", `erro ${err.status ?? "?"}: ${err.message}`, err, true);
    }
    this.breaker.registrarFalha();
    throw new ErroDependencia("anthropic", err instanceof Error ? err.message : String(err), err, true);
  }

  private contarTokens(modelo: string, uso: Anthropic.Usage | RespostaIa<unknown>["uso"]): void {
    const m = this.cfg.metricas;
    m.tokens.inc({ modelo, tipo: "entrada" }, uso.input_tokens ?? 0);
    m.tokens.inc({ modelo, tipo: "saida" }, uso.output_tokens ?? 0);
    m.tokens.inc({ modelo, tipo: "cache_leitura" }, uso.cache_read_input_tokens ?? 0);
    m.tokens.inc({ modelo, tipo: "cache_escrita" }, uso.cache_creation_input_tokens ?? 0);
  }
}

function semAcao(motivo: string): ResultadoClassificacao {
  return { agir: false, categoriaId: "outro", candidatoEscolhido: null, sinalDeCompra: false, temperatura: "morno", motivo };
}
