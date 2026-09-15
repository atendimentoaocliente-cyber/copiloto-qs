// src/components/sdr/copiloto/PlaybookPage.tsx — Playbook de Objeções (CRUD)
//
// O gestor edita aqui, sem deploy: objeções por categoria, gatilhos de fala e
// respostas versionadas (teto de 20 palavras). A versão primária é o que aparece
// na tela do closer durante a call.
//
// Padrão do QS: useState + useEffect/useCallback + supabase via lib/qs/copiloto.ts.
// Tailwind pré-compilado: só classes conferidas no CSS; cores em style={{}}.

import { useState, useEffect, useCallback, useMemo } from "react";
import { useQsAuth } from "@/contexts/QsAuthContext";
import {
  fetchCopilotCategorias,
  fetchCopilotObjecoes,
  fetchCopilotProdutos,
  fetchCopilotLacunas,
  createCopilotObjecao,
  updateCopilotObjecao,
  toggleCopilotObjecao,
  createCopilotResposta,
  setCopilotRespostaPrimaria,
  toggleCopilotResposta,
} from "@/lib/qs/copiloto";
import type {
  CopilotCategory,
  CopilotObjection,
  CopilotObjectionInput,
  CopilotProduto,
  CopilotLacuna,
  CopilotSeveridade,
  CopilotMomento,
} from "./types";
import {
  SEVERIDADE_LABELS,
  MOMENTO_LABELS,
  LIMITE_PALAVRAS_RESPOSTA,
  LIMITE_CARACTERES_RESPOSTA,
  contarPalavras,
} from "./types";
import {
  Pagina,
  Hero,
  Cartao,
  Selo,
  Chip,
  Carregando,
  ErroBanner,
  Vazio,
  Botao,
  Campo,
  Pilula,
  Alternador,
  Modal,
  Toast,
  TituloSecao,
  CLASSE_INPUT,
  CLASSE_SELECT_PILL,
  AZUL,
  AZUL_VIVO,
  fmtData,
  mensagemDoErro,
  hexComAlpha,
  type ToastEstado,
} from "./ui";

// ── Helpers ──────────────────────────────────────────────────────────────────

const COR_SEVERIDADE: Record<CopilotSeveridade, string> = {
  alta: "#B42318",
  media: "#B54708",
  baixa: "#667085",
};

type FiltroStatus = "ativas" | "inativas" | "todas";

