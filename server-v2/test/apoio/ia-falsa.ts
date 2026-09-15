/**
 * Cliente de IA determinístico para testes. Decide por palavras-chave e
 * devolve uso de tokens fixo (para o custo ser verificável).
 */
import type { Candidato } from "../../src/db/repositorio.js";
import type { ClienteIa, ContextoTurno, RespostaIa, ResultadoClassificacao, ResumoCall } from "../../src/motor/tipos.js";
import { normalizar } from "../../src/util/texto.js";

const USO = { input_tokens: 400, output_tokens: 60, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 };

export class IaFalsa implements ClienteIa {
  readonly modelos = { classificador: "claude-haiku-4-5", gerador: "claude-sonnet-5", resumo: "claude-sonnet-5" };
  chamadas = { classificar: 0, gerar: 0, resumir: 0 };
  /** Atrasos opcionais (ms) para testar ordenação/obsolescência. */
  atrasoMs = { classificar: 0, gerar: 0 };
  falharEm: { classificar?: Error; gerar?: Error; resumir?: Error } = {};

  async classificar(ctx: ContextoTurno, candidatos: Candidato[]): Promise<RespostaIa<ResultadoClassificacao>> {
    this.chamadas.classificar++;
    if (this.atrasoMs.classificar) await espera(this.atrasoMs.classificar);
    if (this.falharEm.classificar) throw this.falharEm.classificar;
    const t = normalizar(ctx.texto);
    // "adorou" = elogio, não objeção → falso positivo de regex (ex.: "meu marido adorou").
    if (t.includes("adorou") || t.includes("tudo bem") || t.includes("perfeito")) {
      return { dado: { agir: false, categoriaId: "outro", candidatoEscolhido: null, sinalDeCompra: false, temperatura: "morno", motivo: "conversa normal" }, uso: USO, modelo: this.modelos.classificador, ms: 5 };
    }
    const sinal = t.includes("fechar") || t.includes("garantir");
    const categoriaId = sinal ? "sinal_compra" : t.includes("investimento") || t.includes("caro") || t.includes("barato") ? "preco" : t.includes("marido") ? "autoridade" : t.includes("cancelar") ? "confianca" : t.includes("parcel") ? "pagamento" : "outro";
    const idx = candidatos.findIndex((c) => c.categoriaId === categoriaId);
    return {
      dado: { agir: true, categoriaId, candidatoEscolhido: idx >= 0 ? idx : null, sinalDeCompra: sinal, temperatura: sinal ? "quente" : "morno", motivo: "palavra-chave" },
      uso: USO,
      modelo: this.modelos.classificador,
      ms: 5,
    };
  }

  async gerar(ctx: ContextoTurno, c: ResultadoClassificacao): Promise<RespostaIa<{ resposta: string }>> {
    this.chamadas.gerar++;
    if (this.atrasoMs.gerar) await espera(this.atrasoMs.gerar);
    if (this.falharEm.gerar) throw this.falharEm.gerar;
    return {
      dado: { resposta: `- Entendo, ${c.categoriaId}. O que precisaria estar nessa proposta para valer o investimento para vocês dois? E mais uma frase que não deveria aparecer.` },
      uso: USO,
      modelo: this.modelos.gerador,
      ms: 5,
    };
  }

  async resumir(transcricao: string): Promise<RespostaIa<ResumoCall>> {
    this.chamadas.resumir++;
    if (this.falharEm.resumir) throw this.falharEm.resumir;
    return {
      dado: {
        resumo: `Call com ${transcricao.split("\n").length} turnos. Lead quer Capadócia em julho.`,
        perfil: "Casal, 10 anos de casados, julho, Capadócia.",
        objecoes: [
          { categoriaId: "preco", descricao: "achou caro e viu mais barato no site do hotel", superada: true },
          { categoriaId: "autoridade", descricao: "precisa falar com o marido", superada: false },
        ],
        temperatura: "quente",
        temperaturaScore: 82,
        proximoPasso: { descricao: "Enviar proposta com parcelamento e política de cancelamento", prazoDias: 1, canal: "whatsapp" },
        pontosPositivos: ["Pediu consentimento", "Devolveu pergunta na objeção de preço"],
        pontosAtencao: ["Não travou data com sinal"],
        destino: "Capadócia",
        orcamento: null,
        janelaViagem: "julho",
        pax: 2,
        objecoesNovas: [{ categoriaId: "preco", titulo: "Não sei se vale o investimento agora", comoOLeadFalou: "Não sei se vale o investimento nesse momento", respostaSugerida: "O que precisaria estar nessa proposta para valer?" }],
      },
      uso: { input_tokens: 6000, output_tokens: 700, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
      modelo: this.modelos.resumo,
      ms: 5,
    };
  }
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
