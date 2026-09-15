# Empacotar e distribuir o Copiloto QS sem passar pela Web Store

A extensão é interna. Ela captura áudio de call e conversa com o gateway da
Inovvatur — não faz sentido (nem é desejável) publicá-la na Chrome Web Store.
Existem dois caminhos oficiais para instalar uma extensão fora da loja em
Chrome gerenciado. **Os dois exigem um Google Workspace com os Chromes dos
closers matriculados no Chrome Browser Cloud Management (CBCM).**

| Caminho | Quando usar | O que precisa |
|---|---|---|
| **A. Política + CRX self-hosted** (recomendado) | Produção. Instalação forçada, atualização automática, closer não consegue desinstalar | Servidor HTTPS para o `.crx` e o `update.xml`, chave `.pem` guardada |
| **B. Política + "Carregar sem compactação" liberada** | Homologação / piloto com 2–3 closers | Só a política `ExtensionInstallSources` ou modo desenvolvedor liberado |

> **Sem gerenciamento**, o Chrome bloqueia `.crx` de fora da loja
> ("não é da Chrome Web Store") e remove extensões carregadas por arquivo.
> Não existe atalho — o CBCM é o pré-requisito.

---

## 1. Gerar o build

```bash
cd ~/Documents/qs-copilot-spike/extension-v2
npm ci
npm run build          # gera dist/ (tsc --noEmit + vite build)
npm run empacotar      # gera release/copiloto-qs-<versão>.zip
```

`dist/` é a extensão pronta. Antes de empacotar, confira:

- `manifest.json` em `dist/` com a `version` certa (é ela que dispara a atualização).
- `host_permissions` apontando **só** para `https://gw.qs.inovvatur.com.br/*`
  em produção — remova `http://localhost:8787/*` do `manifest.json` antes do
  build de release.
- `src/compartilhado/config.ts` → `GATEWAY_PADRAO` de produção.

---

## 2. Gerar o CRX assinado e o ID fixo

O ID da extensão é derivado da chave pública. **A chave `.pem` é o ativo mais
importante deste processo**: perdê-la muda o ID, e o ID fixo é o que a
política usa. Guarde no cofre da empresa (1Password/Bitwarden), nunca no repositório.

### Primeira vez (gera a chave)

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="$PWD/dist"
# → cria dist.crx e dist.pem ao lado da pasta dist/
mv dist.pem copiloto-qs.pem   # GUARDE ESTE ARQUIVO
mv dist.crx release/copiloto-qs-$(node -p "require('./dist/manifest.json').version").crx
```

### Versões seguintes (reusa a chave)

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="$PWD/dist" \
  --pack-extension-key="/caminho/seguro/copiloto-qs.pem"
```

### Descobrir o ID

Carregue `dist/` em `chrome://extensions` (modo desenvolvedor) **com a mesma
chave** — para isso, adicione ao `manifest.json` de desenvolvimento a linha
`"key": "<chave pública base64>"`, obtida com:

```bash
openssl rsa -in copiloto-qs.pem -pubout -outform DER 2>/dev/null | openssl base64 -A
```

O ID (32 letras a–p) aparece no card da extensão. Ele fica o mesmo em todos
os builds assinados com esse `.pem`. Anote: é usado nas seções 3 e 4.

> Alternativa sem abrir o Chrome: `openssl rsa -in copiloto-qs.pem -pubout -outform DER | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p'`

---

## 3. Hospedar o CRX e o manifesto de atualização

Qualquer servidor HTTPS estático serve (bucket S3/GCS com CDN, Cloudflare
Pages, Fly.io com `@fastify/static`). Sugestão: `https://ext.qs.inovvatur.com.br/`.

```
https://ext.qs.inovvatur.com.br/
├── update.xml
└── copiloto-qs-2.0.0.crx
```

`update.xml` (o Chrome consulta a cada ~5 h e sempre que a política é aplicada):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="SEU_ID_DE_32_LETRAS">
    <updatecheck codebase="https://ext.qs.inovvatur.com.br/copiloto-qs-2.0.0.crx" version="2.0.0" />
  </app>
