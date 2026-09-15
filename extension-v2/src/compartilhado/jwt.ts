/**
 * Leitura do JWT sem verificar assinatura — quem verifica é o gateway.
 * Aqui só precisamos do `exp` para saber quando renovar.
 */

export interface ClaimsJwt {
  sub?: string;
  exp?: number;
  iat?: number;
  jti?: string;
  role?: string;
  name?: string;
}

export function lerClaims(token: string): ClaimsJwt | null {
  const partes = token.split(".");
  if (partes.length !== 3 || !partes[1]) return null;
  try {
    const base64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
    const preenchido = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(preenchido)) as ClaimsJwt;
  } catch {
    return null;
  }
}

/** Dias restantes até expirar (negativo = expirado). */
export function diasRestantes(token: string): number {
  const exp = lerClaims(token)?.exp;
  if (!exp) return 0;
  return (exp * 1000 - Date.now()) / 86_400_000;
}

export function expirado(token: string): boolean {
  return diasRestantes(token) <= 0;
}