function linhasParaLista(texto: string): string[] {
  return texto
    .split(/\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Contador ao vivo: palavras (teto duro) e caracteres (recomendação). */
function ContadorResposta({ texto }: { texto: string }) {
  const palavras = contarPalavras(texto);
  const chars = texto.trim().length;
  const estourou = palavras > LIMITE_PALAVRAS_RESPOSTA;
  const longa = chars > LIMITE_CARACTERES_RESPOSTA;
  return (
    <div className="flex items-center justify-between gap-3 mt-1.5">
      <span className="text-[11px] font-semibold tabular-nums" style={{ color: estourou ? "#B42318" : "#027A48" }}>
        {palavras}/{LIMITE_PALAVRAS_RESPOSTA} palavras {estourou ? "· acima do teto" : "✓"}
      </span>
      <span className="text-[11px] tabular-nums" style={{ color: longa ? "#B54708" : "#98A2B3" }}>
        {chars}/{LIMITE_CARACTERES_RESPOSTA} caracteres{longa ? " · pode não caber em 2 linhas" : ""}
      </span>
    </div>
  );
}

// ── Formulário de objeção ────────────────────────────────────────────────────

interface FormObjecao {
  titulo: string;
  category_id: string;
  momento: CopilotMomento;
  severidade: CopilotSeveridade;
  produto_id: string;
  exemplo_lead: string;
  gatilhos: string;
  variacoes: string;
  resposta: string;
  resposta_curta: string; // só na criação
}

function formVazio(categoriaPadrao: string): FormObjecao {
  return {
    titulo: "",
    category_id: categoriaPadrao,
    momento: "qualquer",
    severidade: "media",
    produto_id: "",
    exemplo_lead: "",
    gatilhos: "",
    variacoes: "",
    resposta: "",
    resposta_curta: "",
  };
}

function formDaObjecao(o: CopilotObjection): FormObjecao {
  return {
    titulo: o.titulo,
    category_id: o.category_id,
    momento: o.momento,
    severidade: o.severidade,
    produto_id: o.produto_id ?? "",
    exemplo_lead: o.exemplo_lead,
    gatilhos: o.gatilhos.join("\n"),
    variacoes: o.variacoes.join("\n"),
    resposta: o.resposta,
    resposta_curta: o.resposta_curta ?? "",
  };
}

function ModalObjecao({
  modo,
  inicial,
  categorias,
  produtos,
  salvando,
  aoFechar,
  aoSalvar,
}: {
  modo: "nova" | "editar";
  inicial: FormObjecao;
  categorias: CopilotCategory[];
  produtos: CopilotProduto[];
  salvando: boolean;
  aoFechar: () => void;
  aoSalvar: (form: FormObjecao) => void;
}) {
  const [form, setForm] = useState<FormObjecao>(inicial);
  const set = <K extends keyof FormObjecao>(k: K, v: FormObjecao[K]) => setForm((f) => ({ ...f, [k]: v }));

  const palavrasCurta = contarPalavras(form.resposta_curta);
  const curtaInvalida = modo === "nova" && (!form.resposta_curta.trim() || palavrasCurta > LIMITE_PALAVRAS_RESPOSTA);
  const invalido = !form.titulo.trim() || !form.category_id || !form.exemplo_lead.trim() || !form.resposta.trim() || curtaInvalida;

  return (
    <Modal
      titulo={modo === "nova" ? "Nova objeção" : "Editar objeção"}
      sub="O que o lead diz, como o Copiloto reconhece e o que o closer responde."
      aoFechar={aoFechar}
      largura={720}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar} disabled={salvando}>Cancelar</Botao>
          <Botao onClick={() => aoSalvar(form)} disabled={invalido || salvando}>
            {salvando ? "Salvando..." : modo === "nova" ? "Criar objeção" : "Salvar alterações"}
          </Botao>
        </>
      }
    >
      <div className="space-y-4">
        <Campo label="Título" dica="Nome curto, como o time chama essa objeção.">
          <input value={form.titulo} onChange={(e) => set("titulo", e.target.value)} className={CLASSE_INPUT} placeholder="Ex.: Vou ver com meu marido" />
        </Campo>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Campo label="Categoria">
            <select value={form.category_id} onChange={(e) => set("category_id", e.target.value)} className={CLASSE_INPUT}>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </Campo>
          <Campo label="Momento da call">
            <select value={form.momento} onChange={(e) => set("momento", e.target.value as CopilotMomento)} className={CLASSE_INPUT}>
              {(Object.keys(MOMENTO_LABELS) as CopilotMomento[]).map((m) => (
                <option key={m} value={m}>{MOMENTO_LABELS[m]}</option>
              ))}
            </select>
          </Campo>
          <Campo label="Severidade">
            <select value={form.severidade} onChange={(e) => set("severidade", e.target.value as CopilotSeveridade)} className={CLASSE_INPUT}>
              {(Object.keys(SEVERIDADE_LABELS) as CopilotSeveridade[]).map((s) => (
                <option key={s} value={s}>{SEVERIDADE_LABELS[s]}</option>
              ))}
            </select>
          </Campo>
          <Campo label="Destino / produto">
            <select value={form.produto_id} onChange={(e) => set("produto_id", e.target.value)} className={CLASSE_INPUT}>
              <option value="">Todos os destinos</option>
              {produtos.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Campo>
        </div>

        <Campo label="Como o lead fala" dica="A frase literal, do jeito que sai na call. É o que alimenta a busca semântica.">
          <textarea rows={2} value={form.exemplo_lead} onChange={(e) => set("exemplo_lead", e.target.value)} className={`${CLASSE_INPUT} resize-none`} placeholder="Ex.: Preciso conversar com meu marido antes de fechar qualquer coisa." />
        </Campo>

        <div className="grid grid-cols-2 gap-4">
          <Campo label="Gatilhos de fala" dica="Uma por linha. Detecção instantânea por palavra, sem custo de IA.">
            <textarea rows={4} value={form.gatilhos} onChange={(e) => set("gatilhos", e.target.value)} className={`${CLASSE_INPUT} resize-none font-mono`} placeholder={"meu marido\nminha esposa\nfalar com"} />
          </Campo>
          <Campo label="Variações" dica="Outros jeitos de dizer a mesma coisa. Uma por linha.">
            <textarea rows={4} value={form.variacoes} onChange={(e) => set("variacoes", e.target.value)} className={`${CLASSE_INPUT} resize-none`} placeholder={"vou ver com a família\nnão decido sozinha"} />
          </Campo>
        </div>

        <Campo label="Resposta completa" dica="Contexto para treino e para o resumo pós-call. O closer NÃO lê isso na tela.">
          <textarea rows={4} value={form.resposta} onChange={(e) => set("resposta", e.target.value)} className={`${CLASSE_INPUT} resize-none`} />
        </Campo>

        {modo === "nova" && (
          <Campo label="Resposta na tela (versão 1)" dica={`O que o closer lê em uma olhada. Teto: ${LIMITE_PALAVRAS_RESPOSTA} palavras.`}>
            <input value={form.resposta_curta} onChange={(e) => set("resposta_curta", e.target.value)} className={CLASSE_INPUT} placeholder="Ex.: Faz sentido. Quando vocês conseguem conversar? Já deixo a data reservada." />
            <ContadorResposta texto={form.resposta_curta} />
          </Campo>
        )}
      </div>
    </Modal>
  );
}

// ── Modal de nova versão ─────────────────────────────────────────────────────

function ModalNovaVersao({
  objecao,
  salvando,
  aoFechar,
  aoSalvar,
}: {
  objecao: CopilotObjection;
  salvando: boolean;
  aoFechar: () => void;
  aoSalvar: (texto: string, motivo: string, tornarPrimaria: boolean) => void;
}) {
  const [texto, setTexto] = useState("");
  const [motivo, setMotivo] = useState("");
  const [primaria, setPrimaria] = useState(true);
  const invalido = !texto.trim() || contarPalavras(texto) > LIMITE_PALAVRAS_RESPOSTA;
  const proximaVersao = ((objecao.responses ?? []).reduce((m, r) => Math.max(m, r.versao), 0) || 0) + 1;

  return (
    <Modal
      titulo={`Nova versão da resposta · v${proximaVersao}`}
      sub={objecao.titulo}
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar} disabled={salvando}>Cancelar</Botao>
          <Botao onClick={() => aoSalvar(texto, motivo, primaria)} disabled={invalido || salvando}>
            {salvando ? "Salvando..." : "Salvar versão"}
          </Botao>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg px-4 py-3 bg-gray-50">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Lead diz</p>
          <p className="text-sm text-gray-700 italic mt-0.5">“{objecao.exemplo_lead}”</p>
        </div>
        <Campo label="Resposta na tela" dica={`Uma frase falável. Teto: ${LIMITE_PALAVRAS_RESPOSTA} palavras.`}>
          <textarea rows={2} value={texto} onChange={(e) => setTexto(e.target.value)} className={`${CLASSE_INPUT} resize-none`} autoFocus />
          <ContadorResposta texto={texto} />
        </Campo>
        <Campo label="Por que essa versão?" dica="Opcional. Ex.: 'a anterior era dispensada em 40% das vezes'.">
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} className={CLASSE_INPUT} />
        </Campo>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={primaria} onChange={(e) => setPrimaria(e.target.checked)} />
          Tornar esta a resposta exibida ao closer (primária)
        </label>
      </div>
    </Modal>
  );
}

