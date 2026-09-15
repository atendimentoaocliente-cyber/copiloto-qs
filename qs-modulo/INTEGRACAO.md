# Integração do módulo Copiloto no QS

Guia de aplicação. Todo trecho abaixo foi conferido contra o código real de
`/Users/everton/Documents/qs-system/` em 13/09/2026.

**Natureza das mudanças:** adição pura. Nenhum arquivo existente é reescrito —
só ganham linhas novas. O QS continua funcionando se você aplicar só uma parte.

---

## 0. Copiar os arquivos

```bash
cd ~/Documents/qs-copilot-spike/qs-modulo

cp -r components/sdr/copiloto  ~/Documents/qs-system/src/components/sdr/
cp lib/qs/copiloto.ts          ~/Documents/qs-system/src/lib/qs/
```

Resultado:

```
qs-system/src/
├── components/sdr/copiloto/
│   ├── PlaybookPage.tsx
│   ├── CallsPage.tsx
│   ├── CallDetailPage.tsx
│   ├── AnalyticsPage.tsx
│   ├── PareamentoPage.tsx
│   ├── ui.tsx
│   └── types.ts
└── lib/qs/copiloto.ts
```

**Pré-requisito:** as migrations de `qs-copilot-spike/sql/` precisam estar
aplicadas, ou as telas abrem vazias.

---

## 1. `src/contexts/QsAuthContext.tsx` — liberar acesso

O closer hoje só enxerga leads. Ele é justamente quem mais usa o copiloto.

**Linha 28-33, antes:**

```typescript
const MENU_ACCESS: Record<UserRole, string[]> = {
  admin: ["*"], // all
  gestor: ["painel", "cobertura", "leads", "cadencias", "reunioes", "dashboard", "metas", "lead-detail", "cadencia-criar", "cadencia-editar"],
  sdr: ["painel", "cobertura", "leads", "lead-detail"],
  closer: ["leads", "lead-detail"],
};
```

**Depois:**

```typescript
const MENU_ACCESS: Record<UserRole, string[]> = {
  admin: ["*"], // all
  gestor: ["painel", "cobertura", "leads", "cadencias", "reunioes", "dashboard", "metas", "lead-detail", "cadencia-criar", "cadencia-editar",
           "copiloto-calls", "copiloto-call-detalhe", "copiloto-playbook", "copiloto-analytics"],
  sdr: ["painel", "cobertura", "leads", "lead-detail"],
  // O closer é o usuário principal do copiloto: precisa das reuniões (de onde
  // inicia a call), do histórico das próprias calls e do pareamento da extensão.
  closer: ["leads", "lead-detail", "reunioes",
           "copiloto-calls", "copiloto-call-detalhe", "copiloto-pareamento"],
};
```

> O playbook fica fora do closer de propósito: quem edita a munição é o gestor.
> Se quiser que o closer leia sem editar, adicione `"copiloto-playbook"` — a
> própria tela já esconde os botões de edição para papel não-gestor.

---

## 2. `src/components/sdr/SdrLayout.tsx`

### 2.1 Imports — depois da linha 4

```typescript
import CallsPage from "./copiloto/CallsPage";
import CallDetailPage from "./copiloto/CallDetailPage";
import PlaybookPage from "./copiloto/PlaybookPage";
import AnalyticsPage from "./copiloto/AnalyticsPage";
import PareamentoPage from "./copiloto/PareamentoPage";
```

### 2.2 União `SdrNav` — linha 69

**Antes:**

```typescript
export type SdrNav =
  | "painel"
  | "leads"
  | "lead-detail"
  ...
  | "configuracoes";
```

**Depois** — acrescente ao final, antes do `;`:

```typescript
  | "configuracoes"
  | "copiloto-calls"
  | "copiloto-call-detalhe"
  | "copiloto-playbook"
  | "copiloto-analytics"
  | "copiloto-pareamento";
```

### 2.3 Array `MENU` — linha 98

