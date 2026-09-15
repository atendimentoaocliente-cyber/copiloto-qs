# Copiloto QS — Gateway de produção (Frente B)

Gateway Node 22 + Fastify 5 que fica entre a extensão Chrome do closer e os fornecedores (Deepgram, Anthropic, Supabase). Recebe o áudio da call em dois canais, transcreve em streaming, detecta objeções e sinais de compra em quatro camadas e devolve **uma frase falável** para a tela do closer em menos de 2 s. Ao fim da call grava resumo, próximo passo, nota e custo direto no QS.

A extensão **nunca** fala com o Supabase: pareia com um código de 6 dígitos, recebe um JWT deste gateway e só conversa com ele.

## Arquitetura

```
Extensão Chrome (Frente C)          Gateway (este repo, Fly.io gru)               Supabase sa-east-1 (Frente A)
─────────────────────────           ───────────────────────────────────            ─────────────────────────────
aba (lead) ─┐                       WebSocket /v1/stream                            qs_call_sessions
mic (closer)┴─► PCM 16k 2ch ──────► ├─ STT: Deepgram nova-3 · language=multi        qs_call_transcripts
                                    ├─ Motor de 4 camadas                           qs_copilot_detections
◄── transcricao / sugestao ─────────┤   L0 gatilho literal      0 ms   ─┐ card      qs_copilot_objections (+pgvector)
                                    │   L1 pgvector (pré-aprov.) ~120ms ─┘ do banco  qs_call_summaries
REST /v1/*  (pairing, reuniões,     │   L2 Haiku 4.5 classifica  ~400ms  refina     qs_tasks · qs_notes (QS legado)
briefing, consentimento, feedback)  │   L3 Sonnet 5 gera         ~800ms  fallback   qs_copilot_consentimentos
                                    └─ Pós-call: resumo → nota → tarefa → catálogo  qs_copilot_pairing_codes
```

**Regra dura:** LLM generativo nunca no caminho crítico. O L0 emite de forma síncrona (antes de qualquer `await`); L1/L2/L3 refinam depois e **completam o mesmo card**. Se a IA falha, o card do playbook já está na tela e a falha é reportada — nunca engolida.

### As 4 camadas (`src/motor/`)

| Camada | Arquivo | O que faz | Latência alvo | Fonte no card |
|---|---|---|---|---|
| L0 | `gatilhos.ts` | Regex compilada dos `gatilhos[]` de cada objeção aprovada (editável pelo gestor, sem deploy). Insensível a acento. | < 1 ms | `playbook` (chip `pendente` se ainda vem refinamento) |
| L1 | `vetorial.ts` + `embeddings.ts` | Embedding (`text-embedding-3-small`, 1536 dims) + `match_objecao_hibrido` (cosseno + léxico, RRF) no pgvector. Resposta **pré-aprovada** do banco. | ~120 ms | `playbook` |
| L2 | `ia.ts` → `classificar()` | Claude Haiku 4.5, *structured output*: entende a intenção ("vou ver com calma" = preço), escolhe o candidato do banco ou **retira** o falso positivo do regex. | ~400 ms | `playbook` |
| L3 | `ia.ts` → `gerar()` | Claude Sonnet 5, só quando nada no banco serve. UMA frase, ≤ 20 palavras, podada por código (`podarResposta`). | ~800 ms | `ia` |

Orquestração em `pipeline.ts`: fila de profundidade 1 (resultado de turno antigo é descartado quando o lead fala de novo), cooldown por categoria medido em tempo de conversa, teto de custo por call que desliga L2/L3 e mantém L0/L1, circuit breaker da Anthropic (5 falhas/60 s → 30 s aberto), degradação Sonnet → Haiku em 429.

### Descobertas validadas em produção (não regredir)

