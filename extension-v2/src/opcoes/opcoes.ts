/**
 * Página de opções — pareamento, microfone, atalhos e preferências.
 *
 * O pareamento é a única forma de a extensão obter credencial: o closer
 * gera um código de 6 dígitos no QS, cola aqui, e a extensão troca por um
 * JWT do gateway guardado em chrome.storage.local. Nenhuma chave do
 * Supabase existe neste pacote.
 */

import { armazenamento } from "@/compartilhado/armazenamento";
import { GATEWAY_PADRAO, VERSAO_EXTENSAO } from "@/compartilhado/config";
import { ErroGateway, gateway, impressaoDoDispositivo } from "@/compartilhado/gateway";
import { diasRestantes } from "@/compartilhado/jwt";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── Versão, atalhos ─────────────────────────────────────────────────────────

$("versao").textContent = `v${VERSAO_EXTENSAO}`;
$("gateway-padrao").textContent = GATEWAY_PADRAO;

const mac = navigator.platform.includes("Mac");
const mod = mac ? "⌘" : "Ctrl";
$("atalho-ativar").textContent = `${mod} + Shift + K`;
$("atalho-usei").textContent = `${mod} + Shift + U`;
$("atalho-nao-serviu").textContent = `${mod} + Shift + J`;
$("atalho-silenciar").textContent = `${mod} + Shift + M`;

// Se o Chrome não conseguiu registrar algum atalho (conflito), mostra o real.
chrome.commands.getAll().then((comandos) => {
  const mapa: Record<string, string> = {
    _execute_action: "atalho-ativar",
    "marcar-usei": "atalho-usei",
    "marcar-nao-serviu": "atalho-nao-serviu",
    silenciar: "atalho-silenciar",
  };
  for (const c of comandos) {
    const id = c.name ? mapa[c.name] : undefined;
    if (!id) continue;
    $(id).textContent = c.shortcut || "não definido — configure em chrome://extensions/shortcuts";
  }
}).catch(() => {});

// ── Pareamento ──────────────────────────────────────────────────────────────

async function mostrarEstadoPareamento(): Promise<void> {
  const cred = await armazenamento.lerCredencial();
  const pareado = $("pareado");
  const naoPareado = $("nao-pareado");
  if (!cred) {
    pareado.hidden = true;
    naoPareado.hidden = false;
    return;
  }
  pareado.hidden = false;
  naoPareado.hidden = true;
  $("nome-usuario").textContent = cred.usuario.nome;
  $("papel-usuario").textContent = cred.usuario.papel;
  $("pareado-em").textContent = new Date(cred.pareadoEm).toLocaleString("pt-BR");
  $("dias-restantes").textContent = String(Math.max(0, Math.floor(diasRestantes(cred.token))));
}

$("form-pareamento").addEventListener("submit", async (e) => {
  e.preventDefault();
  const entrada = $<HTMLInputElement>("codigo");
  const botao = $<HTMLButtonElement>("parear");
  const resultado = $("resultado-pareamento");
  const codigo = entrada.value.replace(/\D/g, "");
  if (codigo.length !== 6) {
    resultado.textContent = "O código tem 6 dígitos.";
    resultado.className = "resultado erro";
    return;
  }
  botao.disabled = true;
  resultado.textContent = "Pareando…";
  resultado.className = "resultado";
  try {
    const url = await armazenamento.lerGateway();
    const rotulo = `Chrome · ${mac ? "macOS" : navigator.platform}`;
    const cred = await gateway.parear(url, codigo, rotulo, await impressaoDoDispositivo());
    await armazenamento.gravarCredencial(cred);
    resultado.textContent = `Pareado como ${cred.usuario.nome}.`;
    resultado.className = "resultado ok";
    entrada.value = "";
    await mostrarEstadoPareamento();
  } catch (err) {
    resultado.textContent = err instanceof ErroGateway ? err.message : "Falha inesperada ao parear.";
    resultado.className = "resultado erro";
  } finally {
    botao.disabled = false;
  }
});

$("desparear").addEventListener("click", async () => {
  if (!confirm("Desconectar este Chrome do QS? Você vai precisar de um novo código para usar o copiloto.")) return;
  await armazenamento.apagarCredencial();
  await mostrarEstadoPareamento();
});

// ── Microfone ───────────────────────────────────────────────────────────────

async function verificarMicrofone(): Promise<void> {
  const estado = $("estado-microfone");
  try {
    const p = await navigator.permissions.query({ name: "microphone" as PermissionName });
    if (p.state === "granted") { estado.textContent = "Microfone liberado."; estado.className = "resultado ok"; }
    else if (p.state === "denied") { estado.textContent = "Bloqueado — clique no cadeado da barra de endereço para liberar."; estado.className = "resultado erro"; }
    else { estado.textContent = ""; estado.className = "resultado"; }
  } catch {
    /* Permissions API pode não suportar "microphone" */
  }
}

$("pedir-microfone").addEventListener("click", async () => {
  const estado = $("estado-microfone");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    estado.textContent = "Microfone liberado. Pode fechar esta aba.";
    estado.className = "resultado ok";
  } catch (err) {
    estado.textContent = `Não autorizado (${(err as Error).name}). Verifique o cadeado na barra de endereço.`;
    estado.className = "resultado erro";
  }
});

// ── Preferências ────────────────────────────────────────────────────────────

async function carregarPreferencias(): Promise<void> {
  const p = await armazenamento.lerPreferencias();
  $<HTMLInputElement>("pref-fonte-grande").checked = p.fonteGrande;
  $<HTMLInputElement>("pref-modo-minimo").checked = p.modoMinimo;
  $<HTMLInputElement>("pref-sem-transicoes").checked = p.semTransicoes;
}

$("pref-fonte-grande").addEventListener("change", (e) =>
  armazenamento.gravarPreferencias({ fonteGrande: (e.target as HTMLInputElement).checked }));
$("pref-modo-minimo").addEventListener("change", (e) =>
  armazenamento.gravarPreferencias({ modoMinimo: (e.target as HTMLInputElement).checked }));
$("pref-sem-transicoes").addEventListener("change", (e) =>
  armazenamento.gravarPreferencias({ semTransicoes: (e.target as HTMLInputElement).checked }));

// ── Gateway (avançado) ──────────────────────────────────────────────────────

async function carregarGateway(): Promise<void> {
  const url = await armazenamento.lerGateway();
  $<HTMLInputElement>("gateway").value = url === GATEWAY_PADRAO ? "" : url;
}

$("form-gateway").addEventListener("submit", async (e) => {
  e.preventDefault();
  const valor = $<HTMLInputElement>("gateway").value.trim();
  await armazenamento.gravarGateway(valor || GATEWAY_PADRAO);
  const r = $("resultado-gateway");
  r.textContent = "Salvo.";
  r.className = "resultado ok";
});

$("testar-gateway").addEventListener("click", async () => {
  const r = $("resultado-gateway");
  const url = $<HTMLInputElement>("gateway").value.trim() || GATEWAY_PADRAO;
  r.textContent = "Testando…";
  r.className = "resultado";
  const ok = await gateway.saude(url);
  r.textContent = ok ? `Gateway respondeu em ${url}.` : `Sem resposta de ${url}.`;
  r.className = ok ? "resultado ok" : "resultado erro";
});

// ── Início ──────────────────────────────────────────────────────────────────

void mostrarEstadoPareamento();
void verificarMicrofone();
void carregarPreferencias();
void carregarGateway();
