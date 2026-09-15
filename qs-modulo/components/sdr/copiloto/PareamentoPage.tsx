// src/components/sdr/copiloto/PareamentoPage.tsx — Parear a extensão do Copiloto
//
// Gera o código de 6 dígitos que o closer digita na extensão do Chrome. A extensão
// troca o código por um token no gateway (Frente B), que marca `claimed_at`.
// O QS não usa Supabase Auth, então este código é a única ponte segura entre
// o navegador do closer e a identidade dele no QS.

import { useState, useEffect, useCallback, useMemo } from "react";
import { useQsAuth, canSeeAllData } from "@/contexts/QsAuthContext";
import { gerarCodigoPareamento, fetchPareamentos, revogarPareamento, fetchClosers, PAREAMENTO_VALIDADE_MIN } from "@/lib/qs/copiloto";
import type { CopilotPairing } from "./types";
import {
  Pagina,
  Hero,
  Cartao,
  Selo,
  Carregando,
  ErroBanner,
  Botao,
  Campo,
  Toast,
  TituloSecao,
  CLASSE_INPUT,
  AZUL,
  AZUL_VIVO,
  fmtDataHora,
  mensagemDoErro,
  hexComAlpha,
  type ToastEstado,
} from "./ui";

type EstadoPareamento = "pendente" | "pareado" | "expirado" | "revogado";

function estadoDe(p: CopilotPairing, agora: number): EstadoPareamento {
  if (p.revoked_at) return "revogado";
  if (p.claimed_at) return "pareado";
  if (new Date(p.expires_at).getTime() < agora) return "expirado";
  return "pendente";
}

const COR_ESTADO: Record<EstadoPareamento, string> = {
  pendente: "#B54708",
  pareado: "#027A48",
  expirado: "#98A2B3",
  revogado: "#B42318",
};

const LABEL_ESTADO: Record<EstadoPareamento, string> = {
  pendente: "Aguardando extensão",
  pareado: "Pareado",
  expirado: "Expirado",
  revogado: "Revogado",
};

function Passo({ numero, titulo, texto }: { numero: number; titulo: string; texto: string }) {
  return (
    <Cartao className="px-5 py-4 flex items-start gap-3">
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[12px] font-bold text-white shrink-0" style={{ background: AZUL }}>{numero}</span>
      <div>
        <p className="text-[13px] font-bold text-gray-900">{titulo}</p>
        <p className="text-[12px] text-gray-500 mt-0.5">{texto}</p>
      </div>
    </Cartao>
  );
}