- Deepgram: `language=pt-BR` **não funciona** (nova-2 devolve nada; nova-3 decodifica português como inglês). Use `model=nova-3&language=multi`. Há teste que trava isso.
- O Deepgram só marca `is_final` após silêncio ou `CloseStream`. `ProvedorDeepgram.finalizar()` manda `CloseStream` e **espera** o fechamento (prazo 5 s) antes do pós-call. Sem isso, o fim de toda call perde as últimas falas.
- `multichannel=true&channels=2`: canal 0 = lead, canal 1 = closer. `channel_index[0]` identifica. Diarização sem IA.
- Latência medida até a primeira palavra: ~1.255 ms (métrica `stt_primeira_palavra`).
- Prompt caching (sistema + digest do playbook com `cache_control`, TTL 1 h) reduz muito o custo. `cacheHitRatio` é métrica de primeira classe: abaixo de 70 % algo volátil entrou no prefixo.

## Rotas

Todas as respostas de erro têm o formato `{ "erro": "<codigo>", "mensagem": "..." }`. A extensão traduz `codigo_invalido_ou_expirado`, `usuario_inativo` e `unauthorized`.

### Pairing e sessão do dispositivo

**`POST /v1/pairing/codigo`** — chamada pelo **QS** (closer autenticado). Caminho oficial: `Authorization: Bearer <access_token do Supabase Auth>`. Caminho transitório (`PAIRING_ACEITA_SENHA_LEGADA=true`): corpo `{ "email", "senha" }` validado em `qs_users`. Rate limit 10/min por IP.
```json
→ 201 { "codigo": "482913", "expiraEm": "2026-09-13T18:05:00.000Z", "ttlSegundos": 300 }
```

**`POST /v1/dispositivos/parear`** — chamada pela **extensão**. Uso único. Rate limit 5/min por IP.
```json
{ "codigo": "482913", "rotulo": "Chrome · macOS", "impressao": "9f1c2a3b-…" }
→ 200 { "token": "<jwt>", "expiraEm": "2026-09-14T06:05:00.000Z", "dispositivoId": "9f1c2a3b-…",
        "usuario": { "id": "…", "nome": "Joana", "papel": "closer" } }
→ 401 { "erro": "codigo_invalido_ou_expirado" } · 401 { "erro": "usuario_inativo" }
```
Alias antigo: `POST /v1/pairing/trocar { codigo }` → `{ token, expiraEm, closer }`.

**`POST /v1/dispositivos/renovar`** (JWT) → `200 { "token", "expiraEm" }`. Alias: `POST /v1/auth/renovar`.
**`GET /v1/auth/eu`** (JWT) → `{ id, nome, papel, expiraEm }`.

### Antes da call

**`GET /v1/reunioes?dia=hoje|YYYY-MM-DD`** (JWT) — reuniões agendadas do closer (dono da reunião **ou** dono do lead), dia em São Paulo.
```json
→ 200 [ { "id": "…", "leadId": "…", "leadNome": "Marina Souza", "inicio": "2026-09-13T13:00:00.000Z",
          "sdrNome": "Carlos", "ticketEstimado": 32000, "destino": "Capadócia" } ]
```

**`GET /v1/leads/:leadId/briefing?reuniaoId=…`** (JWT) — o que o SDR levantou + histórico + calls anteriores. Closer só vê lead dele (ou sem dono); gestor/admin veem todos (403 caso contrário, 404 se o lead não existe).
```json
→ 200 { "lead": { "id", "nome", "primeiroNome", "cidade", "origem", "status" },
        "handover": { "resumo", "notas": [], "sdrNome", "criadoEm" } | null,
        "produto": { "nome", "destino", "ticketEstimado", "periodo" } | null,
        "historico": [ { "data", "tipo": "nota|reuniao|call", "descricao", "autor" } ],
        "ultimasCalls": [ { "data", "duracaoMin", "objecoes", "resultado": "fechou|sem_fechamento|follow_up|perdido" } ],
        "playbook": { "id": "inovvatur", "nome": "Playbook Inovvatur", "totalObjecoes": 17 } }
```

