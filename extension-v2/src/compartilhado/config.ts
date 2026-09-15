/**
 * Configuração da extensão.
 *
 * Nenhuma credencial vive aqui. A extensão só conhece a URL do gateway;
 * quem fala com Supabase, Deepgram e Anthropic é o gateway (Frente B).
 */

export const VERSAO_EXTENSAO = "2.0.0";

/** Gateway padrão por ambiente. Pode ser sobrescrito na página de opções. */
export const GATEWAY_PADRAO = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://gw.qs.inovvatur.com.br";

/** Versão do texto de consentimento lido em voz alta. Muda → nova versão. */
export const VERSAO_TEXTO_CONSENTIMENTO = "2026-09-v1";

/**
 * Texto que o closer lê para o lead antes de ligar o copiloto.
 * Curto, sem juridiquês, e em primeira pessoa — é para ser falado.
 */
export const TEXTO_CONSENTIMENTO =
  "Antes de começar: eu uso uma ferramenta de apoio que acompanha a nossa " +
  "conversa e me ajuda a organizar as informações. Nada é compartilhado " +
  "fora da Se Tu For Eu Vou. Tudo bem pra você?";

/** Hosts de reunião onde o lembrete aparece sozinho. */
export const HOSTS_REUNIAO = [
  /^https:\/\/meet\.google\.com\//i,
  /^https:\/\/[a-z0-9.-]*zoom\.us\//i,
  /^https:\/\/teams\.(microsoft|live)\.com\//i,
];

/** Regex de uma sala do Meet (não a home). */
export const REGEX_SALA_MEET =
  /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;

/** Limites de resiliência do canal de áudio. */
export const RESILIENCIA = {
  /** Recuo inicial entre tentativas de reconexão. */
  recuoInicialMs: 500,
  /** Teto do recuo. */
  recuoMaximoMs: 10_000,
  /** Após esta tentativa o painel passa a mostrar "reconectando N de M". */
  tentativasVisiveis: 5,
  /** Depois disso paramos de tentar e o painel vai para "erro". */
  tentativasMaximas: 12,
  /** Heartbeat para o gateway. */
  heartbeatMs: 5_000,
  /** Sem qualquer frame do gateway por este tempo, com áudio saindo → cai e reabre. */
  watchdogMs: 15_000,
  /** Segundos de áudio guardados durante uma queda, para reenvio ao voltar. */
  filaAudioSegundos: 30,
  /** Sem transcrição por este tempo, com áudio saindo → "degradado". */
  silencioDegradadoMs: 45_000,
} as const;

/** Regras de UX que viram número (ver 06-UX-OVERLAY-ux.md). */
export const UX = {
  larguraPainel: 380,
  alturaPainel: 520,
  /** Card vira fantasma após este tempo. */
  fantasmaMs: 20_000,
  /** Cooldown mínimo entre dois cards. */
  cooldownMs: 8_000,
  /** Teto de cards por call. Acima disso o copiloto só registra. */
  tetoCardsPorCall: 6,
  /** Sugestão que chega depois disso já perdeu a janela conversacional. */
  descarteTardioMs: 2_500,
  /** "detectando" nunca fica na tela mais que isso. */
  detectandoMaximoMs: 1_200,
  /** Silenciar por 5 minutos. */
  silenciarMs: 5 * 60_000,
  maxCaracteresFrase: 68,
  maxCaracteresEco: 52,
} as const;
