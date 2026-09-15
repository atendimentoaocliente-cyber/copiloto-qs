/** Utilitários de DOM e texto do painel. */

export function esc(texto: unknown): string {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trunca com reticências respeitando o teto de caracteres. */
export function truncar(texto: string, max: number): string {
  const t = texto.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

export function horaCurta(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function dataCurta(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const meses = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${String(d.getDate()).padStart(2, "0")}/${meses[d.getMonth()]}`;
}

export function reais(valor: number | undefined): string {
  if (valor === undefined || valor === null) return "";
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

/** mm:ss desde um instante — usado só na fila "já tratadas", nunca no timer. */
export function relogioDesde(inicioIso: string | null, emIso: string): string {
  if (!inicioIso) return horaCurta(emIso);
  const s = Math.max(0, Math.floor((new Date(emIso).getTime() - new Date(inicioIso).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function atalhoAtivar(): string {
  return navigator.platform.includes("Mac") ? "⌘ + Shift + K" : "Ctrl + Shift + K";
}