**`POST /v1/consentimentos`** (JWT) — prova do consentimento LGPD. A extensão só chama depois de o closer confirmar que leu o texto; a **recusa** entra pelo mesmo endpoint (`aceito: false`) para o QS auditar que o lead foi perguntado. Grava IP, user-agent e versão da extensão.
```json
{ "reuniaoId": "…", "leadId": "…", "confirmadoEm": "2026-09-13T13:01:20.000Z", "textoVersao": "2026-09-v1",
  "aceito": true, "motivoRecusa": null }
→ 201 { "id": "<consentimentoId>", "aceito": true }
```
O `id` é obrigatório em `sessao.iniciar`; sem consentimento aceito, do mesmo closer e do mesmo lead, o gateway fecha o WebSocket com **4404**.

### Durante e depois

**`POST /v1/sugestoes/:id/feedback`** (JWT) — complementa o feedback pelo WebSocket (a extensão usa o REST com fila offline).
```json
{ "sessaoId": "…", "valor": "usei" | "nao_serviu" | "ignorou", "em": "2026-09-13T13:20:00.000Z" }
→ 204 · 403 sessão de outro closer · 404 card/sessão inexistente
```

**`GET /v1/calls/:id/custo`** (JWT do dono, gestor ou admin) → custo da call (Deepgram + Anthropic + embeddings, USD e BRL, cache hit ratio).
**`GET /v1/custo/resumo?desde&ate&closerId`** (JWT gestor/admin ou `INTERNAL_TOKEN`) → agregado por período e por closer.

### Operação

| Rota | Auth | Uso |
|---|---|---|
| `GET /health` | — | 200 ok · **503 em drenagem** (o proxy do Fly para de rotear) |
| `GET /metrics` | `METRICS_TOKEN` (rede privada `fdaa::` do Fly é isenta) | Prometheus |
| `GET /internal/sessoes` | `INTERNAL_TOKEN` | `{ active_sessions, sessoes[] }` — o CI bloqueia deploy se > 0 |
| `GET /internal/latencias` | `INTERNAL_TOKEN` | p50/p95/p99 por etapa (JSON) |
| `POST /internal/drain` | `INTERNAL_TOKEN` | entra em drenagem (scale-in sem derrubar call) |

## WebSocket `/v1/stream` — contrato `qscopilot.v1`

Fonte da verdade: `extension-v2/src/compartilhado/protocolo.ts`. Espelho no servidor: `src/tipos/protocolo.ts`.

- URL: `wss://host/v1/stream?token=<JWT>`, subprotocolo `qscopilot.v1`. Sem token/origin válidos → **4401**.
- Primeira mensagem obrigatória: `sessao.iniciar { versao:1, sessaoId, reuniaoId, leadId, consentimentoId, plataforma, audio:{linear16,16000,2,temMicrofone}, cliente }` → `pronto { sessaoId, ia, modelo, heartbeatMs }`. Ou `sessao.retomar { sessaoId, ultimoSeq }` → `sessao.retomada { aPartirDoSeq }`.
- Áudio: frames binários com cabeçalho de 8 bytes (`versao=1`, `flags` bit0 = reenviado da fila, `seq` uint32 LE) + PCM s16le 16 kHz 2 canais intercalados. Frames `reenviado` são transcritos, mas não geram card fora de hora.
- Gateway → extensão: `transcricao { texto, falante, final }`, `sugestao { id, categoria, frase, nivel, eco, fonte, pendente?, latenciaMs, geradoEm }`, `sugestao.retirar { sugestaoId, motivo }`, `degradado { motivo, niveisDesligados? }`, `recuperado`, `reconectando { tentativa }`, `erro { codigo?, texto, fatal? }`, `pong { ts, ultimoSeq }`.
- Card único por detecção: o L0 vai como chip `pendente: true` quando ainda vem refinamento; L1/L2/L3 completam o **mesmo `id`**. Se nada completar em 900 ms, o gateway completa com a frase do playbook (o painel descarta pendentes em 1200 ms). Feedback (WS ou REST) referencia esse `id`, que é a linha em `qs_copilot_detections`.
- Queda de socket **não** encerra a call: o gateway espera `sessao.retomar` por 3 min (mesma máquina) ou reidrata do banco (outra máquina). Só `encerrar { sessaoId, motivo }` encerra — e aí o gateway aguarda a finalização do STT, roda o pós-call e fecha com 1000. Teto de duração → **4408**.

