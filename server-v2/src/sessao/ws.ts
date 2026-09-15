/**
 * Rota WebSocket /v1/stream — protocolo `qscopilot.v1` (contrato da extensão v2).
 *
 *   extensão ──frames [8 B cabeçalho + PCM 16 kHz 2 canais]──▶ gateway ──▶ STT
 *   extensão ◀──transcricao / sugestao / degradado / erro──── gateway ◀── STT / motor
 *
 * Handshake: `?token=<JWT>` (ou subprotocolo "bearer, <token>") → Origin →
 * drenagem. A PRIMEIRA mensagem tem de ser `sessao.iniciar` (com o
 * consentimentoId registrado antes em POST /v1/consentimentos) ou
 * `sessao.retomar` (reconexão). Sem isso: fecha com 4401.
 *
 * Uma call vive num `CallAoVivo`, independente do socket: a extensão pode cair
 * e voltar (`sessao.retomar`) sem perder a call. Só `encerrar` (ou o prazo de
 * reconexão) encerra de verdade — e aí o gateway AGUARDA o STT devolver os
 * últimos `is_final` antes do pós-call.
 *
 * Card único por detecção: o L0 vai como chip `pendente` (quando ainda vem
 * refinamento) e L1/L2/L3 completam o MESMO `id`. Um fallback de 900 ms
 * completa o card com a frase do L0 se a IA atrasar — o painel descarta
 * pendentes em 1200 ms, e sugestão descartada é pior que sugestão do playbook.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import type { PayloadCopiloto } from "../auth/jwt.js";
import type { Config } from "../config.js";
import type { RepositorioCopiloto } from "../db/repositorio.js";
import { briefingResumido } from "../db/repositorio.js";
import type { Logger } from "../logger.js";
import type { Embedder } from "../motor/embeddings.js";
import { Pipeline, type SaidaPipeline, type SugestaoEmitida } from "../motor/pipeline.js";
import type { CachePlaybook } from "../motor/playbook.js";
import type { ClienteIa } from "../motor/tipos.js";
import { BuscaVetorial } from "../motor/vetorial.js";
import type { Metricas } from "../observabilidade/metricas.js";
import { executarPosCall } from "../pos-call/index.js";
import type { FabricaStt, ProvedorStt } from "../stt/provedor.js";
import {
  FECHAMENTO,
  MensagemCliente,
  OUTCOME_POR_FEEDBACK,
  VERSAO_PROTOCOLO,
  lerFrame,
  type MensagemGateway,
  type MsgSessaoIniciar,
  type MsgSessaoRetomar,
  type SugestaoCard,
} from "../tipos/protocolo.js";
import { ErroAutenticacao, ErroCopiloto, mensagemDe } from "../util/erros.js";
import type { RegistroSessoes } from "./registro.js";
import { Sessao } from "./sessao.js";

export interface DependenciasWs {
  cfg: Config;
  log: Logger;
  metricas: Metricas;
  repo: RepositorioCopiloto;
  registro: RegistroSessoes;
  fabricaStt: FabricaStt;
  playbook: CachePlaybook;
  ia: ClienteIa | null;
  embedder: Embedder | null;
  verificarToken: (token: string) => PayloadCopiloto;
  agora?: () => number;
  /** Quanto tempo a call sobrevive sem socket esperando `sessao.retomar`. */
  graceReconexaoMs?: number;
}

const PRAZO_PRIMEIRA_MSG_MS = 15_000;
const HEARTBEAT_MS = 10_000;
const HEARTBEATS_PERDIDOS_MAX = 3;
const GRACE_RECONEXAO_MS = 3 * 60_000;
/** Depois de um frame `reenviado`, turnos do lead por este tempo não geram sugestão ao vivo. */
const JANELA_REENVIO_MS = 1_500;
/** Se L1/L2/L3 não completarem o chip em 900 ms, completa com a frase do L0 (o painel descarta em 1200). */
const FALLBACK_CONCLUSAO_MS = 900;

export function registrarRotaStream(app: FastifyInstance, d: DependenciasWs): void {
  const vivas = new Map<string, CallAoVivo>();
  app.get("/v1/stream", { websocket: true }, (socket, req) => {
    void conduzirHandshake(socket, req, d, vivas).catch((err) => {
      d.log.error({ err }, "erro não tratado no handshake; fechando");
      d.metricas.erro("ws_nao_tratado");
      fecharSeguro(socket, 1011, "erro interno");
    });
  });
}

// ── Handshake ─────────────────────────────────────────────────────────────────

function extrairToken(req: FastifyRequest): string | null {
  const q = req.query as Record<string, string | undefined>;
  if (q?.token) return q.token;
  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string") {
    const partes = proto.split(",").map((p) => p.trim());
    const i = partes.indexOf("bearer");
    if (i >= 0 && partes[i + 1]) return partes[i + 1]!;
  }
  return null;
}

function fecharSeguro(socket: WebSocket, codigo: number, motivo: string): void {
  try {
    socket.close(codigo, motivo.slice(0, 120));
  } catch {
    /* já fechado */
  }
}