Adicione um grupo novo depois de `"desempenho"`:

```typescript
  {
    id: "copiloto",
    label: "Copiloto",
    items: [
      { id: "copiloto-calls", label: "Calls", description: "Reuniões gravadas e analisadas" },
      { id: "copiloto-playbook", label: "Playbook", description: "Objeções e respostas do time" },
      { id: "copiloto-analytics", label: "Inteligência", description: "O que trava a venda" },
      { id: "copiloto-pareamento", label: "Conectar extensão", description: "Parear o Chrome com o QS" },
    ],
  },
```

### 2.4 Estado da call aberta — junto da linha 236

**Antes:**

```typescript
  const [activeNav, setActiveNav] = useState<SdrNav>("painel");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
```

**Depois:**

```typescript
  const [activeNav, setActiveNav] = useState<SdrNav>("painel");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
```

### 2.5 Navegação para a call — junto de `openLeadDetail` (linha ~276)

```typescript
  function openCallDetail(callId: string) {
    setSelectedCallId(callId);
    setActiveNav("copiloto-call-detalhe");
  }
```

### 2.6 Destaque do menu — linha 290

**Antes:**

```typescript
    activeNav === "lead-detail" ? "leads" :
    activeNav === "cadencia-criar" || activeNav === "cadencia-editar" ? "cadencias" :
```

**Depois** — acrescente uma linha:

```typescript
    activeNav === "lead-detail" ? "leads" :
    activeNav === "cadencia-criar" || activeNav === "cadencia-editar" ? "cadencias" :
    activeNav === "copiloto-call-detalhe" ? "copiloto-calls" :
```

### 2.7 Blocos de renderização — depois do bloco `reunioes` (linha 456)

Siga o padrão existente, com `PageErrorBoundary`:

```typescript
        {activeNav === "copiloto-calls" && (
          <PageErrorBoundary pageName="Calls">
            <CallsPage onOpenCall={openCallDetail} onOpenLead={openLeadDetail} />
          </PageErrorBoundary>
        )}
        {activeNav === "copiloto-call-detalhe" && selectedCallId && (
          <PageErrorBoundary pageName="Detalhe da call">
            <CallDetailPage
              callId={selectedCallId}
              onBack={() => setActiveNav("copiloto-calls")}
              onOpenLead={openLeadDetail}
            />
          </PageErrorBoundary>
        )}
        {activeNav === "copiloto-playbook" && (
          <PageErrorBoundary pageName="Playbook">
            <PlaybookPage />
          </PageErrorBoundary>
        )}
        {activeNav === "copiloto-analytics" && (
          <PageErrorBoundary pageName="Inteligência">
            <AnalyticsPage onOpenPlaybook={() => setActiveNav("copiloto-playbook")} />
          </PageErrorBoundary>
        )}
        {activeNav === "copiloto-pareamento" && (
          <PageErrorBoundary pageName="Conectar extensão">
            <PareamentoPage />
          </PageErrorBoundary>
        )}
```

---

## 3. `src/components/sdr/meetings/MeetingsPage.tsx` — o atalho que importa

É daqui que o closer entra na call. Sem isto, o módulo existe mas ninguém usa.

### 3.1 Imports

```typescript
import { buscarCallDaReuniao } from "@/lib/qs/copiloto";
```

### 3.2 Props

**Antes:**

```typescript
interface MeetingsPageProps {
  onOpenLead: (leadId: string) => void;
}

export default function MeetingsPage({ onOpenLead }: MeetingsPageProps) {
```

**Depois:**

```typescript
interface MeetingsPageProps {
  onOpenLead: (leadId: string) => void;
  onOpenCall?: (callId: string) => void;
}

export default function MeetingsPage({ onOpenLead, onOpenCall }: MeetingsPageProps) {
```

E em `SdrLayout.tsx`, passe a prop:

```typescript
<MeetingsPage onOpenLead={openLeadDetail} onOpenCall={openCallDetail} />
```

### 3.3 Botão na linha da reunião

