/**
 * Erros tipados do gateway.
 *
 * Princípio: falha nunca é silenciosa. Toda camada que falha em tempo real
 * precisa (1) registrar em log com contexto, (2) contar em métrica e
 * (3) avisar o closer pelo WebSocket. Um `catch { return [] }` faria o closer
 * achar que o lead não fez objeção — e isso custa venda.
 */
export class ErroCopiloto extends Error {
  constructor(
    mensagem: string,
    public readonly codigo: string,
    public readonly status: number = 500,
    public readonly causa?: unknown,
  ) {
    super(mensagem);
    this.name = new.target.name;
  }
}

export class ErroValidacao extends ErroCopiloto {
  constructor(mensagem: string, causa?: unknown) {
    super(mensagem, "validacao", 400, causa);
  }
}

/**
 * 401. `codigo` é o que a extensão mapeia para mensagem humana
 * (`unauthorized`, `codigo_invalido_ou_expirado`, `usuario_inativo`…).
 */
export class ErroAutenticacao extends ErroCopiloto {
  constructor(mensagem = "não autenticado", causa?: unknown, codigo = "unauthorized") {
    super(mensagem, codigo, 401, causa);
  }
}

export class ErroPermissao extends ErroCopiloto {
  constructor(mensagem = "sem permissão") {
    super(mensagem, "permissao", 403);
  }
}

export class ErroNaoEncontrado extends ErroCopiloto {
  constructor(mensagem = "não encontrado") {
    super(mensagem, "nao_encontrado", 404);
  }
}

export class ErroLimite extends ErroCopiloto {
  constructor(mensagem: string) {
    super(mensagem, "limite", 429);
  }
}

/** Falha em dependência externa (Deepgram, Anthropic, embeddings, Postgres). */
export class ErroDependencia extends ErroCopiloto {
  constructor(
    public readonly dependencia: "deepgram" | "anthropic" | "embeddings" | "postgres",
    mensagem: string,
    causa?: unknown,
    public readonly recuperavel = true,
  ) {
    super(`${dependencia}: ${mensagem}`, `dependencia_${dependencia}`, 503, causa);
  }
}

/** Extrai uma mensagem legível de qualquer coisa lançada. */
export function mensagemDe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
