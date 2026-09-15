# Copiloto QS — Spike de validação

Teste mínimo para provar que a mecânica funciona **antes** de investir nas 11 semanas.

**O que este spike faz:** captura o áudio da call, transcreve em tempo real em português e mostra uma sugestão quando detecta objeção.

**O que ele NÃO faz (de propósito):** não grava nada, não salva no banco, não usa IA, não conhece seus leads. As sugestões vêm de uma lista fixa de 15 gatilhos. Isso é intencional — queremos medir a latência real do áudio e da transcrição, sem nada no meio do caminho.

---

## ✅ Passos 1 e 2 já estão feitos

A chave está configurada e o pipeline foi validado com fala real em português.

**Configuração vencedora (já no `.env`):**
```
DEEPGRAM_MODEL=nova-3
DEEPGRAM_LANGUAGE=multi
```

> ⚠️ `language=pt-BR` **não funciona** — o nova-2 não devolve nada e o nova-3 decodifica como inglês.
> Só `language=multi` transcreve português corretamente. Não mude isso.

**Resultado medido (10 frases de objeção real):**

| Métrica | Valor |
|---|---|
| Latência até a primeira palavra | **~1.255 ms**, muito consistente |
| Transcrição perfeita | 5/10 (as outras têm diferença trivial: pontuação, artigo) |
| Gatilhos disparados | **8/10** |

Para repetir o teste a qualquer momento: `npm run teste`

---

## Passo 3 — Ligar o servidor

```bash
cd ~/Documents/qs-copilot-spike/server
npm run dev
```

Deve aparecer o quadro do Copiloto e "Aguardando a extensão…".
**Deixe este terminal aberto** — é nele que você vai ver a latência de cada detecção.

---

## Passo 4 — Instalar a extensão

1. Abra `chrome://extensions`
2. Ligue **Modo do desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem compactação**
4. Selecione a pasta `~/Documents/qs-copilot-spike/extension`

Copie o **ID da extensão** que aparecer no card.

---

## Passo 5 — Liberar o microfone (uma vez só)

Abra esta URL no Chrome, trocando `SEU_ID` pelo ID que você copiou:

```
chrome-extension://SEU_ID/permissao.html
```

Clique em **Autorizar microfone**.

> Sem isso o copiloto transcreve só o lead — ainda funciona, mas você não vê a sua própria fala.

---

## Passo 6 — Testar numa call

1. Abra **https://meet.google.com** e inicie uma reunião
2. Um botão **🎙️ Copiloto** aparece no canto inferior direito
3. Clique nele → abre uma janela flutuante
4. Fale

### O que deve acontecer

- A janela mostra a transcrição ao vivo, separando **Lead** de **Você**
- Ao falar uma objeção, um card branco aparece com a resposta sugerida
- O rodapé mostra a latência em milissegundos
- **Você continua ouvindo o outro lado normalmente**

### Teste sozinho, sem precisar de ninguém

Abra um vídeo do YouTube em português em outra aba do Meet, ou use o celular com o viva-voz. O áudio da aba é tratado como "lead".

Frases para testar:

> "Achei meio caro esse pacote"
> "Vou falar com minha esposa e te retorno"
> "Dá pra parcelar em quantas vezes?"
> "Me manda no WhatsApp que eu vejo depois"
> "E se eu precisar cancelar?"

---

## As 3 perguntas que este teste responde

| # | Pergunta | Como saber |
|---|---|---|
| **1** | O `tabCapture` devolve o áudio para você? | Você continua ouvindo o outro lado depois de ligar o copiloto |
| **2** | A janela flutuante funciona sem atrapalhar? | Ela fica por cima, você move onde quiser, e some quando você compartilha **a aba** |
| **3** | O Deepgram acerta o português com jargão de turismo? | Fale "Capadócia", "all inclusive", "Punta Cana" e veja a transcrição |

**Passou nas três → o projeto é viável e vale as 11 semanas.**
**Falhou em alguma → você economizou 14 semanas e uns R$ 60 mil.**

---

## ⚠️ Teste obrigatório de segurança

Compartilhe a tela de três formas diferentes e veja se a janela do copiloto aparece para o outro lado:

| Modo | Esperado |
|---|---|
| Compartilhar **uma aba** | ❌ Não aparece — seguro |
| Compartilhar **uma janela** | ❌ Não aparece — seguro |
| Compartilhar **a tela inteira** | ⚠️ **APARECE** — o lead veria o script |

Confirme isso com os próprios olhos. É o risco mais perigoso do produto, e no sistema final vira um alerta automático.

---

## Se der errado

| Sintoma | Causa | Solução |
|---|---|---|
| Parei de ouvir o lead | A re-rota do áudio falhou | **Anote e me avise — é o risco nº 1** |
| "Servidor caiu" | Servidor não está rodando | Volte ao Passo 3 |
| Nada transcreve | Chave inválida ou sem saldo | `npm run probe` |
| Só transcreve o lead | Microfone não autorizado | Passo 5 |
| Botão não aparece | Content script não carregou | Recarregue a aba do Meet |
| Erros no console | — | `chrome://extensions` → **service worker** → Console |

---

## Estrutura

```
qs-copilot-spike/
├── server/
│   ├── src/index.js         ponte extensão ↔ Deepgram
│   ├── src/gatilhos.js      15 objeções de turismo
│   └── scripts/probe-deepgram.js
└── extension/
    ├── manifest.json
    ├── background.js        orquestra (service worker MV3)
    ├── offscreen.js         captura os 2 canais de áudio
    ├── pcm-worklet.js       converte para PCM 16 kHz
    ├── content.js           botão + janela flutuante
    └── permissao.html       libera o microfone
```

Para mudar as sugestões, edite `server/src/gatilhos.js` e reinicie o servidor.