</gupdate>
```

Regras:

- `version` no XML **tem que ser igual** à do `manifest.json` dentro do `.crx`.
- Sirva o `.crx` com `Content-Type: application/x-chrome-extension`.
- Para lançar uma versão: sobe o novo `.crx`, edita o `update.xml`, pronto.
  Não precisa mexer na política.
- Mantenha as 2 últimas versões no servidor para rollback (basta apontar o XML de volta).

---

## 4. Política no Google Admin (Chrome Browser Cloud Management)

Admin Console → **Dispositivos → Chrome → Apps e extensões → Usuários e navegadores**
→ escolha a UO dos closers (ex.: `Comercial / Closers`) → **+** → **Adicionar
extensão por ID**:

| Campo | Valor |
|---|---|
| ID da extensão | o ID da seção 2 |
| URL de atualização (From a custom URL) | `https://ext.qs.inovvatur.com.br/update.xml` |
| Política de instalação | **Instalar à força** (Force install) — closer não desinstala |
| Fixar na barra de ferramentas | **Sim** — o ícone precisa estar visível, é ele que ativa o copiloto |

Ainda na mesma tela, em **Configurações adicionais da extensão** →
**Permissões e URLs**, garanta que `tabCapture`, `offscreen`, `scripting`,
`storage` e `activeTab` não estejam na lista de permissões bloqueadas da UO.

### Equivalente em JSON (para quem gerencia por `ExtensionSettings`)

```json
{
  "ExtensionSettings": {
    "SEU_ID_DE_32_LETRAS": {
      "installation_mode": "force_installed",
      "update_url": "https://ext.qs.inovvatur.com.br/update.xml",
      "toolbar_pin": "force_pinned"
    },
    "*": {
      "installation_mode": "allowed"
    }
  }
}
```

No macOS sem Admin Console isso vai em
`/Library/Managed Preferences/com.google.Chrome.plist`; no Windows, em
`HKLM\Software\Policies\Google\Chrome\ExtensionSettings`. Só use esse caminho
em máquina de teste — em produção, o Admin Console é a fonte de verdade.

### Verificar na máquina do closer

`chrome://policy` → deve listar `ExtensionSettings` com o ID. Depois,
`chrome://extensions` → o card do Copiloto aparece com "Instalado pelo
administrador". Se aparecer o botão "Remover", a política não chegou —
confira se o Chrome está matriculado (`chrome://management`).

---

## 5. Caminho B — piloto sem CRX (homologação)

Para testar com poucos closers antes de assinar:

1. No Admin Console, na UO de piloto, **Configurações do usuário → Extensões →
   Modo desenvolvedor**: *Permitir*.
2. Envie o `release/copiloto-qs-<versão>.zip`, o closer descompacta e usa
   **Carregar sem compactação** em `chrome://extensions`.
3. Atualização é manual (novo zip, "Atualizar" no card).

Nunca use isto em produção: o ID muda por máquina, não há atualização
automática, e o Chrome mostra o aviso "desative as extensões em modo
desenvolvedor" a cada abertura.

---

## 6. Checklist de release

- [ ] `GATEWAY_PADRAO` e `host_permissions` apontam para produção
- [ ] `version` incrementada em `manifest.json`
- [ ] `npm run build` sem erro de tipo
- [ ] Teste manual numa call real: ativar, escolher lead, consentimento, briefing, escuta, feedback, parar
- [ ] Teste dos 3 modos de compartilhamento (aba, janela, tela inteira → alerta vermelho)
- [ ] Teste de queda: desligar Wi-Fi 20 s no meio da call → "Reconectando" → volta sozinho
- [ ] `.crx` assinado com o **mesmo `.pem`**
- [ ] `update.xml` com a nova `version` e `codebase`
- [ ] Versão anterior mantida no servidor para rollback
- [ ] Um closer da UO de piloto recebe primeiro; produção só depois de 1 dia de calls

---

## 7. Perguntas que vão aparecer

**"Dá para o closer instalar sozinho, sem TI?"** Não em Chrome sem gerenciamento.
Esse é o motivo de o CBCM ser pré-requisito, não opção.

**"E se o closer usa o Chrome pessoal?"** O perfil precisa estar logado na conta
Workspace da empresa e o navegador matriculado. Perfil pessoal não recebe a política.

**"Edge, Brave, Arc?"** Todos aceitam CRX MV3 e a mesma política
`ExtensionSettings`, mas o CBCM só gerencia Chrome. Padronize em Chrome.

**"Perdi o `.pem`."** O ID muda. Você vai precisar publicar uma extensão nova
na política, e os closers ficarão com duas até a antiga ser removida da política.
Por isso: cofre, com backup.