function enviarPara(socket: WebSocket, m: MensagemGateway): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
}

async function conduzirHandshake(socket: WebSocket, req: FastifyRequest, d: DependenciasWs, vivas: Map<string, CallAoVivo>): Promise<void> {
  const log = d.log.child({ ip: req.ip });

  // 1. Origin — só o ID fixo da extensão.
  const origem = req.headers.origin ?? "";
  if (d.cfg.EXTENSAO_ORIGENS.length && !d.cfg.EXTENSAO_ORIGENS.includes(origem)) {
    log.warn({ origem }, "TENTATIVA DE INTRUSÃO: origin não permitida no WebSocket");
    d.metricas.conexoesWs.inc({ estado: "origem_recusada" });
    return fecharSeguro(socket, FECHAMENTO.naoAutorizado, "origem não permitida");
  }

  // 2. JWT.
  let closer: PayloadCopiloto;
  try {
    const token = extrairToken(req);
    if (!token) throw new ErroAutenticacao("token ausente");
    closer = d.verificarToken(token);
  } catch (err) {
    log.warn({ err: mensagemDe(err) }, "handshake recusado");
    d.metricas.conexoesWs.inc({ estado: "token_recusado" });
    return fecharSeguro(socket, FECHAMENTO.naoAutorizado, "não autenticado");
  }
  const logCloser = log.child({ closerId: closer.sub });

  // 3. Drenagem: 1013 → a extensão reconecta com recuo e o proxy manda para outra máquina.
  if (d.registro.emDrenagem) {
    d.metricas.conexoesWs.inc({ estado: "drenando" });
    return fecharSeguro(socket, 1013, "instância em drenagem; reconecte");
  }
  d.metricas.conexoesWs.inc({ estado: "aceita" });

  // 4. Primeira mensagem: sessao.iniciar | sessao.retomar.
  const primeira = await esperarPrimeiraMensagem(socket, PRAZO_PRIMEIRA_MSG_MS);
  if (!primeira) {
    d.metricas.conexoesWs.inc({ estado: "sem_iniciar" });
    return fecharSeguro(socket, FECHAMENTO.naoAutorizado, "esperava sessao.iniciar");
  }

  // 5a. Retomada (reconexão).
  if (primeira.tipo === "sessao.retomar") {
    return retomar(socket, primeira, closer, d, vivas, logCloser);
  }

  // 5b. Início. Idempotente: a mesma sessaoId de novo é retomada.
  const existente = vivas.get(primeira.sessaoId);
  if (existente) {
    if (existente.closerId !== closer.sub) return fecharSeguro(socket, FECHAMENTO.sessaoInvalida, "sessão de outro closer");
    existente.anexar(socket);
    existente.enviar({ tipo: "sessao.retomada", sessaoId: existente.id, aPartirDoSeq: existente.ultimoSeq + 1 });
    return;
  }
  if (d.registro.contarDoCloser(closer.sub) >= d.cfg.SESSOES_MAX_POR_CLOSER) {
    d.metricas.conexoesWs.inc({ estado: "limite_closer" });
    enviarPara(socket, { tipo: "erro", codigo: "limite_sessoes", texto: `Você já tem ${d.cfg.SESSOES_MAX_POR_CLOSER} call(s) ativas no copiloto. Encerre uma antes.`, fatal: true });
    return fecharSeguro(socket, FECHAMENTO.sessaoInvalida, "limite de sessões por closer");
  }

  // 6. Consentimento: precisa existir, ser ACEITO, do mesmo closer e do mesmo lead. Sem prova, sem call.
  let consentimento;
  try {
    consentimento = await d.repo.buscarConsentimento(primeira.consentimentoId);
  } catch (err) {
    logCloser.error({ err }, "não conseguiu verificar o consentimento");
    d.metricas.erro("consentimento_verificacao");
    enviarPara(socket, { tipo: "erro", codigo: "banco", texto: `Não consegui verificar o consentimento: ${mensagemDe(err)}`, fatal: true });
    return fecharSeguro(socket, 1011, "falha ao verificar consentimento");
  }
  if (!consentimento || !consentimento.aceito || consentimento.closerId !== closer.sub || (consentimento.leadId && consentimento.leadId !== primeira.leadId)) {
    logCloser.warn({ consentimentoId: primeira.consentimentoId, existe: Boolean(consentimento) }, "sessao.iniciar sem consentimento válido");
    d.metricas.conexoesWs.inc({ estado: "sem_consentimento" });
    enviarPara(socket, { tipo: "erro", codigo: "consentimento_invalido", texto: "Consentimento não encontrado ou não aceito. Registre o consentimento antes de iniciar.", fatal: true });
    return fecharSeguro(socket, FECHAMENTO.sessaoInvalida, "consentimento inválido");
  }

  const call = new CallAoVivo(d, vivas, {
    id: primeira.sessaoId,
    closer,
    leadId: primeira.leadId,
    meetingId: primeira.reuniaoId,
    plataforma: primeira.plataforma,
    consentimento: { id: consentimento.id, em: consentimento.confirmadoEm, textoVersao: consentimento.textoVersao },
    temMicrofone: primeira.audio.temMicrofone,
    cliente: primeira.cliente,
    log: logCloser.child({ callId: primeira.sessaoId }),
  });
  try {
    await call.iniciar(false);
  } catch (err) {
    // Sessão duplicada no banco (reconexão que chegou como iniciar): reidrata em vez de falhar.
    if (err instanceof ErroCopiloto && /duplicate|unique|já existe/i.test(err.message)) {
      const s = await d.repo.buscarSessao(primeira.sessaoId).catch(() => null);
      if (s && s.closerId === closer.sub && s.status === "gravando") {
        await call.iniciar(true);
        call.anexar(socket);
        call.enviar({ tipo: "sessao.retomada", sessaoId: call.id, aPartirDoSeq: 0 });
        return;
      }
      enviarPara(socket, { tipo: "erro", codigo: "sessao_duplicada", texto: "Esta sessão já existe e não pertence a você ou já foi encerrada.", fatal: true });
      return fecharSeguro(socket, FECHAMENTO.sessaoInvalida, "sessão duplicada");
    }
    enviarPara(socket, { tipo: "erro", codigo: "inicio", texto: `Não foi possível iniciar a call: ${mensagemDe(err)}`, fatal: true });
    return fecharSeguro(socket, 1011, "falha ao iniciar");
  }
  call.anexar(socket);
  call.enviar({
    tipo: "pronto",
    sessaoId: call.id,
    ia: call.iaAtiva,
    modelo: d.ia ? `${d.ia.modelos.classificador} + ${d.ia.modelos.gerador}` : undefined,
    heartbeatMs: HEARTBEAT_MS,
  });
}

