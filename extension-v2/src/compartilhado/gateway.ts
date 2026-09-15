/**
 * Cliente REST do gateway. Roda no service worker e na página de opções
 * (origem chrome-extension://, com host_permissions → sem CORS).
 *
 * Toda chamada leva `Authorization: Bearer <JWT>`. A extensão NUNCA fala
 * com o Supabase — é o gateway que faz o escopo por usuário.
 *
 * Endpoints que a Frente B precisa expor (contrato):
 *   POST /v1/dispositivos/parear   { codigo, rotulo, impressao }  → Credencial
 *   POST /v1/dispositivos/renovar                                 → { token, expiraEm }
 *   GET  /v1/reunioes?dia=hoje                                    → Reuniao[]
 *   GET  /v1/leads/:leadId/briefing?reuniaoId=…                   → Briefing
 *   POST /v1/consentimentos       { reuniaoId, leadId, confirmadoEm, textoVersao } → { id }
 *   POST /v1/sugestoes/:id/feedback { sessaoId, valor, em }       → 204
 */

import { VERSAO_EXTENSAO } from "./config";
import type { Briefing, Consentimento, Credencial, Reuniao, ValorFeedback } from "./tipos";

export class ErroGateway extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroGateway";
  }
}

/** Mensagens humanas para os códigos que o gateway devolve. */
const MENSAGENS: Record<string, string> = {
  codigo_invalido_ou_expirado: "Código inválido ou expirado. Gere outro no QS.",
  already_paired: "Este código já foi usado. Gere outro no QS.",
  pair_code_expired: "Código expirado. Gere outro no QS.",
  usuario_inativo: "Seu usuário está inativo no QS. Fale com o gestor.",
  unauthorized: "Sessão da extensão expirou. Pareie de novo.",
  dispositivo_revogado: "Este dispositivo foi desconectado pelo gestor. Pareie de novo.",
};

async function chamar<T>(
  gateway: string,
  caminho: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const cabecalhos: Record<string, string> = {
    Accept: "application/json",
    "X-Copiloto-Versao": VERSAO_EXTENSAO,
  };
  if (init.body) cabecalhos["Content-Type"] = "application/json";
  if (init.token) cabecalhos["Authorization"] = `Bearer ${init.token}`;

  const controlador = new AbortController();
  const prazo = setTimeout(() => controlador.abort(), 12_000);

  let resposta: Response;
  try {
    resposta = await fetch(gateway + caminho, {
      ...init,
      headers: cabecalhos,
      signal: controlador.signal,
    });
  } catch (err) {
    clearTimeout(prazo);
    const msg = (err as Error).name === "AbortError"
      ? "O gateway demorou demais para responder."
      : "Não consegui falar com o gateway. Verifique a internet.";
    throw new ErroGateway(0, "rede", msg);
  }
  clearTimeout(prazo);

  if (resposta.status === 204) return undefined as T;

  let corpo: unknown = null;
  try {
    corpo = await resposta.json();
  } catch {
    /* corpo vazio ou não-JSON */
  }

  if (!resposta.ok) {
    const codigo =
      (corpo as { error?: string; erro?: string; codigo?: string })?.error ??
      (corpo as { erro?: string })?.erro ??
      (corpo as { codigo?: string })?.codigo ??
      `http_${resposta.status}`;
    const texto =
      MENSAGENS[codigo] ??
      (corpo as { mensagem?: string })?.mensagem ??
      `Gateway respondeu ${resposta.status}.`;
    throw new ErroGateway(resposta.status, codigo, texto);
  }
  return corpo as T;
}

export const gateway = {
  /** Troca o código de 6 dígitos gerado no QS por um JWT do gateway. */
  async parear(url: string, codigo: string, rotulo: string, impressao: string): Promise<Credencial> {
    const r = await chamar<{
      token: string;
      expiraEm?: string;
      expires_at?: string;
      dispositivoId?: string;
      device_id?: string;
      usuario?: Credencial["usuario"];
      user?: Credencial["usuario"];
    }>(url, "/v1/dispositivos/parear", {
      method: "POST",
      body: JSON.stringify({ codigo, rotulo, impressao }),
    });
    const usuario = r.usuario ?? r.user;
    if (!r.token || !usuario) {
      throw new ErroGateway(500, "resposta_invalida", "O gateway não devolveu a credencial.");
    }
    return {
      token: r.token,
      expiraEm: r.expiraEm ?? r.expires_at ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
      usuario,
      pareadoEm: new Date().toISOString(),
      dispositivoId: r.dispositivoId ?? r.device_id ?? impressao,
    };
  },

  async renovar(url: string, token: string): Promise<{ token: string; expiraEm: string }> {
    return chamar(url, "/v1/dispositivos/renovar", { method: "POST", token });
  },

  async reunioesDeHoje(url: string, token: string): Promise<Reuniao[]> {
    const r = await chamar<Reuniao[] | { reunioes: Reuniao[] }>(url, "/v1/reunioes?dia=hoje", { token });
    return Array.isArray(r) ? r : r.reunioes ?? [];
  },

  async briefing(url: string, token: string, leadId: string, reuniaoId: string): Promise<Briefing> {
    return chamar(url, `/v1/leads/${encodeURIComponent(leadId)}/briefing?reuniaoId=${encodeURIComponent(reuniaoId)}`, { token });
  },

  /** Registra a prova do consentimento. Só é chamado DEPOIS do closer confirmar. */
  async registrarConsentimento(url: string, token: string, c: Consentimento): Promise<{ id: string }> {
    return chamar(url, "/v1/consentimentos", {
      method: "POST",
      token,
      body: JSON.stringify({
        reuniaoId: c.reuniaoId,
        leadId: c.leadId,
        confirmadoEm: c.confirmadoEm,
        textoVersao: c.textoVersao,
      }),
    });
  },

  async feedback(url: string, token: string, sugestaoId: string, sessaoId: string, valor: ValorFeedback, em: string): Promise<void> {
    await chamar(url, `/v1/sugestoes/${encodeURIComponent(sugestaoId)}/feedback`, {
      method: "POST",
      token,
      body: JSON.stringify({ sessaoId, valor, em }),
    });
  },

  async saude(url: string): Promise<boolean> {
    try {
      await chamar(url, "/health");
      return true;
    } catch {
      return false;
    }
  },
};

/** Identificador estável deste Chrome, sem dado pessoal. */
export async function impressaoDoDispositivo(): Promise<string> {
  const r = await chrome.storage.local.get("impressao");
  const existente = r["impressao"] as string | undefined;
  if (existente) return existente;
  const nova = crypto.randomUUID();
  await chrome.storage.local.set({ impressao: nova });
  return nova;
}
