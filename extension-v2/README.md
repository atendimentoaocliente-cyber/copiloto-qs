# Copiloto QS — Extensão Chrome (v2, produção)

Copiloto de vendas em tempo real para as calls de fechamento do Grupo
Inovvatur. Escuta os dois lados da call (lead = aba, closer = microfone),
manda PCM 16 kHz para o gateway e mostra ao closer **uma frase por vez** —
invisível para o lead.

Esta é a evolução de produção do protótipo validado em
`../extension/` (JS puro). Tudo que foi descoberto lá em call real está
preservado aqui — ver a seção *O que mudou*.

```
Chrome (closer)                                     Gateway (Frente B)
┌──────────────────────────────────────┐            ┌───────────────────┐
│ service worker  ── activeTab/badge   │ REST+JWT   │ /v1/dispositivos  │
│ offscreen       ── áudio + WS        │◄──────────►│ /v1/reunioes      │
│ content script  ── painel na página  │ WS binário │ /v1/consentimentos│
│ vigia (MAIN)    ── getDisplayMedia   │            │ /v1/stream        │
│ opções          ── pairing + mic     │            └───────────────────┘
└──────────────────────────────────────┘
```

---

## Instalação (desenvolvimento)

Pré-requisitos: Node 20.19+ (ou 22.12+), Chrome 116+.

```bash
cd ~/Documents/qs-copilot-spike/extension-v2
npm install
npm run build            # gera dist/
```

1. `chrome://extensions` → **Modo do desenvolvedor** → **Carregar sem compactação** → pasta `dist/`.
2. A página de opções abre sozinha na primeira instalação. Nela:
   - **Parear**: gere o código de 6 dígitos no QS (Configurações → Copiloto) e cole.
   - **Autorizar microfone** (uma vez).
   - Em *Avançado*, para apontar ao gateway local: `http://localhost:8787` (no build de dev isso já é o padrão).
3. Fixe o ícone na barra. É o clique nele (ou `⌘⇧K`) que ativa o copiloto.

Para distribuir aos closers por política de empresa: **[empacotar.md](./empacotar.md)**.

### Desenvolvimento com recarga

```bash
npm run dev
```

O `@crxjs/vite-plugin` sobe um servidor Vite e recompila service worker,
offscreen e content scripts a cada salvamento. Carregue a pasta `dist/`
uma vez; o plugin recarrega a extensão sozinho. A janela PiP e o offscreen
não recarregam a quente — pare e ative de novo.

```bash
npm run typecheck        # só tsc
npm run icones           # regenera os PNGs de public/icones (placeholder)
```

---

## Fluxo de uso (o que o closer vê)

1. **Entra na call** (Meet, Zoom web ou Teams web). Aparece um lembrete com o atalho.
2. **Clica no ícone / `⌘⇧K`.** O painel nasce no canto da página.
3. **Escolhe o lead** entre as reuniões de hoje do QS. Sem lead, não há sessão.
4. **Lê o texto de consentimento em voz alta.** Confirma → o timestamp vira
   prova (`POST /v1/consentimentos`) **antes** de qualquer captura. Se o
   lead recusar → tudo é descartado, painel fecha, nada foi enviado.
5. **Briefing pré-call**: o que o SDR levantou no handover, histórico,
   produto de interesse, últimas calls. Botão **▶ Iniciar escuta**.
6. **Ao vivo.** Zona C (Y fixo 120–232) recebe uma frase por objeção
   detectada. Botões **✓ Usei** / **Não serviu** alimentam o playbook.
   Timer em minutos. Fila "já tratadas". Teto de 6 cards por call.
7. **Clica no ícone de novo / ✕** → encerra; o gateway recebe `encerrar` e
   fecha o stream do Deepgram sem perder as últimas falas.

O botão **ⓘ** reabre o briefing durante a call; **⧉** destaca o painel em
janela flutuante (Document PiP).

### Estados do painel

| Estado | Rail | O que o closer lê |
|---|---|---|
| ocioso | cinza 4px | "Ligando a escuta." |
| escutando | azul-claro 4px | zona C vazia (por design) |
| detectando | azul 4px | chip + esqueleto estático, ≤ 1,2 s |
| sugerindo · sugestão | azul 4px | a frase |
| sugerindo · atenção | âmbar **8px**, chip preenchido | a frase (mesma cor de texto) |
| fantasma | azul-claro | card a 45% após 20 s ou "usei" |
| reconectando | cinza-escuro | "Voltando em instantes." + "Tentativa N de 5" + segundos na fila |
| degradado | cinza-escuro | "Segue a call normalmente." + motivo |
| erro | cinza-escuro | "Segue a call normalmente." + Tentar de novo |
| **tela exposta** | — | faixa **vermelha**, conteúdo borrado, botões *Destacar* / *Estou em outro monitor* |

Vermelho só existe no alerta de tela — é segurança, não estado de venda.

