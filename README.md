# 🟡 PapaToken

Aproveita os tokens ociosos das suas assinaturas de IA. Monitora as janelas de uso
(5 horas + semanal) do **Claude Code** (Pro/Max) e do **Codex** (ChatGPT), mantém uma
fila de tarefas e as executa automaticamente quando identifica que vai sobrar token —
antes que a janela resete e o saldo se perca.

## Como funciona

- **Uso do Claude Code**: consulta o endpoint OAuth (não documentado) que alimenta o
  `/usage` do próprio CLI, usando o login local de `~/.claude/.credentials.json`.
  Retorna % da janela de 5h, % semanal e horários de reset. Cache de 180s (o endpoint
  limita consultas frequentes).
- **Uso do Codex**: lê os JSONL de sessão em `~/.codex/sessions/**` — cada interação
  grava um evento `token_count` com `rate_limits` (primária = 5h, secundária = semanal).
  O dado tem a idade da última interação com o Codex (marcado como "estimado" na UI).
- **Execução**: `claude -p` (com `--permission-mode acceptEdits`) e
  `codex exec -s workspace-write`, headless, no diretório de trabalho da tarefa.
  O prompt vai por stdin. Concorrência de 1 tarefa por assinatura.
- **Entrega por Pull Request** (opcional, por tarefa): o executor cria uma
  `git worktree` temporária a partir de `origin/<base>` (branch base configurável;
  padrão = a default do repo), a IA trabalha nela — o seu checkout fica intocado —
  e, ao concluir, o PapaToken commita, faz push e abre o PR via `gh`, com o resumo
  da IA no corpo. O nome da branch vem da tarefa ou do template das Configurações
  (`feat/{slug}` por padrão; variáveis `{id}`, `{slug}`, `{date}`). Se a IA não
  alterar nada, não há PR; se o push/PR falhar, o commit fica preservado na
  worktree para inspeção.
- **Portão de qualidade** (opcional, por tarefa): um comando de verificação
  (ex.: `npm test`) roda após a IA e antes do commit/PR. Se falhar, a saída é
  devolvida à IA para **uma** rodada de correção e a verificação roda de novo;
  persistindo a falha, a tarefa é marcada como falha (sem PR). O formulário
  sugere comandos detectados no repositório e lembra o último usado por repo.
- **Scheduler** (tick de 60s), por assinatura:
  1. nunca despacha acima do **teto de segurança** (default 90%, janela 5h ou semanal);
  2. exige **sobra mínima** até o teto (default 15%);
  3. no modo `window` (default), só despacha quando faltar menos que a **janela de
     despacho** (default 60 min) para o reset da 5h — token que ia sobrar de qualquer jeito;
     no modo `aggressive`, despacha sempre que houver sobra; `paused` desliga tudo.
  - Se o CLI acusar rate limit, a tarefa volta para a fila e o provider fica bloqueado 30 min.
  - Falhas transitórias são re-tentadas até `max_attempts` (default 2).

## Rodando

```powershell
npm install
npm run build        # build do frontend (web/dist)
npm run start        # servidor em http://127.0.0.1:3333
```

Desenvolvimento: `npm run dev` (server com watch) + `npm run dev:web` (Vite em :5173 com proxy).

### Testes e verificação

```powershell
npm run check        # typecheck (server + web) e testes — rode antes de commitar
npm test             # só os testes (Vitest, em server/test/)
```

Os testes cobrem os pontos mais sujeitos a regressão: os **parsers dos providers**
(com fixtures reais em `server/test/fixtures/` — se o formato do endpoint OAuth ou dos
JSONL do Codex mudar, atualize as fixtures junto), o **algoritmo de despacho**
(`decide()` em `scheduler.ts`, função pura com relógio injetável), as **rotas da API**
(via `app.inject()` do Fastify) e as **funções da entrega por PR** (`git.ts`).
Rodam com banco em memória (`PAPATOKEN_DB=:memory:`) e não tocam rede, CLIs nem o
banco real.

O fluxo git completo (worktree → commit → push) tem um smoke manual contra um
repositório local descartável: `cd server && npx tsx test/smoke-git.ts`.

Iniciar junto com o sistema:
- Windows: `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`
- Linux (systemd): `bash scripts/install-autostart.sh`

## Pré-requisitos

- Node.js 22.5+ (usa o SQLite nativo do Node — sem dependência compilada)
- `@anthropic-ai/claude-code` instalado e logado (`claude` → login com a assinatura)
- `@openai/codex` instalado e logado (`codex login`) — sem isso o card do Codex mostra
  "sem dados" e tarefas designadas a ele ficam na fila
- Para entrega por PR: `git` e o GitHub CLI (`gh`) logado (`gh auth login`) —
  Windows: `winget install GitHub.cli`; Linux: `apt install gh` (ou equivalente)
- Windows e Linux são suportados (macOS deve funcionar pelo caminho POSIX, não testado)

## Estrutura

```
server/src/
  providers/claude.ts   uso via endpoint OAuth + execução claude -p
  providers/codex.ts    uso via JSONL de sessões + execução codex exec
  scheduler.ts          algoritmo de despacho (tick 60s)
  executor.ts           spawn headless, timeout, rate-limit, retries
  git.ts                entrega por PR: worktree, branch, commit/push, gh pr create
  routes.ts             REST + SSE (/api/events)
  db.ts                 SQLite (node:sqlite) — server/data/papatoken.db
web/src/pages/          Dashboard, Tarefas, Detalhe, Configurações
```

## Avisos

- Os mecanismos de leitura de uso são **semi-oficiais** (endpoint não documentado /
  formato interno dos logs) e podem quebrar com atualizações dos CLIs. A camada
  `providers/` isola isso do resto do sistema.
- Tarefas rodam de forma autônoma com permissão de escrita no diretório informado.
  Prefira diretórios com **git** para revisar e reverter o que a IA fez.
- Se o token OAuth do Claude expirar, abra o Claude Code uma vez para renovar
  (o dashboard avisa).

## Dicas de uso

- Escreva prompts autossuficientes: contexto, critério de pronto e o que **não** fazer.
- Use a prioridade para ordenar a fila (no empate, a mais antiga executa primeiro);
  `any` deixa o scheduler usar a primeira assinatura com sobra.
- O teto de segurança existe para o seu uso manual nunca ser prejudicado — ajuste em
  Configurações conforme sua rotina.