Na célula de ações de cada reunião, ao lado dos botões atuais:

```typescript
{meeting.status === "agendada" && meeting.meeting_url && (
  <a
    href={meeting.meeting_url}
    target="_blank"
    rel="noreferrer"
    className="text-blue-600 hover:underline"
    title="Abre a reunião. Ative o copiloto pelo ícone da extensão (⌘+Shift+K)."
  >
    Entrar na call
  </a>
)}

{meeting.status === "realizada" && meeting.copilot_call_id && onOpenCall && (
  <button
    onClick={() => onOpenCall(meeting.copilot_call_id!)}
    className="text-blue-600 hover:underline"
  >
    Ver call
  </button>
)}
```

> `meeting_url` e `copilot_call_id` vêm de `sql/005_alter_qs_meetings.sql`. O
> tipo `Meeting` já foi atualizado — as colunas são opcionais, então o código
> compila mesmo antes de a migration rodar.

**Por que não existe botão "Iniciar copiloto" aqui:** o Chrome só concede
captura de áudio quando a extensão é invocada pelo ícone ou pelo atalho. Um
botão numa página do QS não consegue ligar o copiloto numa aba do Meet — isso
é uma trava de segurança do navegador, não uma limitação nossa. O link abre a
reunião; a ativação é pelo ícone.

---

## 4. Ordem de aplicação

| # | Passo | Se falhar |
|---|---|---|
| 1 | Restaurar o Supabase (`SEU_PROJECT_ID` está pausado) | Nada funciona |
| 2 | Aplicar `sql/001` a `007` na ordem | Telas abrem vazias |
| 3 | Copiar os arquivos (seção 0) | — |
| 4 | Aplicar seções 1 e 2 | Menu não aparece |
| 5 | `npx tsc --noEmit` | Corrigir antes de seguir |
| 6 | `npx vite build` | — |
| 7 | Aplicar seção 3 | Closer não tem como entrar na call |

---

## 5. Verificação

```bash
cd ~/Documents/qs-system
npx tsc --noEmit          # deve passar limpo
npx vite build            # deve construir
cp public/tailwind.css dist/tailwind.css
node serve.cjs            # http://localhost:3000
```

Teste manual:

1. Entrar como **admin** → o grupo "Copiloto" aparece no menu
2. **Playbook** → as 30 objeções do seed estão lá, editáveis
3. **Calls** → lista vazia (ainda não houve call) sem quebrar
4. **Inteligência** → estado vazio explicando que precisa de calls
5. Entrar como **closer** → vê Calls e Conectar extensão, não vê Playbook
6. **Conectar extensão** → gera código de 6 dígitos

---

## 6. Sobre o Tailwind — leia antes de editar as telas

O QS carrega `public/tailwind.css` **pré-compilado e commitado**, e não há
`tailwind.config.js` no repositório. Consequência prática: **uma classe que não
esteja nesse arquivo simplesmente não renderiza** — sem erro, sem aviso.

As telas do módulo usam apenas classes já presentes. Cores da marca que não
existem como classe entram por `style={{}}` inline, através dos tokens de
`ui.tsx`:

```typescript
import { CORES } from "./ui";
<div style={{ background: CORES.azul }}>   // ✅ sempre funciona
<div className="bg-[#0D1B4B]">             // ❌ silenciosamente sem efeito
```

Antes de usar qualquer classe nova:

```bash
grep -c 'nome-da-classe' ~/Documents/qs-system/public/tailwind.css
```

Zero significa que ela não existe.

---

## 7. Reverter

```bash
cd ~/Documents/qs-system
git checkout src/components/sdr/SdrLayout.tsx \
              src/contexts/QsAuthContext.tsx \
              src/components/sdr/meetings/MeetingsPage.tsx
rm -rf src/components/sdr/copiloto src/lib/qs/copiloto.ts
```

As tabelas `qs_copilot_*` são independentes e podem ficar — nada no QS antigo
depende delas.