// ── Card da objeção ──────────────────────────────────────────────────────────

function CardObjecao({
  objecao,
  podeEditar,
  ocupado,
  aoEditar,
  aoAlternarAtiva,
  aoNovaVersao,
  aoTornarPrimaria,
  aoAlternarVersao,
}: {
  objecao: CopilotObjection;
  podeEditar: boolean;
  ocupado: boolean;
  aoEditar: () => void;
  aoAlternarAtiva: (ativa: boolean) => void;
  aoNovaVersao: () => void;
  aoTornarPrimaria: (responseId: string) => void;
  aoAlternarVersao: (responseId: string, ativa: boolean) => void;
}) {
  const [aberta, setAberta] = useState(false);
  const versoes = objecao.responses ?? [];
  const primaria = versoes.find((r) => r.is_primary) ?? null;
  const textoTela = primaria?.texto ?? objecao.resposta_curta ?? "";
  const cor = objecao.category?.cor ?? "#64748B";

  return (
    <Cartao className={`overflow-hidden ${objecao.is_active ? "" : "opacity-60"}`} style={{ borderLeft: `4px solid ${cor}` }}>
      <div className="px-5 py-4">
        {/* Cabeçalho */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Selo cor={COR_SEVERIDADE[objecao.severidade]}>{SEVERIDADE_LABELS[objecao.severidade]}</Selo>
              <h4 className="text-[15px] font-bold text-gray-900">{objecao.titulo}</h4>
              {!objecao.is_active && <Selo cor="#98A2B3">Desativada</Selo>}
              {!primaria && <Selo cor="#B54708">Sem resposta primária</Selo>}
            </div>
            <p className="text-[13px] text-gray-500 italic mt-1">“{objecao.exemplo_lead}”</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap">usada {objecao.uso_total}×</span>
            {podeEditar && (
              <>
                <Alternador ligado={objecao.is_active} onChange={aoAlternarAtiva} disabled={ocupado} rotulo={objecao.is_active ? "Desativar objeção" : "Ativar objeção"} />
                <button onClick={aoEditar} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors" title="Editar">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Resposta na tela */}
        <div className="mt-3 rounded-lg px-4 py-3" style={{ background: hexComAlpha(AZUL_VIVO, 0.06), border: `1px solid ${hexComAlpha(AZUL_VIVO, 0.15)}` }}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: AZUL_VIVO }}>Resposta na tela do closer</p>
            {primaria && <span className="text-[10px] text-gray-400 tabular-nums">v{primaria.versao} · {contarPalavras(primaria.texto)}/{LIMITE_PALAVRAS_RESPOSTA} palavras</span>}
          </div>
          <p className="text-[15px] font-semibold leading-snug mt-1" style={{ color: AZUL }}>
            {textoTela || <span className="text-gray-400 font-normal">Nenhuma versão primária. Crie uma versão.</span>}
          </p>
        </div>

        {/* Gatilhos e meta */}
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mr-1">Gatilhos</span>
          {objecao.gatilhos.length === 0 && <span className="text-[11px] text-gray-400">nenhum — só detecção semântica</span>}
          {objecao.gatilhos.map((g) => (
            <Chip key={g}>{g}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-2 text-[11px] text-gray-400">
          <span>{MOMENTO_LABELS[objecao.momento]}</span>
          <span>·</span>
          <span>{objecao.variacoes.length} variações</span>
          <span>·</span>
          <span>{versoes.length} {versoes.length === 1 ? "versão" : "versões"}</span>
          {!objecao.embedding_updated_at && (
            <>
              <span>·</span>
              <span style={{ color: "#B54708" }}>embedding pendente (gateway recalcula)</span>
            </>
          )}
          <button onClick={() => setAberta((v) => !v)} className="ml-auto font-semibold hover:underline" style={{ color: AZUL_VIVO }}>
            {aberta ? "Ocultar versões" : "Ver versões"}
          </button>
        </div>
      </div>

      {/* Versões */}
      {aberta && (
        <div className="px-5 py-4 bg-gray-50" style={{ borderTop: "1px solid #F2F4F7" }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Histórico de respostas</p>
            {podeEditar && (
              <Botao pequeno variante="secundario" onClick={aoNovaVersao} disabled={ocupado}>+ Nova versão</Botao>
            )}
          </div>
          {versoes.length === 0 ? (
            <p className="text-[12px] text-gray-400">Nenhuma versão ainda.</p>
          ) : (
            <div className="space-y-2">
              {versoes.map((r) => (
                <div key={r.id} className={`bg-white rounded-lg px-4 py-3 flex items-start gap-3 ${r.is_active ? "" : "opacity-60"}`} style={{ border: r.is_primary ? `1px solid ${hexComAlpha(AZUL_VIVO, 0.4)}` : "1px solid #EAECF0" }}>
                  <div className="shrink-0 w-8 text-[11px] font-bold text-gray-400 tabular-nums mt-0.5">v{r.versao}</div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${r.is_active ? "text-gray-900" : "text-gray-500 line-through"}`}>{r.texto}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px] text-gray-400">
                      {r.is_primary && <Selo cor={AZUL_VIVO} solido>Primária</Selo>}
                      {!r.is_active && <Selo cor="#98A2B3">Desativada</Selo>}
                      <span>{contarPalavras(r.texto)} palavras</span>
                      <span>·</span>
                      <span>{r.autor?.name ?? "—"} · {fmtData(r.created_at)}</span>
                      {r.motivo && (
                        <>
                          <span>·</span>
                          <span className="italic">{r.motivo}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {podeEditar && (
                    <div className="flex items-center gap-1 shrink-0">
                      {!r.is_primary && r.is_active && (
                        <Botao pequeno variante="fantasma" onClick={() => aoTornarPrimaria(r.id)} disabled={ocupado}>Tornar primária</Botao>
                      )}
                      {!r.is_primary && (
                        <Botao pequeno variante="fantasma" onClick={() => aoAlternarVersao(r.id, !r.is_active)} disabled={ocupado}>
                          {r.is_active ? "Desativar" : "Reativar"}
                        </Botao>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Cartao>
  );
}

// ── Página ───────────────────────────────────────────────────────────────────

export default function PlaybookPage() {
  const { currentUser } = useQsAuth();
  const podeEditar = currentUser?.role === "admin" || currentUser?.role === "gestor";

  const [categorias, setCategorias] = useState<CopilotCategory[]>([]);
  const [objecoes, setObjecoes] = useState<CopilotObjection[]>([]);
  const [produtos, setProdutos] = useState<CopilotProduto[]>([]);
  const [lacunas, setLacunas] = useState<CopilotLacuna[]>([]);
  const [erroLacunas, setErroLacunas] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);
  const [toast, setToast] = useState<ToastEstado | null>(null);

  const [busca, setBusca] = useState("");
  const [filtroCategoria, setFiltroCategoria] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<FiltroStatus>("ativas");
  const [filtroMomento, setFiltroMomento] = useState<CopilotMomento | "">("");

  const [modalObjecao, setModalObjecao] = useState<{ modo: "nova" | "editar"; objecao?: CopilotObjection; inicial: FormObjecao } | null>(null);
  const [modalVersao, setModalVersao] = useState<CopilotObjection | null>(null);

  function avisar(mensagem: string, tipo: ToastEstado["tipo"] = "sucesso") {
    setToast({ mensagem, tipo });
    setTimeout(() => setToast(null), 3200);
  }

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const [cats, objs, prods] = await Promise.all([fetchCopilotCategorias(), fetchCopilotObjecoes(), fetchCopilotProdutos()]);
      setCategorias(cats);
      setObjecoes(objs);
      setProdutos(prods);
    } catch (e) {
      setErro(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const carregarLacunas = useCallback(async () => {
    setErroLacunas(null);
    try {
      setLacunas(await fetchCopilotLacunas(30));
    } catch (e) {
      setErroLacunas(e);
    }
  }, []);

  useEffect(() => {
    carregar();
    carregarLacunas();
  }, [carregar, carregarLacunas]);

  /** Recarrega só a lista de objeções (após uma escrita), sem piscar a página. */
  async function recarregarObjecoes() {
    try {
      setObjecoes(await fetchCopilotObjecoes());
    } catch (e) {
      setErro(e);
    }
  }

  async function executar(acao: () => Promise<void>, mensagemOk: string) {
    setOcupado(true);
    try {
      await acao();
      await recarregarObjecoes();
      avisar(mensagemOk);
      return true;
    } catch (e) {
      avisar(mensagemDoErro(e), "erro");
      return false;
    } finally {
      setOcupado(false);
    }
  }

  async function salvarObjecao(form: FormObjecao) {
    if (!currentUser || !modalObjecao) return;
    const input: CopilotObjectionInput = {
      titulo: form.titulo.trim(),
      category_id: form.category_id,
      momento: form.momento,
      severidade: form.severidade,
      produto_id: form.produto_id || null,
      exemplo_lead: form.exemplo_lead.trim(),
      gatilhos: linhasParaLista(form.gatilhos),
      variacoes: linhasParaLista(form.variacoes),
      resposta: form.resposta.trim(),
    };
    const ok = await executar(
      async () => {
        if (modalObjecao.modo === "nova") await createCopilotObjecao(input, form.resposta_curta, currentUser.id);
        else if (modalObjecao.objecao) await updateCopilotObjecao(modalObjecao.objecao.id, input);
      },
      modalObjecao.modo === "nova" ? "Objeção criada. O gateway recalcula o embedding em instantes." : "Objeção atualizada."
    );
    if (ok) setModalObjecao(null);
  }

  async function salvarVersao(texto: string, motivo: string, tornarPrimaria: boolean) {
    if (!currentUser || !modalVersao) return;
    const ok = await executar(
      () => createCopilotResposta(modalVersao.id, texto, currentUser.id, { motivo, tornarPrimaria }).then(() => undefined),
      tornarPrimaria ? "Nova versão salva e já exibida ao closer." : "Nova versão salva."
    );
    if (ok) setModalVersao(null);
  }

  // ── Filtro (cliente) ──
  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return objecoes.filter((o) => {
      if (filtroStatus === "ativas" && !o.is_active) return false;
      if (filtroStatus === "inativas" && o.is_active) return false;
      if (filtroCategoria && o.category_id !== filtroCategoria) return false;
      if (filtroMomento && o.momento !== filtroMomento) return false;
      if (q) {
        const alvo = [o.titulo, o.exemplo_lead, o.resposta_curta ?? "", ...o.gatilhos, ...o.variacoes, ...(o.responses ?? []).map((r) => r.texto)]
          .join(" ")
          .toLowerCase();
        if (!alvo.includes(q)) return false;
      }
      return true;
    });
  }, [objecoes, busca, filtroStatus, filtroCategoria, filtroMomento]);

  const porCategoria = useMemo(() => {
    const grupos = categorias
      .map((c) => ({ categoria: c, itens: filtradas.filter((o) => o.category_id === c.id) }))
      .filter((g) => g.itens.length > 0);
    const orfas = filtradas.filter((o) => !categorias.some((c) => c.id === o.category_id));
    if (orfas.length > 0) {
      grupos.push({
        categoria: { id: "_outras", label: "Sem categoria ativa", descricao: null, cor: "#64748B", sort_order: 999, is_active: true, created_at: "", updated_at: "" },
        itens: orfas,
      });
    }
    return grupos;
  }, [categorias, filtradas]);

  // ── KPIs ──
  const ativas = objecoes.filter((o) => o.is_active).length;
  const categoriasComObjecao = new Set(objecoes.filter((o) => o.is_active).map((o) => o.category_id)).size;
  const totalVersoes = objecoes.reduce((s, o) => s + (o.responses?.length ?? 0), 0);
  const usoTotal = objecoes.reduce((s, o) => s + o.uso_total, 0);

  if (loading) return <Pagina><Carregando texto="Carregando playbook..." /></Pagina>;

  return (
    <Pagina>
      <Hero
        titulo="Playbook de Objeções"
        subtitulo="O que o Copiloto coloca na tela do closer quando o lead resiste. Editável aqui, sem deploy."
        kpis={[
          { valor: String(ativas), label: "Objeções ativas", sub: `${objecoes.length - ativas} desativadas` },
          { valor: String(categoriasComObjecao), label: "Categorias", sub: `de ${categorias.length} no catálogo` },
          { valor: String(totalVersoes), label: "Versões de resposta", sub: "histórico editável" },
          { valor: usoTotal.toLocaleString("pt-BR"), label: "Sugestões usadas", sub: "acumulado em calls" },
        ]}
        acoes={
          podeEditar ? (
            <button
              onClick={() => setModalObjecao({ modo: "nova", inicial: formVazio(categorias[0]?.id ?? "") })}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-white hover:opacity-90 transition-opacity"
              style={{ color: AZUL }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              Nova objeção
            </button>
          ) : undefined
        }
      />

      {erro && <ErroBanner erro={erro} aoTentar={carregar} />}

      {!podeEditar && (
        <div className="rounded-xl px-4 py-3 text-[12px] text-gray-600 bg-white" style={{ border: "1px solid #EAECF0" }}>
          Você está vendo o playbook em modo leitura. Quem edita é o gestor — sugestões de resposta vão para ele.
        </div>
      )}

      {/* Busca e filtros */}
      <div className="space-y-3">
        <div className="relative">
          <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por título, frase do lead, gatilho ou resposta..."
            className={`${CLASSE_INPUT} pl-10`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pilula ativa={filtroStatus === "ativas"} onClick={() => setFiltroStatus("ativas")}>Ativas</Pilula>
          <Pilula ativa={filtroStatus === "inativas"} onClick={() => setFiltroStatus("inativas")}>Desativadas</Pilula>
          <Pilula ativa={filtroStatus === "todas"} onClick={() => setFiltroStatus("todas")}>Todas</Pilula>
          <span className="w-px h-5 bg-gray-200" />
          <select value={filtroCategoria} onChange={(e) => setFiltroCategoria(e.target.value)} className={CLASSE_SELECT_PILL}>
            <option value="">Categoria</option>
            {categorias.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <select value={filtroMomento} onChange={(e) => setFiltroMomento(e.target.value as CopilotMomento | "")} className={CLASSE_SELECT_PILL}>
            <option value="">Momento da call</option>
            {(Object.keys(MOMENTO_LABELS) as CopilotMomento[]).map((m) => (
              <option key={m} value={m}>{MOMENTO_LABELS[m]}</option>
            ))}
          </select>
          {(filtroCategoria || filtroMomento || busca) && (
            <button
              onClick={() => { setFiltroCategoria(""); setFiltroMomento(""); setBusca(""); }}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 bg-white hover:bg-red-50 transition-colors"
            >
              Limpar filtros
            </button>
          )}
          <span className="ml-auto text-[12px] text-gray-400">{filtradas.length} de {objecoes.length}</span>
        </div>
      </div>

      {/* Lista agrupada por categoria */}
      {!erro && filtradas.length === 0 && (
        <Vazio
          titulo={objecoes.length === 0 ? "Playbook vazio" : "Nenhuma objeção com esses filtros"}
          texto={objecoes.length === 0 ? "Comece pelas cinco objeções que mais aparecem nas calls de fechamento: preço, 'vou pensar', cônjuge, segurança e concorrente." : "Ajuste a busca ou os filtros."}
          acao={podeEditar && objecoes.length === 0 ? <Botao onClick={() => setModalObjecao({ modo: "nova", inicial: formVazio(categorias[0]?.id ?? "") })}>Criar a primeira objeção</Botao> : undefined}
        />
      )}

      {porCategoria.map(({ categoria, itens }) => (
        <section key={categoria.id} className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: categoria.cor }} />
            <h2 className="text-[13px] font-bold text-gray-900 uppercase tracking-wider">{categoria.label}</h2>
            {categoria.descricao && <span className="text-[12px] text-gray-400 hidden md:inline">· {categoria.descricao}</span>}
            <span className="ml-auto text-[11px] font-semibold text-gray-400 tabular-nums">{itens.length} {itens.length === 1 ? "objeção" : "objeções"}</span>
          </div>
          {itens.map((o) => (
            <CardObjecao
              key={o.id}
              objecao={o}
              podeEditar={podeEditar}
              ocupado={ocupado}
              aoEditar={() => setModalObjecao({ modo: "editar", objecao: o, inicial: formDaObjecao(o) })}
              aoAlternarAtiva={(ativa) => executar(() => toggleCopilotObjecao(o.id, ativa), ativa ? "Objeção ativada." : "Objeção desativada — o Copiloto não sugere mais.")}
              aoNovaVersao={() => setModalVersao(o)}
              aoTornarPrimaria={(rid) => executar(() => setCopilotRespostaPrimaria(o.id, rid), "Resposta primária atualizada.")}
              aoAlternarVersao={(rid, ativa) => executar(() => toggleCopilotResposta(rid, ativa), ativa ? "Versão reativada." : "Versão desativada.")}
            />
          ))}
        </section>
      ))}

      {/* Lacunas: onde o playbook é cego */}
      <section className="space-y-3">
        <TituloSecao sub="Falas do lead que o Copiloto detectou nos últimos 30 dias sem nenhuma objeção correspondente. É aqui que o playbook cresce.">
          Detectadas sem resposta no playbook
        </TituloSecao>
        {erroLacunas && <ErroBanner erro={erroLacunas} aoTentar={carregarLacunas} titulo="Não foi possível carregar as lacunas" />}
        {!erroLacunas && lacunas.length === 0 && (
          <Cartao className="px-5 py-4">
            <p className="text-[13px] text-gray-500">Nenhuma lacuna nos últimos 30 dias. Tudo que o lead disse tinha resposta pronta.</p>
          </Cartao>
        )}
        {lacunas.length > 0 && (
          <Cartao className="overflow-hidden">
            <div className="divide-y">
              {lacunas.map((l) => (
                <div key={l.trecho} className="px-5 py-3 flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 truncate">“{l.trecho}”</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">{l.categoria ?? "Sem categoria"} · última vez {fmtData(l.ultima_em)}</p>
                  </div>
                  <span className="text-[13px] font-bold tabular-nums shrink-0" style={{ color: "#B54708" }}>{l.ocorrencias}×</span>
                  {podeEditar && (
                    <Botao
                      pequeno
                      variante="secundario"
                      onClick={() =>
                        setModalObjecao({
                          modo: "nova",
                          inicial: { ...formVazio(l.category_id ?? categorias[0]?.id ?? ""), exemplo_lead: l.trecho },
                        })
                      }
                    >
                      Criar objeção
                    </Botao>
                  )}
                </div>
              ))}
            </div>
          </Cartao>
        )}
      </section>

      {modalObjecao && (
        <ModalObjecao
          modo={modalObjecao.modo}
          inicial={modalObjecao.inicial}
          categorias={categorias}
          produtos={produtos}
          salvando={ocupado}
          aoFechar={() => setModalObjecao(null)}
          aoSalvar={salvarObjecao}
        />
      )}
      {modalVersao && (
        <ModalNovaVersao objecao={modalVersao} salvando={ocupado} aoFechar={() => setModalVersao(null)} aoSalvar={salvarVersao} />
      )}
      <Toast toast={toast} />
    </Pagina>
  );
}