async function retomar(
  socket: WebSocket,
  msg: MsgSessaoRetomar,
  closer: PayloadCopiloto,
  d: DependenciasWs,
  vivas: Map<string, CallAoVivo>,
  log: Logger,
): Promise<void> {
  const viva = vivas.get(msg.sessaoId);
  if (viva) {
    if (viva.closerId !== closer.sub) return fecharSeguro(socket, FECHAMENTO.sessaoInvalida, "sessão de outro closer");
    viva.anexar(socket);
    viva.enviar({ tipo: "sessao.retomada", sessaoId: viva.id, aPartirDoSeq: viva.ultimoSeq + 1 });
    d.metricas.conexoesWs.inc({ estado: "retomada" });
    return;
  }
  // Não está nesta máquina (deploy, crash, ou o proxy mandou para a outra): reidrata do banco.
  let s;
  try {
    s = await d.repo.buscarSessao(msg.sessaoId);
  } catch (err) {
    enviarPara(socket, { tipo: "erro", codigo: "banco", texto: `Não consegui localizar a sessão: ${mensagemDe(err)}`, fatal: false });
    return fecharSeguro(socket, 1011, "falha ao localizar sessão");
  }
  if (!s || s.closerId !== closer.sub || s.status !== "gravando") {
    d.metricas.conexoesWs.inc({ estado: "retomada_invalida" });
    return fecharSeguro(socket, FECHAMENTO.sessaoInvalida, "sessão desconhecida ou encerrada");
  }
  log.warn({ callId: msg.sessaoId }, "reidratando sessão de outra instância");
  const call = new CallAoVivo(d, vivas, {
    id: s.id,
    closer,
    leadId: null,
    meetingId: null,
    plataforma: "desconhecida",
    consentimento: null,
    temMicrofone: true,
    cliente: null,
    log: log.child({ callId: s.id }),
    iniciadaEm: s.startedAt ? Date.parse(s.startedAt) : undefined,
  });
  try {
    await call.iniciar(true);
  } catch (err) {
    enviarPara(socket, { tipo: "erro", codigo: "reidratacao", texto: `Não consegui retomar a call: ${mensagemDe(err)}`, fatal: true });
    return fecharSeguro(socket, 1011, "falha ao reidratar");
  }
  call.anexar(socket);
  call.enviar({ tipo: "sessao.retomada", sessaoId: call.id, aPartirDoSeq: msg.ultimoSeq + 1 });
  d.metricas.conexoesWs.inc({ estado: "reidratada" });
}