## Variáveis de ambiente

Copie `.env.example`. Obrigatórias em produção: `DEEPGRAM_API_KEY`, `DATABASE_URL`, `JWT_SEGREDO` (≥ 32 chars), `EXTENSAO_ORIGENS` (`chrome-extension://<id fixo>`), e **um** caminho de identidade para o pairing (`SUPABASE_JWT_SECRET` ou `PAIRING_ACEITA_SENHA_LEGADA=true`).

| Variável | Padrão | Para quê |
|---|---|---|
| `DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` | `nova-3` / `multi` | **não use pt-BR** |
| `ANTHROPIC_API_KEY` | — | sem ela: só L0 + L1, sem resumo pós-call (o gateway avisa e roda) |
| `ANTHROPIC_MODEL_CLASSIFICADOR` / `_GERADOR` / `_RESUMO` | `claude-haiku-4-5` / `claude-sonnet-5` / `claude-sonnet-5` | |
| `EMBEDDINGS_API_KEY` / `EMBEDDINGS_URL` / `EMBEDDINGS_MODEL` / `EMBEDDINGS_DIMENSOES` | — / OpenAI `/v1/embeddings` / `text-embedding-3-small` / `1536` | sem chave: L1 desligado |
| `DB_MODO` | `postgres` | `memoria` roda sem banco (dev/testes) |
| `JWT_TTL` / `PAIRING_TTL_SEGUNDOS` | `12h` / `300` | |
| `CAMBIO_BRL` / `CUSTO_MAX_BRL_POR_CALL` | `5.40` / `25` | teto desliga L2/L3 e mantém L0/L1 |
| `SESSAO_MAX_MINUTOS` / `SESSOES_MAX_POR_CLOSER` | `120` / `2` | |
| `DRENAGEM_MAX_MS` | `2700000` (45 min) | |
| `PLAYBOOK_CACHE_SEGUNDOS` | `300` | recarga do playbook (Supabase fora do caminho crítico) |
| `METRICS_TOKEN` / `INTERNAL_TOKEN` | — | vazio = aberto (só em dev) |
| `QS_ORIGEM` | — | CORS das rotas REST |

## Rodar local

```bash
cd server-v2
npm install
cp .env.example .env            # DB_MODO=memoria, JWT_SEGREDO com 32+ chars, DEEPGRAM_API_KEY
npm run dev                     # tsx watch, porta 8787
curl localhost:8787/health
```

Com `DB_MODO=memoria` o playbook vem do seed estático (`src/db/seed-objecoes.ts`), nada é persistido e o L1 usa um embedder determinístico. Com `PAIRING_ACEITA_SENHA_LEGADA=true` e `DB_MODO=postgres`, o fluxo completo funciona contra o QS de hoje (senha em `qs_users`).

Contra o Supabase real: aplique a migration da Frente A e os adendos `src/db/migrations/0001_qs_copilot_pairing_codes.sql` e `0002_qs_copilot_consentimentos.sql`, depois `npm run embeddings:backfill` (preenche `embedding` das objeções — sem isso o L1 não devolve nada).

