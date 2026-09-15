/**
 * Tipos de domínio compartilhados por todos os contextos da extensão.
 * Espelham o que o gateway devolve — nomes em português, como o QS.
 */

export interface Usuario {
  id: string;
  nome: string;
  papel: "admin" | "gestor" | "sdr" | "closer";
}

/** Credencial obtida no pairing. Vive em chrome.storage.local. */
export interface Credencial {
  token: string;
  /** ISO — quando o JWT expira. */
  expiraEm: string;
  usuario: Usuario;
  /** ISO — quando o pareamento foi feito. */
  pareadoEm: string;
  dispositivoId: string;
}

/** Reunião agendada do closer, vinda de qs_meetings via gateway. */
export interface Reuniao {
  id: string;
  leadId: string;
  leadNome: string;
  /** ISO */
  inicio: string;
  /** ISO, opcional */
  fim?: string;
  produto?: string;
  destino?: string;
  ticketEstimado?: number;
  sdrNome?: string;
  plataforma?: "google_meet" | "zoom" | "teams" | "outro";
}

export interface ItemHistorico {
  /** ISO */
  data: string;
  tipo: "nota" | "tarefa" | "reuniao" | "status" | "call";
  descricao: string;
  autor?: string;
}

export interface CallAnterior {
  /** ISO */
  data: string;
  duracaoMin: number;
  objecoes: number;
  resultado: "fechou" | "sem_fechamento" | "follow_up" | "perdido";
}

/** Briefing pré-call: o que o SDR levantou + histórico + produto. */
export interface Briefing {
  lead: {
    id: string;
    nome: string;
    primeiroNome: string;
    cidade?: string;
    origem?: string;
    status?: string;
  };
  handover: {
    resumo: string;
    notas: string[];
    sdrNome: string;
    /** ISO */
    criadoEm: string;
    perfilViagem?: string;
    motivacao?: string;
    orcamentoDeclarado?: number;
    decisores?: string;
  } | null;
  produto: {
    nome: string;
    destino: string;
    duracaoDias?: number;
    ticketEstimado?: number;
    periodo?: string;
  } | null;
  historico: ItemHistorico[];
  ultimasCalls: CallAnterior[];
  playbook: { id: string; nome: string; totalObjecoes: number } | null;
}

/** Registro de consentimento LGPD. Só existe DEPOIS de confirmado. */
export interface Consentimento {
  id?: string;
  reuniaoId: string;
  leadId: string;
  /** ISO — momento em que o closer confirmou que leu o texto. */
  confirmadoEm: string;
  textoVersao: string;
  closerId: string;
}

export type NivelSugestao = "sugestao" | "atencao";
export type FonteSugestao = "playbook" | "ia" | "gestor";

/** Card que o painel mostra. UMA frase. Nunca bullets. */
export interface Sugestao {
  id: string;
  categoria: string;
  /** ≤ 68 caracteres, ≤ 2 linhas. O painel trunca se o gateway passar. */
  frase: string;
  nivel: NivelSugestao;
  /** O trecho da fala do lead que disparou. ≤ 52 caracteres. */
  eco?: string;
  ancora?: { rotulo: "PROVA" | "CONDIÇÃO" | "DADO"; texto: string };
  alternativa?: string;
  fonte: FonteSugestao;
  /**
   * Chip já conhecido (L0 bateu) mas a frase ainda está sendo preparada.
   * O painel mostra o esqueleto estático por no máximo 1200 ms e, se a
   * versão completa (mesmo `id`) não chegar, descarta.
   */
  pendente?: boolean;
  latenciaMs?: number;
  /** Timestamp do gateway (ms) — usado para descartar card tardio. */
  geradoEm?: number;
}

export type ValorFeedback = "usei" | "nao_serviu" | "ignorou";

export interface Feedback {
  sugestaoId: string;
  sessaoId: string;
  valor: ValorFeedback;
  /** ISO */
  em: string;
}

export interface Transcricao {
  texto: string;
  falante: "lead" | "closer";
  final: boolean;
}

/** Estados do painel ao vivo. */
export type EstadoAoVivo =
  | "ocioso"
  | "escutando"
  | "detectando"
  | "sugerindo"
  | "reconectando"
  | "erro"
  | "degradado";

/** Fase da sessão — máquina de estados do service worker. */
export type FaseSessao =
  | "inativo"
  | "carregando"
  | "selecionando_lead"
  | "consentimento"
  | "briefing"
  | "ao_vivo"
  | "encerrando";

/** Estado da sessão persistido em chrome.storage.session. */
export interface Sessao {
  fase: FaseSessao;
  tabId: number | null;
  /** UUID gerado no cliente, enviado ao gateway em sessao.iniciar. */
  sessaoId: string | null;
  reuniao: Reuniao | null;
  briefing: Briefing | null;
  consentimento: Consentimento | null;
  /** ISO — quando a escuta começou. */
  iniciadaEm: string | null;
  plataforma: Reuniao["plataforma"];
  /** Registro de "já tratadas" para a zona F e para o resumo. */
  tratadas: Array<{ em: string; categoria: string; valor: ValorFeedback }>;
  /** Vigia de tela: a última superfície compartilhada. */
  superficie: SuperficieTela | null;
  /**
   * activeTab expirou (o closer navegou) antes de iniciar a captura.
   * O próximo clique no ícone retoma a partir do briefing, sem refazer o fluxo.
   */
  aguardandoReinvocacao: boolean;
}

export type SuperficieTela = "monitor" | "window" | "browser" | "desconhecido" | "parou";

export interface AvisoTela {
  perigoso: boolean;
  superficie: SuperficieTela;
}

/** Item da zona F — "já tratadas". */
export interface Tratada {
  em: string;
  categoria: string;
  valor: ValorFeedback;
}
