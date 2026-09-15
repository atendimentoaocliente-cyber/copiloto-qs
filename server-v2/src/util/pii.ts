/**
 * Redação de PII antes de (a) enviar ao LLM e (b) persistir a transcrição.
 *
 * Dado de pagamento nunca chega na Anthropic e nunca fica em texto claro no
 * banco. Cobre CPF, CNPJ, cartão (13-19 dígitos), CVV após "código"/"cvv",
 * e telefone brasileiro. É regex — não substitui o `redact` do Deepgram, mas
 * o Deepgram não redige em `language=multi`, então esta camada é a garantia.
 */

const CPF = /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g;
const CNPJ = /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}\b/g;
// O último caractere tem de ser dígito: `(?:\d[ -]?){13,19}` engolia o espaço
// seguinte e colava "[CARTÃO]" na palavra de trás.
const CARTAO = /\b\d(?:[ -]?\d){12,18}\b/g;
const CVV = /\b(cvv|cvc|c[oó]digo de seguran[çc]a)\s*(?:é|e|:)?\s*\d{3,4}\b/gi;
const TELEFONE = /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g;

export function redigirPii(texto: string): string {
  if (!texto) return texto;
  return texto
    .replace(CARTAO, "[CARTÃO]")
    .replace(CVV, "$1 [CVV]")
    .replace(CNPJ, "[CNPJ]")
    .replace(CPF, "[CPF]")
    .replace(TELEFONE, "[TELEFONE]");
}

/** Verdadeiro se o texto contém algo que a redação trocaria. Útil para métrica. */
export function contemPii(texto: string): boolean {
  return redigirPii(texto) !== texto;
}
