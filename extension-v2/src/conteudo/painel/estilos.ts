/**
 * Folha de estilo do painel — a spec de UX (06-UX-OVERLAY-ux.md) virou CSS.
 *
 * Leis que este arquivo implementa:
 *   L1 posição fixa  → zonas com altura travada (44/76/112/60/48/112/68 = 520)
 *   L2 sem movimento → só `opacity` e `background-color` transicionam
 *   L3 uma fixação   → frase 22px/30px, máx 2 linhas, text-wrap: balance
 *
 * Tema claro obrigatório (halation em olho cansado). Vermelho só no alerta
 * de tela exposta — que é segurança, não estado de venda.
 *
 * Fontes de marca (Criteria CF / BDO Grotesk) entram pelo sistema quando
 * instaladas; senão cai em Inter/system-ui sem quebrar a métrica.
 */

export const LARGURA = 380;
export const ALTURA = 520;

export const ESTILO = /* css */ `
  #copiloto-qs, #copiloto-qs * { box-sizing: border-box; margin: 0; padding: 0; }

  #copiloto-qs {
    --marinho: #0D1B4B;
    --azul: #1A55FF;
    --azul-claro: #9DB6FF;
    --ambar: #C2410C;
    --cinza-escuro: #3D4766;
    --cinza-medio: #5B6478;
    --cinza-rail: #E3E7F0;
    --cinza-borda: #DDE2EC;
    --cinza-esqueleto: #EEF1F7;
    --vermelho-seguranca: #B42318;
    --fonte-frase: "Criteria CF", "BDO Grotesk", Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    --fonte-ui: "BDO Grotesk", Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    --tam-frase: 22px;
    --alt-frase: 30px;
    --dur-entrada: 280ms;
    --dur-fantasma: 600ms;
    --dur-rail: 400ms;

    position: fixed; top: 16px; right: 16px;
    width: ${LARGURA}px; height: ${ALTURA}px;
    z-index: 2147483647;
    display: flex; flex-direction: row;
    background: #FFFFFF; color: var(--marinho);
    border-radius: 12px; overflow: hidden;
    box-shadow: 0 12px 40px rgba(13, 27, 75, .28), 0 0 0 1px rgba(13, 27, 75, .06);
    font: 14px/1.4 var(--fonte-ui);
    -webkit-font-smoothing: antialiased;
  }
  #copiloto-qs.fonte-grande { --tam-frase: 26px; --alt-frase: 34px; }
  #copiloto-qs.sem-transicoes, #copiloto-qs.sem-transicoes * { transition: none !important; }
  @media (prefers-reduced-motion: reduce) {
    #copiloto-qs, #copiloto-qs * { transition: none !important; }
  }

  /* ── Rail de estado — único elemento legível em periferia real ── */
  #copiloto-qs .cq-rail {
    flex: 0 0 4px; width: 4px;
    background: var(--cinza-rail);
    transition: background-color var(--dur-rail) ease-out;
  }
  #copiloto-qs[data-estado="escutando"] .cq-rail { background: var(--azul-claro); }
  #copiloto-qs[data-estado="escutando"].closer-falando .cq-rail { background: var(--cinza-rail); }
  #copiloto-qs[data-estado="detectando"] .cq-rail { background: var(--azul); }
  #copiloto-qs[data-estado="sugerindo"] .cq-rail { background: var(--azul); }
  #copiloto-qs[data-estado="sugerindo"][data-nivel="atencao"] .cq-rail { flex-basis: 8px; width: 8px; background: var(--ambar); }
  #copiloto-qs[data-estado="sugerindo"].fantasma .cq-rail { background: var(--azul-claro); flex-basis: 4px; width: 4px; }
  #copiloto-qs[data-estado="reconectando"] .cq-rail,
  #copiloto-qs[data-estado="erro"] .cq-rail,
  #copiloto-qs[data-estado="degradado"] .cq-rail { background: var(--cinza-escuro); }

  #copiloto-qs .cq-corpo { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }

  /* ── A. Barra de estado (44px) ── */
  #copiloto-qs .cq-a {
    height: 44px; flex: 0 0 44px;
    display: flex; align-items: center; gap: 8px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--cinza-borda);
    cursor: move; user-select: none;
  }
  #copiloto-qs .cq-glifo { width: 12px; text-align: center; font-size: 12px; color: var(--cinza-escuro); }
  #copiloto-qs .cq-titulo {
    flex: 1; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
    color: var(--marinho); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #copiloto-qs .cq-tempo { font-size: 12px; color: var(--cinza-escuro); font-variant-numeric: tabular-nums; }
  #copiloto-qs .cq-a button {
    width: 28px; height: 28px; border: none; border-radius: 6px;
    background: transparent; color: var(--cinza-escuro); cursor: pointer; font-size: 14px;
    transition: background-color 120ms ease;
  }
  #copiloto-qs .cq-a button:hover { background: var(--cinza-esqueleto); }
  #copiloto-qs .cq-selo-tela {
    display: none; padding: 2px 6px; border-radius: 4px;
    background: var(--vermelho-seguranca); color: #fff;
    font-size: 10px; font-weight: 700; letter-spacing: .06em;
  }
  #copiloto-qs.exposto .cq-selo-tela { display: inline-block; }

  /* ── Linha de aviso (não-vermelha; erro de sistema, mic, etc.) ── */
  #copiloto-qs .cq-aviso {
    display: none; padding: 6px 12px; font-size: 12px; line-height: 16px;
    color: var(--cinza-escuro); background: var(--cinza-esqueleto);
    border-bottom: 1px solid var(--cinza-borda);
  }
  #copiloto-qs .cq-aviso.on { display: block; }

  /* ── Telas pré-call (ocupam o lugar da grade) ── */
  #copiloto-qs .cq-tela { flex: 1; overflow-y: auto; padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
  #copiloto-qs .cq-tela h2 { font: 600 var(--tam-frase)/var(--alt-frase) var(--fonte-frase); color: var(--marinho); text-wrap: balance; }
  #copiloto-qs .cq-tela p { font-size: 14px; line-height: 20px; color: var(--cinza-escuro); }
  #copiloto-qs .cq-tela .cq-rotulo { margin-top: 4px; }
  #copiloto-qs .cq-lista { display: flex; flex-direction: column; gap: 6px; }
  #copiloto-qs .cq-item {
    text-align: left; width: 100%; padding: 10px 12px;
    border: 1px solid var(--cinza-borda); border-radius: 8px; background: #fff;
    cursor: pointer; color: var(--marinho); font: inherit;
    transition: background-color 120ms ease;
  }
  #copiloto-qs .cq-item:hover { background: var(--cinza-esqueleto); }
  #copiloto-qs .cq-item b { display: block; font-size: 15px; font-weight: 600; }
  #copiloto-qs .cq-item span { display: block; font-size: 12px; color: var(--cinza-escuro); margin-top: 2px; }
  #copiloto-qs .cq-citacao {
    padding: 14px 16px; border-left: 4px solid var(--azul); background: var(--cinza-esqueleto);
    border-radius: 0 8px 8px 0;
    font: 500 17px/25px var(--fonte-frase); color: var(--marinho);
  }
  #copiloto-qs .cq-bloco { display: flex; flex-direction: column; gap: 3px; }
  #copiloto-qs .cq-bloco p { font-size: 13px; line-height: 18px; color: var(--marinho); }
  #copiloto-qs .cq-bloco p.fraca { color: var(--cinza-medio); }
  #copiloto-qs .cq-bloco ul { padding-left: 16px; }
  #copiloto-qs .cq-bloco li { font-size: 13px; line-height: 18px; color: var(--marinho); }
  #copiloto-qs .cq-acoes-tela { display: flex; gap: 8px; margin-top: auto; padding-top: 8px; }

  /* ── Botões ── */
  #copiloto-qs .cq-btn {
    height: 40px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--cinza-borda);
    background: #fff; color: var(--cinza-escuro); font: 600 13px var(--fonte-ui); cursor: pointer;
    transition: background-color 120ms ease; white-space: nowrap;
  }
  #copiloto-qs .cq-btn:hover { background: var(--cinza-esqueleto); }
  #copiloto-qs .cq-btn.primario { background: var(--marinho); color: #fff; border-color: var(--marinho); flex: 1; }
  #copiloto-qs .cq-btn.primario:hover { background: #16276A; }
  #copiloto-qs .cq-btn.primario.flash { background: var(--azul); }
  #copiloto-qs .cq-btn:disabled { opacity: .4; cursor: default; }

  /* ── Grade ao vivo — alturas TRAVADAS ── */
  #copiloto-qs .cq-grade { flex: 1; display: flex; flex-direction: column; }
  #copiloto-qs .cq-b { height: 76px; flex: 0 0 76px; padding: 10px 16px 0; overflow: hidden; }
  #copiloto-qs .cq-c { height: 112px; flex: 0 0 112px; padding: 0 16px; display: flex; align-items: center;
    border-top: 1px solid var(--cinza-borda); border-bottom: 1px solid var(--cinza-borda); }
  #copiloto-qs .cq-d { height: 60px; flex: 0 0 60px; padding: 10px 16px 0; overflow: hidden; }
  #copiloto-qs .cq-e { height: 48px; flex: 0 0 48px; padding: 0 16px; display: flex; align-items: center; overflow: hidden;
    border-top: 1px solid var(--cinza-borda); }
  #copiloto-qs .cq-f { height: 112px; flex: 0 0 112px; padding: 10px 16px 0; overflow: hidden;
    border-top: 1px solid var(--cinza-borda); }
  #copiloto-qs .cq-g { height: 68px; flex: 0 0 68px; padding: 14px 16px; display: flex; gap: 8px; align-items: center;
    border-top: 1px solid var(--cinza-borda); }
  #copiloto-qs.modo-minimo .cq-d,
  #copiloto-qs.modo-minimo .cq-e,
  #copiloto-qs.modo-minimo .cq-f { visibility: hidden; }

  #copiloto-qs .cq-rotulo {
    display: block; font-size: 10px; font-weight: 600; letter-spacing: .08em;
    text-transform: uppercase; color: var(--cinza-escuro);
  }
  #copiloto-qs .cq-chip {
    display: inline-block; max-width: 100%; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; line-height: 14px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
    border: 1px solid var(--azul); color: var(--marinho); background: #fff;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top;
  }
  #copiloto-qs[data-nivel="atencao"] .cq-chip { background: var(--ambar); border-color: var(--ambar); color: #fff; }
  #copiloto-qs .cq-eco {
    display: block; margin-top: 6px; font-size: 13px; line-height: 18px; font-style: italic;
    color: var(--cinza-escuro); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #copiloto-qs .cq-contexto { font-size: 13px; line-height: 18px; color: var(--marinho); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #copiloto-qs .cq-contexto.fraca { color: var(--cinza-escuro); }

  #copiloto-qs .cq-frase {
    width: 100%;
    font: 600 var(--tam-frase)/var(--alt-frase) var(--fonte-frase);
    color: var(--marinho);
    text-wrap: balance; hyphens: none; overflow-wrap: normal;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    opacity: 1;
    transition: opacity var(--dur-entrada) cubic-bezier(.2,.8,.2,1);
  }
  #copiloto-qs .cq-frase.entrando { opacity: 0; }
  #copiloto-qs .cq-frase.sistema { font-weight: 500; color: var(--cinza-escuro); }
  #copiloto-qs .cq-esqueleto { display: none; width: 100%; flex-direction: column; gap: 10px; }
  #copiloto-qs .cq-esqueleto i { display: block; height: 18px; border-radius: 4px; background: var(--cinza-esqueleto); }
  #copiloto-qs .cq-esqueleto i:first-child { width: 88%; }
  #copiloto-qs .cq-esqueleto i:last-child { width: 56%; }
  #copiloto-qs[data-estado="detectando"] .cq-esqueleto { display: flex; }
  #copiloto-qs[data-estado="detectando"] .cq-frase { display: none; }

  #copiloto-qs .cq-ancora { display: block; margin-top: 3px; font-size: 15px; line-height: 20px; font-weight: 500; color: var(--marinho);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #copiloto-qs .cq-alt { font-size: 14px; line-height: 19px; color: var(--cinza-escuro); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #copiloto-qs .cq-alt b { font-weight: 600; color: var(--cinza-medio); margin-right: 6px; }
  #copiloto-qs .cq-fila { list-style: none; margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
  #copiloto-qs .cq-fila li { display: flex; gap: 8px; font-size: 12px; line-height: 16px; color: var(--cinza-medio);
    white-space: nowrap; overflow: hidden; }
  #copiloto-qs .cq-fila li span:first-child { font-variant-numeric: tabular-nums; }
  #copiloto-qs .cq-fila li span:nth-child(2) { flex: 1; overflow: hidden; text-overflow: ellipsis; }

  /* Fantasma: o card inteiro a 45%, rampa lenta (abaixo do limiar do detector de transientes) */
  #copiloto-qs .cq-b, #copiloto-qs .cq-c, #copiloto-qs .cq-d, #copiloto-qs .cq-e {
    transition: opacity var(--dur-fantasma) linear;
  }
  #copiloto-qs.fantasma .cq-b, #copiloto-qs.fantasma .cq-c,
  #copiloto-qs.fantasma .cq-d, #copiloto-qs.fantasma .cq-e { opacity: .45; }

  /* ── Alerta de tela exposta — segurança, único vermelho permitido ── */
  #copiloto-qs .cq-alerta-tela {
    display: none; position: absolute; left: 0; right: 0; top: 44px; z-index: 2;
    padding: 12px 16px 14px; background: var(--vermelho-seguranca); color: #fff;
  }
  #copiloto-qs.exposto .cq-alerta-tela { display: block; }
  #copiloto-qs .cq-alerta-tela b { display: block; font-size: 13px; font-weight: 700; letter-spacing: .04em; }
  #copiloto-qs .cq-alerta-tela p { font-size: 12px; line-height: 17px; margin-top: 4px; opacity: .95; }
  #copiloto-qs .cq-alerta-tela .cq-acoes-tela { margin-top: 10px; padding-top: 0; }
  #copiloto-qs .cq-alerta-tela .cq-btn { height: 34px; padding: 0 12px; background: #fff; color: var(--vermelho-seguranca); border-color: #fff; }
  #copiloto-qs .cq-alerta-tela .cq-btn.secundario { background: transparent; color: #fff; border-color: rgba(255,255,255,.6); }
  #copiloto-qs.exposto .cq-grade, #copiloto-qs.exposto .cq-tela { filter: blur(9px); opacity: .18; pointer-events: none; user-select: none; }
  #copiloto-qs.exposto.mostrar-mesmo-assim .cq-grade, #copiloto-qs.exposto.mostrar-mesmo-assim .cq-tela { filter: none; opacity: 1; pointer-events: auto; }
  #copiloto-qs.exposto.mostrar-mesmo-assim .cq-alerta-tela { display: none; }

  [hidden] { display: none !important; }
`;

/** Ajustes quando o painel vive na janela Document PiP. */
export const ESTILO_PIP = /* css */ `
  html, body { margin: 0; background: #fff; height: 100%; }
  #copiloto-qs { position: static; width: 100%; height: 100vh; border-radius: 0; box-shadow: none; }
  #copiloto-qs .cq-a { cursor: default; }
`;
