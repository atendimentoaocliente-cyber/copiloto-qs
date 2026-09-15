/**
 * Sessões de call — memória e persistência.
 *
 * Cada call vira um arquivo JSON em dados/. É o que permite:
 *   - gerar o resumo pós-call
 *   - construir o catálogo real de objeções do time
 *   - revisar a call depois com o closer
 *
 * Quando o módulo for para o QS, isso vira tabela `qs_copilot_calls`
 * no Supabase. O formato aqui já é o mesmo da tabela, de propósito.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "dados");
mkdirSync(RAIZ, { recursive: true });

// Preço por minuto de streaming do Deepgram (nova-3), em USD
const USD_POR_MIN_STT = 0.0092;
const DOLAR = Number(process.env.DOLAR ?? 5.4);

export class Sessao {
  constructor({ leadNome = null, closerNome = null } = {}) {
    this.id = randomUUID();
    this.iniciadaEm = new Date().toISOString();
    this.encerradaEm = null;
    this.leadNome = leadNome;
    this.closerNome = closerNome;
    this.turnos = [];        // { falante, texto, emMs }
    this.deteccoes = [];     // { categoria, resposta, fonte, emMs, latenciaMs }
    this.pacotes = 0;
    this.resumo = null;
    this.custo = { sttUsd: 0, iaUsd: 0, totalBrl: 0 };
    this._t0 = Date.now();
  }

  get duracaoMs() {
    return (this.encerradaEm ? Date.parse(this.encerradaEm) : Date.now()) - this._t0;
  }

  get duracaoMin() {
    return this.duracaoMs / 60000;
  }

  registrarTurno(falante, texto) {
    this.turnos.push({ falante, texto, emMs: Date.now() - this._t0 });
  }

  registrarDeteccao(d) {
    this.deteccoes.push({ ...d, emMs: Date.now() - this._t0 });
  }

  somarCustoIa(usd) {
    this.custo.iaUsd += usd;
  }

  /** Contexto para a IA: últimos N turnos, já formatados */
  contexto(n = 10) {
    return this.turnos
      .slice(-n)
      .map((t) => `${t.falante === "lead" ? "LEAD" : "CLOSER"}: ${t.texto}`);
  }

  /** Transcrição inteira, para o resumo */
  transcricaoCompleta() {
    return this.turnos
      .map((t) => `${t.falante === "lead" ? "LEAD" : "CLOSER"}: ${t.texto}`)
      .join("\n");
  }

  encerrar() {
    this.encerradaEm = new Date().toISOString();
    this.custo.sttUsd = this.duracaoMin * USD_POR_MIN_STT;
    this.custo.totalBrl = (this.custo.sttUsd + this.custo.iaUsd) * DOLAR;
  }

  salvar() {
    const arquivo = join(RAIZ, `${this.id}.json`);
    writeFileSync(arquivo, JSON.stringify(this.paraJson(), null, 2));
    return arquivo;
  }

  paraJson() {
    return {
      id: this.id,
      iniciadaEm: this.iniciadaEm,
      encerradaEm: this.encerradaEm,
      duracaoMs: this.duracaoMs,
      leadNome: this.leadNome,
      closerNome: this.closerNome,
      totalTurnos: this.turnos.length,
      turnosLead: this.turnos.filter((t) => t.falante === "lead").length,
      turnosCloser: this.turnos.filter((t) => t.falante === "closer").length,
      deteccoes: this.deteccoes,
      resumo: this.resumo,
      custo: this.custo,
      turnos: this.turnos,
    };
  }
}

export function listarCalls() {
  if (!existsSync(RAIZ)) return [];
  return readdirSync(RAIZ)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const d = JSON.parse(readFileSync(join(RAIZ, f), "utf8"));
        return {
          id: d.id,
          iniciadaEm: d.iniciadaEm,
          duracaoMs: d.duracaoMs,
          totalTurnos: d.totalTurnos,
          objecoes: (d.deteccoes ?? []).length,
          custoBrl: d.custo?.totalBrl ?? 0,
          resumo: d.resumo,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.iniciadaEm.localeCompare(a.iniciadaEm));
}

export function lerCall(id) {
  const arquivo = join(RAIZ, `${id}.json`);
  if (!existsSync(arquivo)) return null;
  return JSON.parse(readFileSync(arquivo, "utf8"));
}
