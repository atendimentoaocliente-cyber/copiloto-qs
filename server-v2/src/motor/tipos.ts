/**
 * Tipos do motor de detecção.
 */
import type { Candidato } from "../db/repositorio.js";
import type { FonteSugestao, Temperatura } from "../tipos/protocolo.js";
import type { UsoLlm } from "../custo/contador.js";

export type Camada = "L0" | "L1" | "L2" | "L3";

/** O que o lead acabou de dizer, com o contexto que a IA precisa. */
export interface ContextoTurno {
  texto: string;
  /** Últimos N turnos, já formatados "LEAD: ..." / "CLOSER: ...". */
  historico: string[];
  briefing: string | null;
  /** ms desde o início da call. */
  emMs: number;
}

export interface Sugestao {
  categoriaId: string;
  categoria: string;
  resposta: string;
  fonte: FonteSugestao;
  camada: Camada;
  objecaoId: string | null;
  similaridade: number | null;
  temperatura: Temperatura | null;
  modelo: string | null;
}

export interface ResultadoClassificacao {
  agir: boolean;
  categoriaId: string;
  /** Índice (base 0) do candidato pré-aprovado que resolve — ou null se nenhum serve. */
  candidatoEscolhido: number | null;
  sinalDeCompra: boolean;
  temperatura: Temperatura;
  motivo: string;
}

export interface RespostaIa<T> {
  dado: T;
  uso: UsoLlm;
  modelo: string;
  ms: number;
}

export interface ResumoCall {
  resumo: string;
  perfil: string;
  objecoes: Array<{ categoriaId: string; descricao: string; superada: boolean | null }>;
  temperatura: Temperatura;
  temperaturaScore: number;
  proximoPasso: { descricao: string; prazoDias: number | null; canal: "ligacao" | "whatsapp" | "email" } | null;
  pontosPositivos: string[];
  pontosAtencao: string[];
  destino: string | null;
  orcamento: number | null;
  janelaViagem: string | null;
  pax: number | null;
  /** Objeções que apareceram e NÃO estão no playbook — vão para a curadoria. */
  objecoesNovas: Array<{ categoriaId: string; titulo: string; comoOLeadFalou: string; respostaSugerida: string }>;
}

/** Contrato do cliente de IA. Implementação real em `ia.ts`; falsa nos testes. */
export interface ClienteIa {
  readonly modelos: { classificador: string; gerador: string; resumo: string };
  classificar(ctx: ContextoTurno, candidatos: Candidato[]): Promise<RespostaIa<ResultadoClassificacao>>;
  gerar(ctx: ContextoTurno, classificacao: ResultadoClassificacao, candidatos: Candidato[]): Promise<RespostaIa<{ resposta: string }>>;
  resumir(transcricao: string, briefing: string | null, categorias: Array<{ id: string; label: string }>): Promise<RespostaIa<ResumoCall>>;
}