### Atalhos

| Global (chrome.commands) | No painel em foco | Ação |
|---|---|---|
| `⌘⇧K` / `Ctrl⇧K` | — | ativar / parar |
| `⌘⇧U` | `Ctrl+↵` | usei |
| `⌘⇧J` | `Ctrl+⌫` | não serviu |
| `⌘⇧M` | `Ctrl+Espaço` | silenciar 5 min |

Badge no ícone: `!` numa call · `…` pré-call · `●` escutando · `◐` instável · `▲` erro · `TELA` exposto · `?` não pareado.

---

## Estrutura

```
extension-v2/
├── manifest.json                  MV3 — aponta para os .ts; o crxjs reescreve
├── vite.config.ts · tsconfig.json · package.json
├── public/
│   ├── pcm-worklet.js             AudioWorklet (igual ao protótipo) — arquivo separado, web_accessible
│   └── icones/                    PNGs gerados por scripts/gerar-icones.mjs
├── scripts/
│   ├── gerar-icones.mjs
│   └── empacotar.mjs              zip de dist/ para release/
├── src/
│   ├── compartilhado/
│   │   ├── config.ts              URLs, texto de consentimento, limites de UX e resiliência
│   │   ├── tipos.ts               Usuario, Reuniao, Briefing, Sugestao, Sessao…
│   │   ├── mensagens.ts           contratos content ↔ background ↔ offscreen (tipados)
│   │   ├── protocolo.ts           contrato WS com o gateway (JSON + frame binário de 8 bytes)
│   │   ├── gateway.ts             cliente REST (parear, reuniões, briefing, consentimento, feedback)
│   │   ├── armazenamento.ts       chrome.storage.local (credencial, prefs) e .session (sessão)
│   │   ├── jwt.ts                 leitura de exp para renovação
│   │   └── globais.d.ts           Document PiP, chromeMediaSource
│   ├── background/
│   │   ├── service-worker.ts      orquestração, activeTab, roteamento, feedback, badge
│   │   ├── sessao.ts              máquina de estados persistida
│   │   └── badge.ts
│   ├── offscreen/
│   │   ├── offscreen.html/.ts     entrada
│   │   ├── grafo-audio.ts         2 fontes → 2 canais → worklet · LOOPBACK obrigatório
│   │   ├── cliente-ws.ts          reconexão, fila, heartbeat, watchdog, retomada
│   │   └── fila-audio.ts          ring buffer de 30 s
│   ├── conteudo/
│   │   ├── content.ts             bootstrap + roteamento de mensagens
│   │   ├── vigia-tela.ts          função autocontida injetada em world MAIN
│   │   ├── lembrete.ts            content script estático nos hosts de reunião
│   │   └── painel/
│   │       ├── estilos.ts         a spec de UX em CSS (grade travada, só opacity/bg-color)
│   │       ├── painel.ts          DOM, arraste, PiP, alerta de tela
│   │       ├── telas.ts           reuniões · consentimento · briefing · erro
│   │       ├── ao-vivo.ts         máquina de estados do card
│   │       └── util.ts
│   └── opcoes/                    pairing, microfone, atalhos, preferências, gateway
├── empacotar.md                   distribuição por CBCM + CRX self-hosted
└── README.md
```

---

## Contrato com o gateway (Frente B)

A extensão **nunca** fala com o Supabase. Só conhece o gateway.

### REST (`Authorization: Bearer <JWT>`)

| Método | Rota | Corpo / resposta |
|---|---|---|
| POST | `/v1/dispositivos/parear` | `{ codigo, rotulo, impressao }` → `{ token, expiraEm, dispositivoId, usuario:{id,nome,papel} }` |
| POST | `/v1/dispositivos/renovar` | → `{ token, expiraEm }` (chamado quando faltam < 5 dias) |
| GET | `/v1/reunioes?dia=hoje` | → `Reuniao[]` do closer autenticado |
| GET | `/v1/leads/:leadId/briefing?reuniaoId=` | → `Briefing` |
| POST | `/v1/consentimentos` | `{ reuniaoId, leadId, confirmadoEm, textoVersao }` → `{ id }` |
| POST | `/v1/sugestoes/:id/feedback` | `{ sessaoId, valor: "usei"\|"nao_serviu"\|"ignorou", em }` → 204 |
| GET | `/health` | usado pelo botão *Testar* das opções |

Erros: `{ error: "codigo_invalido_ou_expirado" | "usuario_inativo" | ... }` — mapeados para texto humano em `gateway.ts`.

### WebSocket `GET /v1/stream?token=<JWT>` (subprotocolo `qscopilot.v1`)

Primeira mensagem obrigatória: `sessao.iniciar` (com `sessaoId`, `reuniaoId`, `leadId`, `consentimentoId`). Fechamentos tratados: `4401` credencial, `4404` sessão, `4408` teto de duração.

