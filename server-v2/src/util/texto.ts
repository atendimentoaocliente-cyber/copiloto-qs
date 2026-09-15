/** Utilidades de texto usadas pelo motor (normalização e poda de resposta). */

/** Remove acentos, baixa caixa e colapsa espaços — para casar regex de gatilho. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function contarPalavras(texto: string): number {
  return texto.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Garante a REGRA DURA da sugestão: UMA frase, no máximo N palavras, falável.
 * Se o modelo mandar bullet, quebra de linha ou duas frases, a gente poda aqui
 * em vez de confiar no prompt.
 */
export function podarResposta(texto: string, maxPalavras = 20): string {
  let t = texto
    .replace(/[*_#>`]/g, "")
    .replace(/^\s*[-•\d.)]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return t;

  // UMA frase, sempre. O closer lê em voz alta — duas frases já o fazem
  // desviar o olhar por tempo demais.
  //
  // O gerador costuma abrir com preâmbulo curto ("Entendo,", "Claro."). Esse
  // pedaço não ajuda ninguém: descartamos e ficamos com a primeira frase que
  // realmente diz algo (>= 4 palavras). Se nenhuma disser, fica a primeira.
  const frases = t.match(/[^.!?]+[.!?]?/g) ?? [t];
  const substantiva = frases.map((f) => f.trim()).find((f) => contarPalavras(f) >= 4);
  t = (substantiva ?? frases[0] ?? t).trim();

  const palavras = t.split(" ");
  if (palavras.length > maxPalavras) {
    t = palavras.slice(0, maxPalavras).join(" ").replace(/[,;:]$/, "");
    if (!/[.!?]$/.test(t)) t += ".";
  }
  return t;
}