## Testes

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run test:cobertura
```

- `test/motor/*` — L0 (acento, fronteira de palavra, severidade), pipeline (L0 síncrono, substituição, retirada de falso positivo, fila de profundidade 1, erros reportados, teto de custo).
- `test/integracao/sessao-gravada.test.ts` — reproduz uma call gravada de ponta a ponta no contrato da extensão v2: pairing → reuniões → briefing → consentimento → WebSocket com frames de 8 bytes → cards pendente/completo → queda + `sessao.retomar` → `encerrar` → espera de finalização do STT → pós-call (resumo, nota, tarefa, catálogo, custo). STT de fixture (`test/apoio/stt-fixture.ts`, eventos por deslocamento de bytes de áudio), IA falsa, repositório em memória: determinístico.
- `test/qs/rotas.test.ts`, `test/tipos/frame.test.ts`, `test/auth/*`, `test/custo/*`, `test/util/*`.

## Deploy — Fly.io região `gru`

```bash
fly launch --no-deploy --copy-config          # usa o fly.toml (app inovvatur-copiloto-api, gru)
fly secrets set DEEPGRAM_API_KEY=… ANTHROPIC_API_KEY=… EMBEDDINGS_API_KEY=… DATABASE_URL=… \
  JWT_SEGREDO=… SUPABASE_JWT_SECRET=… INTERNAL_TOKEN=… METRICS_TOKEN=… \
  EXTENSAO_ORIGENS=chrome-extension://<id-fixo> QS_ORIGEM=https://qs.inovvatur.com.br
fly deploy --strategy bluegreen
fly scale count 2 --region gru
```

Decisões no `fly.toml`: `min_machines_running = 2`, `auto_stop_machines = "off"` (**nunca** scale-to-zero em copiloto ao vivo), `performance-2x`, health check em `/health` a cada 10 s. O Fly limita `kill_timeout` a 300 s, então a drenagem de 45 min é orquestrada: o CI (`.github/workflows/deploy.yml`) bloqueia deploy fora da janela (08h–20h BRT) e com sessão ativa; para tirar uma máquina, `scripts/drenar-maquina.sh <machine-id>` chama `/internal/drain`, espera zero sessões (até 45 min) e só então remove. Rollback automático se o smoke (`scripts/smoke-ws.ts`) falhar.

Ordem de release: **gateway primeiro** (compatível com N-1 da extensão), extensão depois, QS por último.

## Custo por call (40 min, câmbio R$ 5,40)

| Componente | Cálculo | USD | BRL |
|---|---|---|---|
| Deepgram nova-3 streaming | 40 min × $0,0092 | 0,368 | 1,99 |
| Haiku 4.5 (L2, ~50 chamadas) | 2,5k fresh + 4k cache-read + 150 out, cada | 0,183 | 0,99 |
| Sonnet 5 (L3 em ~6 momentos-chave) | 6k cache + 6k fresh + 600 out, cada | ~0,12 | ~0,65 |
| Sonnet 5 (resumo pós-call) | 8k in + 1,5k out | 0,031 | 0,17 |
| Embeddings (L1) | ~8k tokens | 0,0002 | 0,00 |
| **Total variável** | | **≈ 0,70** | **≈ 3,80** |

Preços em `src/custo/precos.ts` (Sonnet 5 é $2/$10 por MTok; cache read 0,1×, write 1,25×). O contador (`src/custo/contador.ts`) acumula por call a partir do `usage` real de cada chamada e grava em `qs_call_sessions.stt_cost_usd/llm_cost_usd` + `metadata.custo`. Critério de pronto: < R$ 5 por call (`test/custo/contador.test.ts` valida o cenário de referência).

## Estrutura

```
src/
  app.ts · server.ts · config.ts · logger.ts
  auth/         jwt · supabase-jwt · pairing · identidade · rotas (dispositivos/*, pairing/*)
  qs/rotas.ts   reunioes · leads/:id/briefing · consentimentos · sugestoes/:id/feedback
  stt/          provedor (interface) · deepgram · index (fábrica)
  motor/        gatilhos (L0) · embeddings · vetorial (L1) · ia (L2/L3/resumo) · prompts · pipeline · circuito · playbook
  sessao/       ws (CallAoVivo, protocolo qscopilot.v1) · sessao · registro (drenagem)
  pos-call/     resumo → qs_call_summaries · qs_notes · qs_tasks · catalogação
  db/           repositorio (interface) · postgres · memoria · seed-objecoes · migrations/
  custo/        precos · contador · rotas
  observabilidade/ metricas (Prometheus + p50/p95/p99) · rotas
  tipos/protocolo.ts · util/{erros,pii,texto}.ts
```
