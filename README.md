# Copiloto QS

Copiloto de vendas em tempo real para calls de fechamento. Escuta a reunião,
detecta a objeção no momento em que o cliente a diz, e coloca a resposta na
tela do vendedor — invisível para o outro lado.

**Grupo Inovvatur · Se Tu For Eu Vou Viagens**

---

## Por que existe

Uma venda de alto ticket se ganha ou se perde em três segundos: o intervalo
entre o cliente dizer *"achei caro"* e o vendedor improvisar uma resposta que
varia conforme quem está na call e como ele dormiu.

As ferramentas do mercado gravam a call e te dizem onde você errou **depois**
que o cliente foi embora. Esta ajuda **durante**, quando ainda dá para virar.

---

## Estado atual

O protótipo está **validado em call real**. Medido, não estimado:

| Métrica | Resultado |
|---|---|
| Fala do cliente → card na tela | **1.482 ms** |
| Referência de mercado (SalesPitch) | 15.000 ms (anunciado) |
| Transcrição pt-BR | funcional, com pontuação |
| Separação de quem falou | perfeita (dois canais físicos) |
| Custo por call de 40 min | R$ 4,18 |

Exemplo de detecção real, capturada em teste:

```
⚡ Preço (1482ms) — "Achei muito caro esse produto."
   → "Caro comparado a quê? Deixa eu te mostrar o que entra nesse valor."
```

---

## Como funciona

```
Google Meet
    │  o cliente fala
    ▼
Extensão Chrome ──── captura o áudio em 2 canais separados
    │                 canal 0 = cliente · canal 1 = vendedor
    ▼
Gateway ──────────── Deepgram transcreve em tempo real (pt-BR)
    │                 4 camadas de detecção:
    │                   L0 gatilho literal    instantâneo
    │                   L1 busca vetorial     resposta pré-aprovada
    │                   L2 Claude Haiku 4.5   entende a intenção
    │                   L3 Claude Sonnet 5    gera quando nada serve
    ▼
Painel na tela do vendedor
```

**Regra dura:** LLM generativo nunca no caminho crítico. O card instantâneo vem
do banco de respostas já aprovadas; a IA refina depois e substitui se discordar.

### Dois canais, não um

O áudio do cliente e o do vendedor são capturados separadamente. Isso dá
separação de falante **perfeita e de graça** — sem depender de IA adivinhando
vozes, que erra muito em português.

---

## Estrutura

| Pasta | O que é | Estado |
|---|---|---|
| `extension/` | Protótipo da extensão (v2.0) | **Funcionando** |
| `server/` | Servidor do protótipo | **Funcionando** |
| `extension-v2/` | Extensão de produção (TypeScript) | Build limpo |
| `server-v2/` | Gateway de produção | 41 testes passando |
| `sql/` | Banco, RLS, 30 objeções de turismo | Validado, não aplicado |
| `qs-modulo/` | Telas para o sistema QS | Pronto para integrar |

---

## Rodar o protótipo

Precisa de Node 20+ e uma chave do Deepgram
([console.deepgram.com](https://console.deepgram.com) — US$ 200 de crédito grátis).

```bash
cd server
cp .env.example .env     # cole sua chave
npm install
npm run dev
```

No Chrome:

1. `chrome://extensions` → ligar **Modo do desenvolvedor**
2. **Carregar sem compactação** → selecionar a pasta `extension`
3. Abrir `chrome-extension://<ID>/permissao.html` e autorizar o microfone
4. Entrar numa call do Meet — **o copiloto liga sozinho**

Histórico das calls: `http://localhost:8787/calls.html`

### Testar sem precisar de ninguém

```bash
npm run simular    # simula uma call completa de venda
npm run teste      # valida a transcrição em português
```

---

## Descobertas técnicas

Coisas que custaram tempo e ficam registradas para não se perderem:

**`language=pt-BR` não funciona no Deepgram.** O `nova-2` não devolve nada e o
`nova-3` decodifica português como se fosse inglês ("Dá para parcelar" virava
"Dow forwardsler"). O que funciona é `nova-3` + `language=multi`.

**`chrome.tabCapture` exige clique do usuário** e silencia a aba. Por isso a
captura passou a usar `captureStream()` nos elementos `<audio>` do Meet: não
precisa de permissão especial, não silencia nada, e liga sozinho.

**O Deepgram só marca a fala como definitiva** depois de silêncio ou do comando
de encerramento. Encerrar a sessão sem esperar isso perde as últimas falas de
toda call.

**O painel aparece no compartilhamento de tela inteira** (some no de aba e no
de janela). O sistema detecta e borra o conteúdo automaticamente.

---

## Privacidade

- Nenhuma gravação de áudio é armazenada por padrão
- Transcrições ficam em `dados/`, fora do controle de versão
- O fluxo de consentimento (v2) registra a autorização do cliente antes de
  qualquer captura
- Nenhuma chave de API vive no navegador — tudo passa pelo gateway

---

## Licença

Software proprietário do Grupo Inovvatur. Todos os direitos reservados.

---

*O jogo é do profissionalismo.*