export default function PareamentoPage() {
  const { currentUser } = useQsAuth();
  const podeEscolher = currentUser ? canSeeAllData(currentUser.role) : false;

  const [closers, setClosers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [alvoId, setAlvoId] = useState(currentUser?.id ?? "");
  const [apelido, setApelido] = useState("");
  const [gerado, setGerado] = useState<CopilotPairing | null>(null);
  const [pareamentos, setPareamentos] = useState<CopilotPairing[]>([]);
  const [loading, setLoading] = useState(true);
  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState<unknown>(null);
  const [toast, setToast] = useState<ToastEstado | null>(null);
  const [agora, setAgora] = useState(Date.now());

  function avisar(mensagem: string, tipo: ToastEstado["tipo"] = "sucesso") {
    setToast({ mensagem, tipo });
    setTimeout(() => setToast(null), 3200);
  }

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const [lista, users] = await Promise.all([fetchPareamentos(podeEscolher ? undefined : currentUser?.id), podeEscolher ? fetchClosers() : Promise.resolve([])]);
      setPareamentos(lista);
      if (podeEscolher) setClosers(users);
    } catch (e) {
      setErro(e);
    } finally {
      setLoading(false);
    }
  }, [podeEscolher, currentUser?.id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Relógio de 1 s (contagem regressiva) + checagem a cada 5 s se a extensão pareou
  useEffect(() => {
    const tick = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!gerado || gerado.claimed_at) return;
    const id = setInterval(async () => {
      try {
        const lista = await fetchPareamentos(gerado.user_id);
        const atual = lista.find((p) => p.id === gerado.id);
        if (atual) {
          setGerado(atual);
          setPareamentos((prev) => prev.map((p) => (p.id === atual.id ? atual : p)));
          if (atual.claimed_at) avisar(`Extensão pareada${atual.device_label ? ` · ${atual.device_label}` : ""}.`);
        }
      } catch {
        // a checagem periódica não derruba a tela; o erro da carga principal já é visível
      }
    }, 5000);
    return () => clearInterval(id);
  }, [gerado]);

  async function gerar() {
    if (!currentUser || !alvoId) return;
    setGerando(true);
    try {
      const p = await gerarCodigoPareamento(alvoId, currentUser.id, apelido);
      setGerado(p);
      setPareamentos((prev) => [p, ...prev.map((x) => (x.user_id === alvoId && !x.claimed_at && !x.revoked_at ? { ...x, revoked_at: new Date().toISOString() } : x))]);
    } catch (e) {
      avisar(mensagemDoErro(e), "erro");
    } finally {
      setGerando(false);
    }
  }

  async function revogar(p: CopilotPairing) {
    try {
      await revogarPareamento(p.id);
      setPareamentos((prev) => prev.map((x) => (x.id === p.id ? { ...x, revoked_at: new Date().toISOString() } : x)));
      if (gerado?.id === p.id) setGerado(null);
      avisar("Acesso revogado. A extensão precisa parear de novo.");
    } catch (e) {
      avisar(mensagemDoErro(e), "erro");
    }
  }

  async function copiar() {
    if (!gerado) return;
    try {
      await navigator.clipboard.writeText(gerado.code);
      avisar("Código copiado.");
    } catch {
      avisar("Não foi possível copiar. Digite o código manualmente.", "erro");
    }
  }

  const estadoGerado = gerado ? estadoDe(gerado, agora) : null;
  const restanteSeg = gerado ? Math.max(0, Math.floor((new Date(gerado.expires_at).getTime() - agora) / 1000)) : 0;
  const restanteFmt = `${Math.floor(restanteSeg / 60)}:${String(restanteSeg % 60).padStart(2, "0")}`;

  const kpis = useMemo(() => {
    const ativos = pareamentos.filter((p) => estadoDe(p, agora) === "pareado").length;
    const pendentes = pareamentos.filter((p) => estadoDe(p, agora) === "pendente").length;
    const pessoas = new Set(pareamentos.filter((p) => estadoDe(p, agora) === "pareado").map((p) => p.user_id)).size;
    return { ativos, pendentes, pessoas };
  }, [pareamentos, agora]);

  const nomeAlvo = podeEscolher ? closers.find((c) => c.id === alvoId)?.name ?? currentUser?.name : currentUser?.name;

  if (loading) return <Pagina><Carregando texto="Carregando pareamentos..." /></Pagina>;

  return (
    <Pagina>
      <Hero
        titulo="Parear a extensão"
        subtitulo="Liga o Chrome do closer à conta dele no QS. Sem isso, a extensão não sobe áudio nem recebe sugestões."
        kpis={[
          { valor: String(kpis.ativos), label: "Extensões pareadas", sub: `${kpis.pessoas} ${kpis.pessoas === 1 ? "pessoa" : "pessoas"}` },
          { valor: String(kpis.pendentes), label: "Códigos pendentes", sub: `expiram em ${PAREAMENTO_VALIDADE_MIN} min` },
          { valor: "6", label: "Dígitos", sub: "uso único, gerado aqui" },
          { valor: `${PAREAMENTO_VALIDADE_MIN} min`, label: "Validade", sub: "depois disso, gere outro" },
        ]}
      />

      {erro && <ErroBanner erro={erro} aoTentar={carregar} />}

      <div className="grid md:grid-cols-3 gap-3">
        <Passo numero={1} titulo="Extensão instalada" texto="A extensão Copiloto QS chega pela política de empresa do Chrome. Se não aparecer na barra, fale com o gestor." />
        <Passo numero={2} titulo="Gere o código aqui" texto="Um código por closer, válido por 10 minutos. Gerar outro invalida o anterior." />
        <Passo numero={3} titulo="Digite na extensão" texto="Clique no ícone do Copiloto no Chrome, informe o código e pronto. A extensão lembra o pareamento." />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Gerar */}
        <Cartao titulo="Gerar código" sub={podeEscolher ? "Escolha para quem é o código." : `Código para ${currentUser?.name ?? "você"}.`}>
          <div className="px-5 py-4 space-y-4">
            {podeEscolher && (
              <Campo label="Closer">
                <select value={alvoId} onChange={(e) => setAlvoId(e.target.value)} className={CLASSE_INPUT}>
                  {closers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} · {c.role}</option>
                  ))}
                </select>
              </Campo>
            )}
            <Campo label="Apelido do computador" dica="Opcional. Ajuda a saber qual máquina revogar depois.">
              <input value={apelido} onChange={(e) => setApelido(e.target.value)} className={CLASSE_INPUT} placeholder="Ex.: Notebook da Marina" />
            </Campo>
            <Botao onClick={gerar} disabled={gerando || !alvoId}>{gerando ? "Gerando..." : gerado ? "Gerar outro código" : "Gerar código"}</Botao>
          </div>
        </Cartao>

        {/* Código */}
        <Cartao titulo="Código de pareamento" sub={gerado ? `Para ${gerado.user?.name ?? nomeAlvo ?? "closer"}` : "Aparece aqui depois de gerar."}>
          <div className="px-5 py-6 flex flex-col items-center text-center">
            {!gerado ? (
              <p className="text-[13px] text-gray-400 py-6">Nenhum código gerado nesta sessão.</p>
            ) : (
              <>
                <div
                  className="rounded-xl px-6 py-4 font-mono font-bold tabular-nums select-none"
                  style={{
                    fontSize: 44,
                    letterSpacing: "0.35em",
                    color: estadoGerado === "pendente" ? AZUL : "#98A2B3",
                    background: hexComAlpha(AZUL_VIVO, estadoGerado === "pendente" ? 0.06 : 0.02),
                    border: `1px solid ${hexComAlpha(AZUL_VIVO, 0.15)}`,
                    textDecoration: estadoGerado === "pendente" ? "none" : "line-through",
                  }}
                >
                  {gerado.code}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Selo cor={COR_ESTADO[estadoGerado!]} solido={estadoGerado === "pareado"}>{LABEL_ESTADO[estadoGerado!]}</Selo>
                  {estadoGerado === "pendente" && <span className="text-[12px] text-gray-500 tabular-nums">expira em {restanteFmt}</span>}
                </div>
                {estadoGerado === "pendente" && (
                  <p className="text-[12px] text-gray-500 mt-3" style={{ maxWidth: 320 }}>
                    Abra o Meet, clique no ícone do Copiloto e digite o código. Esta tela avisa quando a extensão conectar.
                  </p>
                )}
                {estadoGerado === "pareado" && (
                  <p className="text-[12px] mt-3" style={{ color: "#027A48", maxWidth: 320 }}>
                    Conectado{gerado.device_label ? ` em “${gerado.device_label}”` : ""}. O closer já pode iniciar o Copiloto numa call.
                  </p>
                )}
                {estadoGerado === "expirado" && <p className="text-[12px] text-gray-500 mt-3">Passou dos {PAREAMENTO_VALIDADE_MIN} minutos. Gere outro.</p>}
                <div className="mt-4 flex items-center gap-2">
                  <Botao pequeno variante="secundario" onClick={copiar} disabled={estadoGerado !== "pendente"}>Copiar código</Botao>
                  {estadoGerado !== "revogado" && <Botao pequeno variante="perigo" onClick={() => revogar(gerado)}>Revogar</Botao>}
                </div>
              </>
            )}
          </div>
        </Cartao>
      </div>

      {/* Lista */}
      <section className="space-y-3">
        <TituloSecao sub="Revogar derruba a extensão na hora: o token deixa de valer e ela pede um código novo.">Dispositivos e códigos</TituloSecao>
        <Cartao className="overflow-hidden">
          {pareamentos.length === 0 ? (
            <p className="px-5 py-8 text-[13px] text-gray-500 text-center">Nenhum código gerado ainda.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: "1px solid #F2F4F7" }}>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Closer</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Dispositivo</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Gerado em</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Pareado em</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {pareamentos.map((p) => {
                    const est = estadoDe(p, agora);
                    return (
                      <tr key={p.id} className="hover:bg-gray-50/40 transition-colors" style={{ borderBottom: "1px solid #F2F4F7" }}>
                        <td className="px-4 py-3 font-medium text-gray-900">{p.user?.name ?? "—"}</td>
                        <td className="px-4 py-3 text-gray-600">{p.device_label ?? <span className="text-gray-400">sem apelido</span>}{p.device_id && <span className="block text-[10px] text-gray-400 font-mono truncate" style={{ maxWidth: 180 }}>{p.device_id}</span>}</td>
                        <td className="px-4 py-3"><Selo cor={COR_ESTADO[est]} solido={est === "pareado"}>{LABEL_ESTADO[est]}</Selo></td>
                        <td className="px-4 py-3 text-gray-600 tabular-nums">{fmtDataHora(p.created_at)}</td>
                        <td className="px-4 py-3 text-gray-600 tabular-nums">{fmtDataHora(p.claimed_at)}</td>
                        <td className="px-4 py-3 text-right">
                          {(est === "pareado" || est === "pendente") && (
                            <Botao pequeno variante="perigo" onClick={() => revogar(p)}>Revogar</Botao>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Cartao>
      </section>

      <Toast toast={toast} />
    </Pagina>
  );
}