Frames binários = cabeçalho de 8 bytes (`versao`, `flags`, `seq` LE) + PCM s16le 16 kHz **2 canais intercalados** (0 = lead, 1 = closer). Flag `reenviado` marca áudio drenado da fila após queda: transcrever, não sugerir.

Mensagens do gateway que o painel entende: `pronto`, `sessao.retomada`, `pong`, `transcricao`, `sugestao` (com `pendente`, `nivel`, `ancora`, `alternativa`, `eco`, `geradoEm`), `sugestao.retirar`, `degradado`, `recuperado`, `reconectando`, `erro`. Tudo tipado em `src/compartilhado/protocolo.ts`.

> O servidor do protótipo (`../server`) ainda fala o protocolo antigo (`config`/`transcricao`/`sugestao` sem sessão). Para testar a v2 ponta a ponta é preciso o gateway da Frente B — ou adaptar `../server/src/index.js` para aceitar `sessao.iniciar`, o cabeçalho de 8 bytes e as rotas REST acima.

---

## O que mudou em relação ao protótipo

| Protótipo (`../extension`) | v2 (`extension-v2`) |
|---|---|
| JS puro, sem build | TypeScript estrito + Vite + `@crxjs/vite-plugin`; contratos de mensagens e protocolo tipados |
| Clique no ícone → captura imediata | Clique → pareamento verificado → **lead** → **consentimento** → **briefing** → captura. `getMediaStreamId` só na hora do "Iniciar escuta"; se o `activeTab` expirou, o painel pede um novo clique sem refazer o fluxo |
| Sem autenticação; servidor fixo | JWT via pairing code de 6 dígitos, em `chrome.storage.local`; renovação automática; URL do gateway configurável |
| Sessão anônima | Sessão vinculada a `reuniaoId` + `leadId` + `consentimentoId`; `sessaoId` UUID gerado no cliente; estado persistido em `chrome.storage.session` (sobrevive à morte do service worker) |
| Painel escuro com transcrição rolando | Painel claro 380×520 com **grade de altura travada** (spec de UX); **uma frase**, sem transcrição visível, timer em minutos, sem spinner, só `opacity`/`background-color` animam |
| 5 estados soltos | 7 estados + fantasma + closer-falando + pausado/silenciado; cooldown 8 s, teto 6 cards, descarte de card tardio (> 2,5 s), esqueleto estático ≤ 1,2 s |
| — | Feedback **usei / não serviu / ignorou** por WS e REST (com fila offline) |
| Vigia borra o painel | Vigia + faixa vermelha fixa + selo `TELA` no cabeçalho + badge vermelho no ícone + botões *Destacar em janela* e *Estou em outro monitor* |
| Reconexão simples (8 tentativas, sem fila) | Recuo 500 ms → 10 s com jitter, **fila de 30 s** reenviada com flag, heartbeat 5 s, **watchdog** para Wi-Fi que cai sem FIN, `sessao.retomar`, estado **degradado** quando o gateway fica mudo 45 s. Nunca "ativo" sem estar |
| 1 atalho | 4 comandos globais + 3 locais; badge com 8 estados |
| `permissao.html` solto | Página de opções completa (pareamento, microfone, atalhos, preferências de fonte/modo mínimo/transições, gateway) |
| Vigia injetado como arquivo | Vigia é uma função autocontida injetada com `func` em `world: "MAIN"` (o loader do bundler não roda sem `chrome.runtime`) |
| Meet apenas | Lembrete e content script estático em Meet, Zoom web e Teams web; painel funciona em qualquer `https://` |

### O que foi preservado à risca

- `fonteAba.connect(contexto.destination)` — **o loopback**. `tabCapture` silencia a aba; sem isso o closer para de ouvir o lead. Está em `grafo-audio.ts` com aviso.
- AudioContext em taxa nativa; downsample no worklet (`public/pcm-worklet.js`, byte a byte igual).
- PCM por AudioWorklet, nunca MediaRecorder.
- Canal 0 = lead, canal 1 = closer.
- Painel nasce na página; PiP só por clique do usuário.
- `getDisplayMedia` interceptado no world MAIN; `displaySurface === "monitor"` = perigo.
- Offscreen Document como único lugar com AudioContext.
- Ao parar, o gateway recebe `encerrar` antes de o socket fechar.

### Decisões que merecem revisão pelo time

- **Recusa do lead não é enviada ao gateway.** A instrução foi "descarta tudo". Se o QS quiser marcar a reunião como "sem copiloto — lead recusou", basta um `POST` em `consentimentoRecusado()` no service worker.
- **Botão ⤾ Repetir** da spec de UX ficou de fora: depende de `assist.request` no gateway.
- **Fontes de marca** (Criteria CF, BDO Grotesk) entram se instaladas na máquina; o fallback é Inter/system-ui com as mesmas métricas.
- **Ícones** são placeholders gerados por script. Trocar por arte oficial em `public/icones/`.