function esperarPrimeiraMensagem(socket: WebSocket, prazoMs: number): Promise<MsgSessaoIniciar | MsgSessaoRetomar | null> {
  return new Promise((resolve) => {
    const prazo = setTimeout(() => {
      socket.off("message", aoReceber);
      resolve(null);
    }, prazoMs);
    const aoReceber = (dados: WebSocket.RawData, binario: boolean) => {
      if (binario) {
        enviarPara(socket, { tipo: "erro", codigo: "protocolo", texto: "áudio antes de sessao.iniciar é ignorado", fatal: false });
        return;
      }
      let bruto: unknown = null;
      try {
        bruto = JSON.parse(dados.toString());
      } catch {
        /* cai na validação abaixo */
      }
      const r = MensagemCliente.safeParse(bruto);
      if (!r.success) {
        enviarPara(socket, { tipo: "erro", codigo: "protocolo", texto: `mensagem inválida: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, fatal: false });
        return;
      }
      if (r.data.tipo === "ping") {
        enviarPara(socket, { tipo: "pong", ts: r.data.ts });
        return;
      }
      if (r.data.tipo !== "sessao.iniciar" && r.data.tipo !== "sessao.retomar") {
        enviarPara(socket, { tipo: "erro", codigo: "protocolo", texto: "primeira mensagem precisa ser sessao.iniciar ou sessao.retomar", fatal: false });
        return;
      }
      clearTimeout(prazo);
      socket.off("message", aoReceber);
      resolve(r.data);
    };
    socket.on("message", aoReceber);
  });
}

// ── A call ────────────────────────────────────────────────────────────────────

interface ParametrosCall {
  id: string;
  closer: PayloadCopiloto;
  leadId: string | null;
  meetingId: string | null;
  plataforma: string;
  consentimento: { id: string; em: string; textoVersao: string } | null;
  temMicrofone: boolean;
  cliente: MsgSessaoIniciar["cliente"] | null;
  log: Logger;
  iniciadaEm?: number;
}

class CallAoVivo {
  readonly id: string;
  readonly closerId: string;
  ultimoSeq = -1;

  private socket: WebSocket | null = null;
  private sessao!: Sessao;
  private stt!: ProvedorStt;
  private pipeline!: Pipeline;
  private janelaContexto = 6;
  private readonly log: Logger;
  private readonly agora: () => number;

  private pausado = false;
  private reenviandoAte = 0;
  private inicioFalaLead: number | null = null;
  private primeiraPalavraMs: number | null = null;
  private encerrando = false;
  private estadoStt: "ok" | "reconectando" | "caiu" = "ok";
  private estadoIa: "ok" | "degradada" | "desligada" = "ok";
  private degradadoAvisado = false;
  private iaDesligadaPorCusto = false;

  private heartbeat: NodeJS.Timeout | null = null;
  private timerGrace: NodeJS.Timeout | null = null;
  private tetoDuracao: NodeJS.Timeout | null = null;

  /** deteccaoId de cada emissão → id do card (raiz da cadeia L0→L1→L3). */
  private readonly cardDe = new Map<string, string>();
  private readonly fallbackConclusao = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly d: DependenciasWs,
    private readonly vivas: Map<string, CallAoVivo>,
    private readonly p: ParametrosCall,
  ) {
    this.id = p.id;
    this.closerId = p.closer.sub;
    this.log = p.log;
    this.agora = d.agora ?? Date.now;
    this.estadoIa = d.ia ? "ok" : "desligada";
  }

  get iaAtiva(): boolean {
    return this.pipeline?.iaAtiva ?? false;
  }

  // ── ciclo de vida ────────────────────────────────────────────────────────

  async iniciar(reidratar: boolean): Promise<void> {
    const d = this.d;
    let seqInicial = 0;
    if (!reidratar) {
      await d.repo.criarSessao({
        id: this.id,
        closerId: this.closerId,
        leadId: this.p.leadId,
        meetingId: this.p.meetingId,
        plataforma: this.p.plataforma,
        meetingUrl: null,
        sttProvedor: d.cfg.STT_PROVEDOR,
        sttModelo: d.cfg.DEEPGRAM_MODEL,
        consentimento: this.p.consentimento
          ? { metodo: "extensao_v2", em: this.p.consentimento.em, id: this.p.consentimento.id, textoVersao: this.p.consentimento.textoVersao }
          : { metodo: "desconhecido", em: new Date().toISOString() },
        metadata: { protocolo: VERSAO_PROTOCOLO, temMicrofone: this.p.temMicrofone, cliente: this.p.cliente, dispositivoId: this.p.closer.dispositivoId ?? null },
      });
    } else {
      seqInicial = await d.repo.contarTranscricoes(this.id);
    }

    const [briefing, config] = await Promise.all([
      this.p.leadId
        ? d.repo.carregarBriefingCompleto(this.p.leadId).then(briefingResumido).catch((err) => {
            this.log.warn({ err }, "briefing indisponível para os prompts");
            return null;
          })
        : Promise.resolve(null),
      d.repo.carregarConfiguracao(this.closerId).catch((err) => {
        this.log.warn({ err }, "configuração indisponível; usando padrão");
        return { limiarSimilaridade: 0.78, maxSugestoes: 3, cooldownSegundos: 20, minPalavrasGatilho: 4, janelaContextoTurnos: 6, categoriasAtivas: [] as string[] };
      }),
    ]);
    this.janelaContexto = config.janelaContextoTurnos;
    this.sessao = new Sessao(this.id, this.closerId, this.p.leadId, briefing, d.repo, this.log, d.metricas, d.cfg.STT_PROVEDOR, d.cfg.CAMBIO_BRL, this.agora, 2000, {
      seqInicial,
      iniciadaEm: this.p.iniciadaEm,
    });

    try {
      this.stt = d.fabricaStt({ taxaAmostragem: 16000, canais: 2 });
      await this.stt.conectar();
      d.metricas.socketsStt.inc();
    } catch (err) {
      d.metricas.erro("stt_conexao_inicial");
      await d.repo.atualizarSessao(this.id, { status: "erro", errorMessage: `STT: ${mensagemDe(err)}` }).catch(() => undefined);
      throw new ErroCopiloto(`transcrição indisponível: ${mensagemDe(err)}`, "stt_indisponivel", 503, err);
    }

    this.pipeline = new Pipeline({
      gatilhos: d.playbook.gatilhos,
      vetorial: d.embedder ? new BuscaVetorial(d.embedder, d.repo, d.metricas) : null,
      ia: d.ia,
      rotuloCategoria: (id) => d.playbook.rotulo(id),
      categoriaConhecida: (id) => d.playbook.categoriaConhecida(id),
      metricas: d.metricas,
      log: this.log,
      saida: this.saida(),
      opcoes: {
        limiarSimilaridade: config.limiarSimilaridade,
        cooldownMs: config.cooldownSegundos * 1000,
        minPalavrasSemantica: config.minPalavrasGatilho,
        maxPalavrasResposta: 20,
        categoriasAtivas: new Set(config.categoriasAtivas),
      },
      agora: this.agora,
    });
    this.ligarStt();

    this.vivas.set(this.id, this);
    d.registro.adicionar({
      id: this.id,
      closerId: this.closerId,
      iniciadaEm: this.sessao.iniciadaEm,
      // Drenagem não derruba call: a sessão segue até `encerrar`. Só registramos.
      avisarDrenagem: (graceMs) => this.log.warn({ graceMs }, "instância em drenagem; call segue até encerrar"),
    });
    const restanteMs = Math.max(1000, d.cfg.SESSAO_MAX_MINUTOS * 60_000 - this.sessao.duracaoMs);
    this.tetoDuracao = setTimeout(() => {
      this.enviar({ tipo: "erro", codigo: "teto_duracao", texto: `A call passou do teto de ${d.cfg.SESSAO_MAX_MINUTOS} min.`, fatal: true });
      if (this.socket) fecharSeguro(this.socket, FECHAMENTO.tetoDeDuracao, "teto de duração");
      void this.encerrar("teto_duracao");
    }, restanteMs);
    this.log.info({ leadId: this.p.leadId, ia: this.pipeline.iaAtiva, reidratada: reidratar, seqInicial }, "call iniciada");
  }

  /** Liga (ou religa) um socket a esta call. */
  anexar(socket: WebSocket): void {
    if (this.timerGrace) clearTimeout(this.timerGrace);
    this.timerGrace = null;
    if (this.socket && this.socket !== socket) {
      // Socket antigo ainda pendurado (watchdog da extensão): fecha sem encerrar a call.
      const antigo = this.socket;
      antigo.removeAllListeners("message");
      antigo.removeAllListeners("close");
      fecharSeguro(antigo, 4000, "substituído por reconexão");
    }
    this.socket = socket;
    socket.on("message", (dados, binario) => this.aoMensagem(dados, binario));
    socket.on("close", () => this.aoSocketFechado(socket));
    socket.on("error", (err) => {
      this.d.metricas.erro("ws_socket");
      this.log.warn({ err }, "erro no socket da extensão");
    });
    let perdidos = 0;
    socket.on("pong", () => (perdidos = 0));
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      if (++perdidos > HEARTBEATS_PERDIDOS_MAX) {
        this.log.warn("heartbeat perdido 3x; derrubando socket (a call espera reconexão)");
        socket.terminate();
        return;
      }
      socket.ping();
    }, HEARTBEAT_MS);
    // Estado atual para quem acabou de (re)conectar.
    if (this.degradadoAvisado) this.enviar({ tipo: "degradado", motivo: this.motivoDegradacao() });
  }

  enviar(m: MensagemGateway): void {
    if (this.socket) enviarPara(this.socket, m);
  }

  private aoSocketFechado(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.encerrando) return;
    const grace = this.d.graceReconexaoMs ?? GRACE_RECONEXAO_MS;
    this.log.warn({ graceMs: grace }, "extensão desconectou sem `encerrar`; aguardando sessao.retomar");
    this.d.metricas.conexoesWs.inc({ estado: "queda" });
    this.timerGrace = setTimeout(() => void this.encerrar("conexao_perdida"), grace);
  }

  // ── entrada ──────────────────────────────────────────────────────────────

  private aoMensagem(dados: WebSocket.RawData, binario: boolean): void {
    if (binario) {
      const buf = Buffer.isBuffer(dados) ? dados : Array.isArray(dados) ? Buffer.concat(dados) : Buffer.from(dados);
      let frame;
      try {
        frame = lerFrame(buf);
      } catch (err) {
        this.d.metricas.erro("frame_invalido");
        this.enviar({ tipo: "erro", codigo: "frame", texto: mensagemDe(err), fatal: false });
        return;
      }
      if (frame.seq > this.ultimoSeq) this.ultimoSeq = frame.seq;
      if (frame.reenviado) this.reenviandoAte = this.agora() + JANELA_REENVIO_MS;
      if (this.pausado) return;
      this.sessao.bytesAudio += frame.pcm.length;
      this.stt.enviar(frame.pcm);
      return;
    }

    let msg;
    try {
      msg = MensagemCliente.parse(JSON.parse(dados.toString()));
    } catch (err) {
      this.enviar({ tipo: "erro", codigo: "protocolo", texto: `mensagem inválida: ${mensagemDe(err)}`, fatal: false });
      return;
    }
    switch (msg.tipo) {
      case "ping":
        this.enviar({ tipo: "pong", ts: msg.ts, ultimoSeq: this.ultimoSeq });
        break;
      case "captura.pausar":
        this.pausado = true;
        this.log.info("captura pausada pelo closer");
        break;
      case "captura.retomar":
        this.pausado = false;
        this.log.info("captura retomada");
        break;
      case "feedback":
        this.registrarFeedback(msg.sugestaoId, msg.valor, msg.em);
        break;
      case "encerrar":
        void this.encerrar(`extensao:${msg.motivo}`);
        break;
      case "sessao.iniciar":
      case "sessao.retomar":
        this.enviar({ tipo: "erro", codigo: "protocolo", texto: "sessão já em andamento", fatal: false });
        break;
    }
  }

  private registrarFeedback(sugestaoId: string, valor: keyof typeof OUTCOME_POR_FEEDBACK, em: string): void {
    const det = this.sessao.deteccoes.get(sugestaoId);
    if (!det) {
      this.enviar({ tipo: "erro", codigo: "feedback", texto: "sugestão desconhecida nesta call", fatal: false });
      return;
    }
    det.feedback = valor;
    this.d.metricas.feedback.inc({ resultado: OUTCOME_POR_FEEDBACK[valor] });
    void this.d.repo.atualizarDeteccao(sugestaoId, this.id, { outcome: OUTCOME_POR_FEEDBACK[valor], feedbackAt: em }).catch((err) => {
      this.d.metricas.erro("persistencia_feedback");
      this.enviar({ tipo: "erro", codigo: "feedback", texto: `feedback não gravado: ${mensagemDe(err)}`, fatal: false });
    });
  }

  // ── STT → motor ──────────────────────────────────────────────────────────

  private ligarStt(): void {
    const d = this.d;
    this.stt.on("primeira_palavra", (ms) => {
      this.primeiraPalavraMs = ms;
      d.metricas.observar("stt_primeira_palavra", ms);
      this.log.info({ ms }, "primeira palavra transcrita");
    });
    this.stt.on("transcricao", (ev) => {
      const falante = ev.canal === 0 ? "lead" : "closer";
      this.enviar({ tipo: "transcricao", texto: ev.texto, falante, final: ev.final });
      if (!ev.final) {
        if (falante === "lead" && this.inicioFalaLead === null) this.inicioFalaLead = this.agora();
        return;
      }
      const turno = this.sessao.registrarTurno(falante, ev.texto, ev.confianca, ev.inicioMs, ev.fimMs);
      if (falante !== "lead") return;
      const inicio = this.inicioFalaLead ?? this.agora();
      this.inicioFalaLead = null;
      d.metricas.observar("stt_turno_final", this.agora() - inicio);
      if (this.agora() < this.reenviandoAte) {
        // Áudio que chegou atrasado da fila da extensão: fica na transcrição, não vira card fora de hora.
        this.log.debug("turno do lead veio de áudio reenviado; sem sugestão ao vivo");
        return;
      }
      const ctx = { texto: turno.texto, historico: this.sessao.contexto(this.janelaContexto), briefing: this.sessao.briefingTexto(), emMs: turno.emMs };
      void this.pipeline.processarTurnoLead(ctx, inicio).catch((err) => this.saida().erro("pipeline", err));
    });
    this.stt.on("estado", (e) => {
      if (e.estado === "reconectando") {
        this.estadoStt = "reconectando";
        d.metricas.reconexoesStt.inc();
        this.enviar({ tipo: "reconectando", tentativa: e.tentativa });
      } else if (e.estado === "caiu") {
        this.estadoStt = "caiu";
        this.avisarDegradacao();
      } else {
        const estavaRuim = this.estadoStt !== "ok";
        this.estadoStt = "ok";
        if (estavaRuim) this.avisarRecuperacao();
      }
    });
    this.stt.on("erro", (err) => {
      d.metricas.erro("stt");
      this.enviar({ tipo: "erro", codigo: "stt", texto: err.message, fatal: this.estadoStt === "caiu" });
    });
  }

  private motivoDegradacao(): string {
    if (this.estadoStt === "caiu") return "Transcrição caiu no servidor";
    if (this.estadoStt === "reconectando") return "Transcrição religando no servidor";
    if (this.iaDesligadaPorCusto) return "IA desligada: teto de custo da call";
    if (this.estadoIa === "degradada") return "IA indisponível; seguindo só com o playbook";
    return "Copiloto degradado";
  }

  private avisarDegradacao(): void {
    const niveis = this.estadoIa !== "ok" ? ["L2", "L3"] : undefined;
    this.degradadoAvisado = true;
    this.enviar({ tipo: "degradado", motivo: this.motivoDegradacao(), ...(niveis ? { niveisDesligados: niveis } : {}) });
  }

  private avisarRecuperacao(): void {
    if (this.estadoStt !== "ok" || this.estadoIa === "degradada") return;
    if (!this.degradadoAvisado) return;
    this.degradadoAvisado = false;
    this.enviar({ tipo: "recuperado" });
  }

  // ── motor → extensão (adaptador de card) ─────────────────────────────────

  private saida(): SaidaPipeline {
    const d = this.d;
    return {
      emitir: (s: SugestaoEmitida) => {
        this.sessao.registrarDeteccao(s);
        const cardId = s.substitui ? (this.cardDe.get(s.substitui) ?? s.substitui) : s.deteccaoId;
        this.cardDe.set(s.deteccaoId, cardId);
        const pendente = !s.substitui && s.camada === "L0" && s.refinamentoPendente;

        const fallback = this.fallbackConclusao.get(cardId);
        if (fallback && !pendente) {
          clearTimeout(fallback);
          this.fallbackConclusao.delete(cardId);
        }
        this.enviar({ tipo: "sugestao", ...montarCard(s, cardId, pendente) });
        if (pendente) {
          this.fallbackConclusao.set(
            cardId,
            setTimeout(() => {
              this.fallbackConclusao.delete(cardId);
              this.enviar({ tipo: "sugestao", ...montarCard(s, cardId, false) });
            }, FALLBACK_CONCLUSAO_MS),
          );
        }
        this.log.info({ camada: s.camada, fonte: s.fonte, categoria: s.categoriaId, latenciaMs: Math.round(s.latenciaMs), card: cardId, pendente }, "sugestão");

        const persistencia = s.substitui
          ? d.repo.atualizarDeteccao(cardId, this.id, {
              suggestionShown: s.resposta,
              objecaoId: s.objecaoId,
              categoriaId: d.playbook.categoriaConhecida(s.categoriaId) ? s.categoriaId : null,
              similarity: s.similaridade ?? 0,
              matchMethod: metodoDe(s),
              latencyMs: Math.round(s.latenciaMs),
              llmModel: s.modelo,
            })
          : d.repo.inserirDeteccao({
              id: cardId,
              callId: this.id,
              closerId: this.closerId,
              objecaoId: s.objecaoId,
              categoriaId: d.playbook.categoriaConhecida(s.categoriaId) ? s.categoriaId : null,
              detectedAtMs: Math.round(s.emMs),
              trecho: s.trecho,
              similarity: s.similaridade ?? 0,
              matchMethod: metodoDe(s),
              suggestionShown: s.resposta,
              latencyMs: Math.round(s.latenciaMs),
              llmModel: s.modelo,
            });
        void persistencia.catch((err) => {
          d.metricas.erro("persistencia_deteccao");
          this.log.error({ err, card: cardId }, "falha ao persistir detecção");
          this.enviar({ tipo: "erro", codigo: "persistencia", texto: "Sugestão exibida, mas não gravada no histórico.", fatal: false });
        });
      },
      retirar: (deteccaoId, motivo) => {
        const cardId = this.cardDe.get(deteccaoId) ?? deteccaoId;
        const fallback = this.fallbackConclusao.get(cardId);
        if (fallback) {
          clearTimeout(fallback);
          this.fallbackConclusao.delete(cardId);
        }
        for (const det of this.sessao.deteccoes.values()) if (this.cardDe.get(det.deteccaoId) === cardId) det.retirada = true;
        this.enviar({ tipo: "sugestao.retirar", sugestaoId: cardId, motivo });
        void d.repo.atualizarDeteccao(cardId, this.id, { outcome: "descartada", feedbackAt: new Date().toISOString(), feedbackNote: motivo }).catch((err) => {
          d.metricas.erro("persistencia_deteccao");
          this.log.error({ err }, "falha ao marcar detecção retirada");
        });
      },
      erro: (origem, err) => {
        this.log.error({ origem, err }, "falha no pipeline");
        this.enviar({ tipo: "erro", codigo: origem, texto: mensagemDe(err), fatal: false });
      },
      custo: (ev) => {
        if (ev.tipo === "llm") {
          const usd = this.sessao.custo.registrarLlm(ev.modelo, ev.uso);
          d.metricas.custoUsd.inc({ componente: "anthropic" }, usd);
        } else {
          this.sessao.custo.registrarEmbedding(ev.tokens);
        }
        if (!this.iaDesligadaPorCusto && this.sessao.custo.excedeu(d.cfg.CUSTO_MAX_BRL_POR_CALL)) {
          this.iaDesligadaPorCusto = true;
          this.pipeline.desligarIa(`custo da call passou de R$ ${d.cfg.CUSTO_MAX_BRL_POR_CALL}`);
        }
      },
      estadoIa: (estado, motivo) => {
        if (estado === this.estadoIa) return;
        this.estadoIa = estado;
        if (estado === "ok") this.avisarRecuperacao();
        else {
          this.log.warn({ estado, motivo }, "IA degradada nesta call");
          this.avisarDegradacao();
        }
      },
    };
  }

  // ── fim ──────────────────────────────────────────────────────────────────

  async encerrar(motivo: string): Promise<void> {
    if (this.encerrando) return;
    this.encerrando = true;
    const d = this.d;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.timerGrace) clearTimeout(this.timerGrace);
    if (this.tetoDuracao) clearTimeout(this.tetoDuracao);
    for (const t of this.fallbackConclusao.values()) clearTimeout(t);
    this.fallbackConclusao.clear();
    this.log.info({ motivo }, "encerrando call");

    // A garantia validada em produção: espera o STT devolver os últimos `is_final`.
    try {
      await this.stt.finalizar();
    } catch (err) {
      this.log.warn({ err }, "falha ao finalizar STT");
    } finally {
      d.metricas.socketsStt.dec();
      d.metricas.bytesSttDescartados.inc(this.stt.bytesDescartados);
      this.stt.destruir();
    }
    this.sessao.encerrar();
    this.vivas.delete(this.id);
    d.registro.remover(this.id);

    const erroFlush = await this.sessao.flush();
    await d.repo.atualizarSessao(this.id, { status: "processando", endedAt: new Date().toISOString() }).catch((err) => {
      this.log.error({ err }, "falha ao marcar sessão como processando");
    });

    const resultado = await executarPosCall(this.sessao, {
      repo: d.repo,
      ia: this.pipeline.iaAtiva ? d.ia : null,
      log: this.log,
      metricas: d.metricas,
      categorias: () => d.playbook.listaCategorias(),
      categoriaConhecida: (id) => d.playbook.categoriaConhecida(id),
    });
    if (erroFlush) resultado.erros.push(`transcrições não gravadas: ${this.sessao.pendentesPersistencia} linha(s)`);

    const totais = this.sessao.custo.totais();
    d.metricas.custoUsd.inc({ componente: "deepgram" }, totais.sttUsd);
    await d.repo
      .atualizarSessao(this.id, {
        status: resultado.erros.length && !resultado.resumoOk ? "erro" : "concluida",
        sttCostUsd: totais.sttUsd,
        llmCostUsd: totais.llmUsd + totais.embeddingsUsd,
        errorMessage: resultado.erros.length ? resultado.erros.join(" | ").slice(0, 2000) : null,
        metadata: {
          custo: totais,
          turnos: this.sessao.turnos.length,
          deteccoes: this.sessao.deteccoes.size,
          bytesAudio: this.sessao.bytesAudio,
          ultimoSeq: this.ultimoSeq,
          primeiraPalavraMs: this.primeiraPalavraMs,
          duracaoMs: this.sessao.duracaoMs,
          motivoEncerramento: motivo,
          posCall: resultado,
        },
      })
      .catch((err) => this.log.error({ err }, "falha ao fechar sessão no banco"));

    d.metricas.callsConcluidas.inc({ desfecho: resultado.resumoOk ? "ok" : "sem_resumo" });
    this.log.info(
      { duracaoMin: +(this.sessao.duracaoMs / 60000).toFixed(1), turnos: this.sessao.turnos.length, deteccoes: this.sessao.deteccoes.size, custoBrl: +totais.totalBrl.toFixed(2), erros: resultado.erros.length },
      "call encerrada",
    );
    if (this.socket) fecharSeguro(this.socket, 1000, "call encerrada");
  }
}

// ── auxiliares ────────────────────────────────────────────────────────────────

function metodoDe(s: SugestaoEmitida): "lexical" | "hibrido" | "llm" {
  return s.fonte === "gatilho" ? "lexical" : s.fonte === "banco" ? "hibrido" : "llm";
}

/** Mapeia a emissão do motor para o card da extensão. */
export function montarCard(s: SugestaoEmitida, cardId: string, pendente: boolean): SugestaoCard {
  return {
    id: cardId,
    categoria: s.categoria,
    frase: s.resposta,
    nivel: s.categoriaId === "sinal_compra" ? "atencao" : "sugestao",
    eco: s.trecho.length > 52 ? `${s.trecho.slice(0, 51).trimEnd()}…` : s.trecho,
    fonte: s.fonte === "ia" ? "ia" : "playbook",
    ...(pendente ? { pendente: true } : {}),
    latenciaMs: Math.round(s.latenciaMs),
    geradoEm: Date.now(),
  };
}
