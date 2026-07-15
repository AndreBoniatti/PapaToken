import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, getSettings } from "./db.js";
import { emit } from "./events.js";
import {
  buildPrBody,
  deliverPullRequest,
  deliveryBlocker,
  fetchPrForReview,
  fetchReReviewContext,
  fetchReviewFeedback,
  isValidBranchName,
  postPrComment,
  prepareReviewWorktree,
  prepareWorktree,
  removeWorktree,
  renderBranchTemplate,
  REVIEW_COMMENT_MARKER,
  run,
} from "./git.js";
import type { PreparedWorktree, PrOverview, ReviewComment } from "./git.js";
import { parseCodexTokens } from "./providers/codex.js";
import { getProvider } from "./providers/index.js";
import { parseAttachments } from "./providers/types.js";
import type { Provider, ProviderId, TaskRow } from "./providers/types.js";
import { runVerifyCommand } from "./verify.js";

/** Prompt efetivo: anexos são apresentados ao modelo antes da instrução. */
function buildPrompt(task: TaskRow): string {
  const files = parseAttachments(task);
  if (files.length === 0) return task.prompt;
  return (
    `[Anexos] O usuário anexou os seguintes arquivos na pasta "anexos" do diretório de trabalho:\n` +
    files.map((f) => `- anexos/${f}`).join("\n") +
    `\nLeia/analise esses arquivos conforme necessário antes de executar a tarefa.\n\n---\n\n` +
    task.prompt
  );
}

/**
 * Prompt da rodada de correção: a IA volta ao mesmo diretório com a saída
 * da verificação que falhou em mãos.
 */
export function buildVerifyFeedbackPrompt(
  task: Pick<TaskRow, "prompt">,
  verifyCmd: string,
  verifyOutput: string
): string {
  const tail = verifyOutput.length > 4000 ? verifyOutput.slice(-4000) : verifyOutput;
  return (
    `Você acabou de executar a tarefa abaixo neste diretório, mas a verificação automática falhou.\n\n` +
    `[Tarefa original]\n${task.prompt}\n\n` +
    `[Verificação que falhou]\nComando: ${verifyCmd}\nSaída (final):\n${tail}\n\n` +
    `Corrija o que for necessário para a verificação passar. Não altere o comando de verificação ` +
    `nem enfraqueça testes existentes — a menos que estejam objetivamente errados.`
  );
}

const PROVIDER_SETUP: Record<ProviderId, { name: string; install: string; login: string }> = {
  claude: {
    name: "Claude Code",
    install: "npm install -g @anthropic-ai/claude-code",
    login: 'rode "claude" no terminal e faça login com sua assinatura (Pro/Max)',
  },
  codex: {
    name: "Codex",
    install: "npm install -g @openai/codex",
    login: 'rode "codex login" no terminal (assinatura ChatGPT)',
  },
};

/** mensagem de setup pronta para o log da tarefa (linhas [setup] viram avisos na UI) */
export function setupMessage(providerId: ProviderId, missing: "cli" | "login"): string {
  const s = PROVIDER_SETUP[providerId];
  if (missing === "cli") {
    return [
      `[setup] ${s.name} (comando "${providerId}") não está instalado ou não está no PATH deste servidor.`,
      `[setup] 1. Instale: ${s.install}`,
      `[setup] 2. Faça login: ${s.login}`,
      `[setup] 3. Reinicie o servidor do PapaToken (para ele enxergar o PATH atualizado) e devolva a tarefa à fila.`,
    ].join("\n");
  }
  return [
    `[setup] ${s.name} está instalado, mas sem login nesta máquina.`,
    `[setup] ${s.login} e devolva a tarefa à fila.`,
  ].join("\n");
}

/** o comando existe no PATH deste processo? (where/which — rápido e sem rede) */
export async function cliOnPath(cmd: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = await run(probe, [cmd], process.cwd());
  return r.code === 0;
}

/**
 * Pre-flight do provider: CLI instalado e logado? Falha em ~1s com passos de
 * setup no log, ANTES de tentar executar (e de o shell cuspir erro críptico).
 */
export async function providerBlocker(
  providerId: ProviderId,
  provider: Provider
): Promise<string | null> {
  if (!(await cliOnPath(providerId))) return setupMessage(providerId, "cli");
  if (!(await provider.isAvailable())) return setupMessage(providerId, "login");
  return null;
}

/** Prompt do atendimento de review: a IA volta à branch do PR com os comentários. */
export function buildReviewPrompt(
  task: Pick<TaskRow, "prompt">,
  comments: ReviewComment[]
): string {
  const list = comments
    .map(
      (c) =>
        `- @${c.author}${c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : ""}: ${c.body}`
    )
    .join("\n");
  return (
    `Você já executou a tarefa abaixo e o resultado está em um Pull Request aberto. ` +
    `Um revisor humano deixou comentários que precisam ser atendidos.\n\n` +
    `[Tarefa original]\n${task.prompt}\n\n` +
    `[Comentários do review]\n${list}\n\n` +
    `A branch do PR já está ativa neste diretório. Faça as alterações pedidas nos comentários — ` +
    `elas serão commitadas e enviadas automaticamente ao mesmo PR. Não rode git commit/push você mesmo.`
  );
}

const MAX_DIFF_CHARS = 80_000;
const MAX_PREV_REVIEW_CHARS = 4_000;
const MAX_COMMENT_CHARS = 1_500;

/** contexto de uma re-revisão: a revisão anterior + a discussão desde então */
export interface ReviewHistory {
  previousReview: string | null;
  discussion: ReviewComment[];
}

/**
 * Prompt da tarefa de code review: diff + contexto do PR + template de saída.
 * Com `history` (re-revisão), acrescenta a revisão anterior e a discussão
 * humana para o modelo revisar o PR atualizado sem repetir pontos resolvidos.
 */
export function buildPrReviewPrompt(
  task: Pick<TaskRow, "prompt">,
  pr: PrOverview,
  history?: ReviewHistory
): string {
  const diff =
    pr.diff.length > MAX_DIFF_CHARS
      ? `${pr.diff.slice(0, MAX_DIFF_CHARS)}\n\n[... diff truncado em ${MAX_DIFF_CHARS} caracteres — abra os arquivos no diretório para ver o restante]`
      : pr.diff;
  const extras = task.prompt?.trim() || "(nenhuma)";

  const intro = history
    ? `Você é um revisor de código experiente e já revisou este Pull Request antes. ` +
      `O autor pode ter feito ajustes desde então — o diff abaixo é o estado ATUAL do PR. ` +
      `Faça uma revisão completa desse estado atual.\n`
    : `Você é um revisor de código experiente. Faça o code review do Pull Request abaixo.\n`;

  let historyBlock = "";
  if (history) {
    if (history.previousReview) {
      const prev =
        history.previousReview.length > MAX_PREV_REVIEW_CHARS
          ? `${history.previousReview.slice(0, MAX_PREV_REVIEW_CHARS)}\n[...]`
          : history.previousReview;
      historyBlock += `[Sua revisão anterior]\n${prev}\n\n`;
    }
    if (history.discussion.length > 0) {
      const list = history.discussion
        .map((c) => {
          const loc = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
          const body =
            c.body.length > MAX_COMMENT_CHARS ? `${c.body.slice(0, MAX_COMMENT_CHARS)} […]` : c.body;
          return `- @${c.author}${loc}: ${body}`;
        })
        .join("\n");
      historyBlock += `[Discussão desde a sua última revisão]\n${list}\n\n`;
    }
    historyBlock +=
      `Confira no diff/arquivos se cada ponto que você levantou antes ainda se aplica: ` +
      `NÃO repita pontos que já foram resolvidos. Leve em conta a discussão acima e ` +
      `aponte o que permanece pendente e o que for novo.\n\n`;
  }

  return (
    intro +
    `O código do PR já está checkado neste diretório (branch ${pr.headRefName}) — abra os arquivos ` +
    `que precisar para entender o contexto além do diff. NÃO modifique nenhum arquivo; ` +
    `sua única saída é o texto do review, em Markdown.\n\n` +
    `[Pull Request]\nTítulo: ${pr.title}\nAutor: @${pr.author}\n` +
    `Branches: ${pr.baseRefName} ← ${pr.headRefName}\n` +
    `Alterações: ${pr.changedFiles} arquivo(s), +${pr.additions}/-${pr.deletions}\n` +
    `Descrição:\n${pr.body.trim() || "(sem descrição)"}\n\n` +
    `[Instruções extras do solicitante]\n${extras}\n\n` +
    historyBlock +
    `Revise TODAS as mudanças por completo numa única passada — não pare nos primeiros ` +
    `achados. Liste de uma vez todos os problemas que encontrar, para evitar rodadas de revisão adicionais.\n\n` +
    `[Diff]\n${diff}\n\n` +
    `[Formato da resposta — siga exatamente]\n` +
    `## Resumo\n(2 a 4 frases: o que o PR faz e sua avaliação geral)\n\n` +
    `## Problemas\n(lista por severidade — 🔴 crítico, 🟡 atenção, 🔵 sugestão — cada item com \`arquivo:linha\` ` +
    `e explicação; se não encontrar problemas, diga explicitamente)\n\n` +
    `## Sugestões\n(melhorias opcionais, se houver)\n\n` +
    `Não inclua veredito de aprovação/reprovação — essa decisão é humana.`
  );
}

const MAX_LOG_BYTES = 2_000_000;

/** taskId currently running per provider (concurrency = 1 per provider). */
const running = new Map<ProviderId, number>();
/** Providers blocked after a rate-limit error, until the given epoch ms. */
const blockedUntil = new Map<ProviderId, number>();

export function isRunning(provider: ProviderId): boolean {
  return running.has(provider);
}

export function isBlocked(provider: ProviderId): boolean {
  const until = blockedUntil.get(provider);
  if (!until) return false;
  if (Date.now() > until) {
    blockedUntil.delete(provider);
    return false;
  }
  return true;
}

export function blockedInfo(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, until] of blockedUntil) {
    if (Date.now() <= until) out[p] = new Date(until).toISOString();
  }
  return out;
}

function looksRateLimited(output: string): boolean {
  return /usage limit reached|rate limit|limit reached|status 429|\b429\b/i.test(
    output
  );
}

interface ClaudeEnvelope {
  type: string;
  is_error: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface RunUsage {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Custo/tokens de UMA rodada da IA.
 * - Claude: do envelope JSON no stdout (custo em US$ + tokens de entrada/saída).
 * - Codex: do "tokens used" no stderr — só um total, sem split nem custo (a
 *   assinatura é valor fixo). Guardamos o total em tokensOut.
 */
export function extractRunUsage(
  providerId: ProviderId,
  run: { stdout: string; stderr: string }
): RunUsage | null {
  if (providerId === "codex") {
    const total = parseCodexTokens(run.stderr);
    return total === null ? null : { costUsd: 0, tokensIn: 0, tokensOut: total };
  }
  const env = parseClaudeEnvelope(run.stdout);
  if (!env) return null;
  const u = env.usage ?? {};
  const usage: RunUsage = {
    costUsd: env.total_cost_usd ?? 0,
    tokensIn:
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0),
    tokensOut: u.output_tokens ?? 0,
  };
  if (usage.costUsd === 0 && usage.tokensIn === 0 && usage.tokensOut === 0) return null;
  return usage;
}

function sumUsage(a: RunUsage | null, b: RunUsage | null): RunUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    costUsd: a.costUsd + b.costUsd,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
  };
}

/** Parse the --output-format json envelope from Claude's stdout, if present. */
function parseClaudeEnvelope(stdout: string): ClaudeEnvelope | null {
  const candidates = [stdout.trim(), ...stdout.split("\n").map((l) => l.trim())];
  for (const c of candidates) {
    if (!c.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(c);
      if (parsed && parsed.type === "result" && typeof parsed.is_error === "boolean") {
        return parsed as ClaudeEnvelope;
      }
    } catch {
      // not this one — keep looking
    }
  }
  return null;
}

export async function runTask(taskId: number, forcedProvider?: ProviderId): Promise<void> {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) throw new Error(`Tarefa ${taskId} não existe`);
  if (task.status === "running") throw new Error(`Tarefa ${taskId} já está em execução`);

  const providerId: ProviderId =
    forcedProvider ?? (task.provider === "any" ? "claude" : task.provider);
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Provider desconhecido: ${providerId}`);
  if (running.has(providerId)) {
    throw new Error(`Provider ${providerId} já tem uma tarefa em execução`);
  }

  const setupIssue = await providerBlocker(providerId, provider);
  if (setupIssue) {
    failBeforeStart(task, task.kind === "pr_review" ? "pr_review" : "exec", providerId, setupIssue);
    return;
  }

  const settings = getSettings();
  const timeoutMs = Number(settings.task_timeout_min ?? "30") * 60_000;

  if (task.kind === "pr_review") {
    await runPrReview(task, providerId, provider, settings, timeoutMs);
    return;
  }

  const { cmd, args } = provider.buildCommand(task);

  // Entrega por PR: worktree preparada antes de marcar como running — falha
  // de preparação (repo inválido, sem remote, offline) nem conta tentativa.
  let worktree: PreparedWorktree | null = null;
  if (task.deliver_mode === "pr") {
    try {
      // pre-flight: falha em ~1s ANTES de gastar tokens se o gh não estiver pronto
      const blocker = await deliveryBlocker();
      if (blocker) throw new Error(blocker);
      const desired =
        task.work_branch?.trim() ||
        renderBranchTemplate(settings.branch_template ?? "feat/{slug}", task);
      if (!isValidBranchName(desired)) {
        throw new Error(`nome de branch inválido: "${desired}"`);
      }
      worktree = await prepareWorktree({
        repoPath: task.cwd,
        baseBranch: task.base_branch?.trim() || null,
        desiredBranch: desired,
        worktreesDir: join(settings.default_workspace_dir, "worktrees"),
        taskId: task.id,
      });
      // anexos moram no cwd original — copia para a IA enxergar na worktree
      const anexos = join(task.cwd, "anexos");
      if (parseAttachments(task).length > 0 && existsSync(anexos)) {
        cpSync(anexos, join(worktree.worktreePath, "anexos"), { recursive: true });
      }
    } catch (err) {
      failBeforeStart(
        task,
        "exec",
        providerId,
        `[entrega] preparação da worktree falhou: ${(err as Error).message}`
      );
      return;
    }
  }
  const execCwd = worktree?.worktreePath ?? task.cwd;

  if (!worktree) {
    try {
      mkdirSync(task.cwd, { recursive: true });
    } catch (err) {
      failBeforeStart(
        task,
        "exec",
        providerId,
        `[executor] diretório de trabalho inválido: ${(err as Error).message}`
      );
      return;
    }
  }

  running.set(providerId, taskId);
  db.prepare(
    // deliver_status zerado: re-execução não deve exibir desfecho antigo
    // (pr_url fica — um PR aberto em execução anterior continua existindo)
    "UPDATE tasks SET status = 'running', started_at = datetime('now'), executed_by = ?, attempts = attempts + 1, deliver_status = NULL WHERE id = ?"
  ).run(providerId, taskId);
  emit({ type: "task", taskId, status: "running" });
  const runId = startRun(task, "exec", providerId);

  const result = await executeWithVerification(
    task,
    providerId,
    [cmd, ...args].join(" "),
    buildPrompt(task),
    execCwd,
    timeoutMs
  );

  const status = finishTask(task, providerId, result, runId);
  if (worktree) {
    await deliver(task, providerId, worktree, status, result.stdout, runId);
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** desfecho da última rodada da IA (sem considerar a verificação) */
  succeeded: boolean;
  verifyFailed: boolean;
  verifyNotes: string[];
  /** custo/tokens somados de todas as rodadas desta execução */
  usage: RunUsage | null;
}

/**
 * Executa a IA e aplica o portão de qualidade: verificação → uma rodada de
 * correção com a saída do erro → re-verificação. Reutilizado pelo fluxo
 * normal e pelo atendimento de review.
 */
async function executeWithVerification(
  task: TaskRow,
  providerId: ProviderId,
  commandLine: string,
  initialPrompt: string,
  execCwd: string,
  timeoutMs: number
): Promise<ExecResult> {
  const first = await spawnProvider(commandLine, initialPrompt, execCwd, timeoutMs);

  let stdout = first.stdout;
  let stderr = first.stderr;
  let exitCode = first.exitCode;
  let timedOut = first.timedOut;
  let succeeded = runSucceeded(providerId, first);
  let usage = extractRunUsage(providerId, first);

  const verifyNotes: string[] = [];
  let verifyFailed = false;
  const verifyCmd = task.verify_cmd?.trim();
  if (verifyCmd && succeeded) {
    const verifyTimeout = Math.min(timeoutMs, 10 * 60_000);
    let check = await runVerifyCommand(verifyCmd, execCwd, verifyTimeout);
    if (check.code === 0) {
      verifyNotes.push(`[verificação] "${verifyCmd}" passou`);
    } else {
      verifyNotes.push(
        `[verificação] "${verifyCmd}" falhou (exit ${check.code}${check.timedOut ? ", timeout" : ""}) — devolvendo a saída para a IA corrigir`
      );
      emit({
        type: "scheduler",
        message: `Tarefa #${task.id}: verificação falhou — rodada de correção iniciada`,
      });
      const second = await spawnProvider(
        commandLine,
        buildVerifyFeedbackPrompt(task, verifyCmd, check.output),
        execCwd,
        timeoutMs
      );
      stdout += `\n\n===== rodada de correção (verificação) =====\n${second.stdout}`;
      if (second.stderr.trim()) {
        stderr += `\n===== rodada de correção =====\n${second.stderr}`;
      }
      exitCode = second.exitCode;
      timedOut = timedOut || second.timedOut;
      succeeded = runSucceeded(providerId, second);
      usage = sumUsage(usage, extractRunUsage(providerId, second));

      if (succeeded) {
        check = await runVerifyCommand(verifyCmd, execCwd, verifyTimeout);
        if (check.code === 0) {
          verifyNotes.push("[verificação] passou após a rodada de correção");
        } else {
          verifyFailed = true;
          verifyNotes.push(
            `[verificação] continuou falhando (exit ${check.code}) após a correção — tarefa marcada como falha`
          );
        }
      } else {
        verifyFailed = true;
        verifyNotes.push("[verificação] a rodada de correção não concluiu com sucesso");
      }
      if (verifyFailed) {
        verifyNotes.push(`[verificação] última saída:\n${check.output.slice(-2000)}`);
      }
    }
  }

  return { stdout, stderr, exitCode, timedOut, succeeded, verifyFailed, verifyNotes, usage };
}

/** soma custo/tokens da execução na tarefa (acumula entre tentativas e reviews) */
function accumulateUsage(taskId: number, usage: RunUsage | null) {
  if (!usage) return;
  db.prepare(
    `UPDATE tasks SET cost_usd = COALESCE(cost_usd, 0) + ?,
                      tokens_in = COALESCE(tokens_in, 0) + ?,
                      tokens_out = COALESCE(tokens_out, 0) + ?
     WHERE id = ?`
  ).run(usage.costUsd, usage.tokensIn, usage.tokensOut, taskId);
}

interface RunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnProvider(
  commandLine: string,
  promptText: string,
  cwd: string,
  timeoutMs: number
): Promise<RunOutcome> {
  const isWindows = process.platform === "win32";
  // chcp 65001: mensagens do próprio cmd.exe saem em UTF-8 (sem "n�o")
  if (isWindows) commandLine = `chcp 65001>nul & ${commandLine}`;
  return new Promise((resolve) => {
    // shell:true is required on Windows for npm .cmd shims; the command line is
    // built only from static strings — the prompt travels via stdin, never
    // through the shell. No POSIX, detached cria um process group próprio para
    // o kill de timeout alcançar a árvore inteira (shell + CLI).
    const child = spawn(commandLine, {
      cwd,
      shell: true,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      if (!child.pid) return;
      if (isWindows) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: true });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL"); // grupo inteiro
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_LOG_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_LOG_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
    });
    // sem este handler, um processo que morre antes de ler o stdin (ex.: CLI
    // não instalado) gera EPIPE não capturado e derruba o servidor
    child.stdin.on("error", (err) => {
      stderr += `\n[stdin error] ${err.message}`;
    });

    child.stdin.write(promptText);
    child.stdin.end();

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut: killedByTimeout });
    });
  });
}

/** mesma regra de sucesso do finishTask (envelope do claude ou exit 0) */
function runSucceeded(providerId: ProviderId, run: RunOutcome): boolean {
  if (run.timedOut) return false;
  const envelope = providerId === "claude" ? parseClaudeEnvelope(run.stdout) : null;
  return envelope ? envelope.is_error === false : run.exitCode === 0;
}

/**
 * Tarefa de code review de um PR alheio: worktree na branch do PR (leitura),
 * a IA produz o review em Markdown e o resultado vira comentário no PR.
 * Nunca commita/pusha nada — a worktree é descartada no fim.
 */
async function runPrReview(
  task: TaskRow,
  providerId: ProviderId,
  provider: Provider,
  settings: Record<string, string>,
  timeoutMs: number
): Promise<void> {
  let worktree: PreparedWorktree | null = null;
  let pr: PrOverview;
  try {
    if (!task.pr_url) throw new Error("tarefa de review sem URL de PR");
    if (!task.cwd) throw new Error("review de PR exige o clone local do repositório");
    const blocker = await deliveryBlocker();
    if (blocker) throw new Error(blocker);
    pr = await fetchPrForReview(task.cwd, task.pr_url);
    worktree = await prepareReviewWorktree({
      repoPath: task.cwd,
      branch: pr.headRefName,
      baseBranch: pr.baseRefName,
      worktreesDir: join(settings.default_workspace_dir, "worktrees"),
      taskId: task.id,
    });
  } catch (err) {
    failBeforeStart(
      task,
      "pr_review",
      providerId,
      `[review-pr] preparação falhou: ${(err as Error).message}`
    );
    return;
  }

  await executePrReview(task, providerId, provider, pr, worktree, undefined, timeoutMs);
}

/**
 * Núcleo do code review: marca a tarefa em execução, roda a IA na worktree de
 * leitura, publica o resultado como comentário no PR e descarta a worktree.
 * Compartilhado pela primeira revisão (runPrReview) e pela re-revisão
 * (startPrReReview) — a diferença é só o `history` no prompt.
 */
async function executePrReview(
  task: TaskRow,
  providerId: ProviderId,
  provider: Provider,
  pr: PrOverview,
  worktree: PreparedWorktree,
  history: ReviewHistory | undefined,
  timeoutMs: number
): Promise<void> {
  running.set(providerId, task.id);
  db.prepare(
    "UPDATE tasks SET status = 'running', started_at = datetime('now'), executed_by = ?, attempts = attempts + 1 WHERE id = ?"
  ).run(providerId, task.id);
  emit({ type: "task", taskId: task.id, status: "running" });
  const runId = startRun(task, "pr_review", providerId);

  const { cmd, args } = provider.buildCommand(task);
  const result = await executeWithVerification(
    task,
    providerId,
    [cmd, ...args].join(" "),
    buildPrReviewPrompt(task, pr, history),
    worktree.worktreePath,
    timeoutMs
  );
  const status = finishTask(task, providerId, result, runId);

  if (status === "done") {
    const review =
      providerId === "claude"
        ? parseClaudeEnvelope(result.stdout)?.result ?? result.stdout.trim()
        : result.stdout.trim();
    const body = `${review}\n\n---\n${REVIEW_COMMENT_MARKER}`;
    try {
      const commentUrl = await postPrComment(task.cwd, task.pr_url!, body);
      appendLog(
        task.id,
        `[review-pr] comentário publicado no PR: ${commentUrl ?? task.pr_url}`,
        runId
      );
    } catch (err) {
      appendLog(
        task.id,
        `[review-pr] o review foi gerado (acima), mas FALHOU ao comentar no PR: ${(err as Error).message}`,
        runId
      );
    }
    emit({ type: "task", taskId: task.id, status });
  }
  await removeWorktree(worktree);
}

/**
 * Re-revisão manual de uma tarefa de code review (botão "Revisar de novo"):
 * revisa o PR atualizado ciente da revisão anterior e da discussão desde
 * então. Valida e coleta o contexto de forma síncrona (erros viram resposta
 * da rota); a execução da IA continua em background.
 */
export async function startPrReReview(taskId: number): Promise<void> {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) throw new Error(`Tarefa ${taskId} não existe`);
  if (task.status === "running") throw new Error("tarefa já está em execução");
  if (task.kind !== "pr_review" || !task.pr_url) {
    throw new Error("a re-revisão é só para tarefas de review de PR");
  }
  if (!task.cwd) throw new Error("review de PR exige o clone local do repositório");

  const providerId: ProviderId = task.provider === "any" ? "claude" : task.provider;
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Provider desconhecido: ${providerId}`);
  if (running.has(providerId)) {
    throw new Error(`${providerId} já tem uma tarefa em execução`);
  }

  const setupIssue = await providerBlocker(providerId, provider);
  if (setupIssue) throw new Error(setupIssue.replaceAll("[setup] ", ""));
  const blocker = await deliveryBlocker();
  if (blocker) throw new Error(blocker);

  const settings = getSettings();
  const timeoutMs = Number(settings.task_timeout_min ?? "30") * 60_000;

  const { pr, previousReview, discussion } = await fetchReReviewContext(task.cwd, task.pr_url);
  const worktree = await prepareReviewWorktree({
    repoPath: task.cwd,
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    worktreesDir: join(settings.default_workspace_dir, "worktrees"),
    taskId: task.id,
  });
  emit({
    type: "scheduler",
    message: `Tarefa #${task.id}: re-revisando o PR (${discussion.length} comentário(s) novo(s) desde a última revisão)`,
  });

  // a rota já pode responder — o restante roda em background
  void executePrReview(
    task,
    providerId,
    provider,
    pr,
    worktree,
    { previousReview, discussion },
    timeoutMs
  ).catch((err) => {
    running.delete(providerId);
    appendLog(taskId, `[review-pr] erro inesperado: ${(err as Error).message}`);
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId);
    emit({ type: "task", taskId, status: "failed" });
  });
}

/**
 * Ciclo de review: busca os comentários novos do PR, re-executa a IA na
 * branch do PR e faz push (que atualiza o PR existente).
 *
 * Lança erro nas validações e na coleta (a rota devolve a mensagem ao
 * usuário); a execução em si continua em background após o retorno.
 */
export async function startReview(taskId: number): Promise<void> {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!task) throw new Error(`Tarefa ${taskId} não existe`);
  if (task.status === "running") throw new Error("tarefa já está em execução");
  if (task.deliver_mode !== "pr" || !task.pr_url) {
    throw new Error("a tarefa não tem PR aberto para atender");
  }

  const providerId: ProviderId = task.provider === "any" ? "claude" : task.provider;
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Provider desconhecido: ${providerId}`);
  if (running.has(providerId)) {
    throw new Error(`${providerId} já tem uma tarefa em execução`);
  }

  const setupIssue = await providerBlocker(providerId, provider);
  if (setupIssue) throw new Error(setupIssue.replaceAll("[setup] ", ""));

  const settings = getSettings();
  const timeoutMs = Number(settings.task_timeout_min ?? "30") * 60_000;

  const feedback = await fetchReviewFeedback(task.cwd, task.pr_url);
  const worktree = await prepareReviewWorktree({
    repoPath: task.cwd,
    branch: feedback.branch,
    baseBranch: feedback.baseBranch,
    worktreesDir: join(settings.default_workspace_dir, "worktrees"),
    taskId: task.id,
  });

  running.set(providerId, taskId);
  db.prepare(
    "UPDATE tasks SET status = 'running', started_at = datetime('now'), executed_by = ?, attempts = attempts + 1, deliver_status = NULL WHERE id = ?"
  ).run(providerId, taskId);
  emit({ type: "task", taskId, status: "running" });
  const runId = startRun(task, "review_attend", providerId);
  emit({
    type: "scheduler",
    message: `Tarefa #${task.id}: atendendo ${feedback.comments.length} comentário(s) do review na branch ${feedback.branch}`,
  });

  // a rota já pode responder — o restante roda em background
  void (async () => {
    const { cmd, args } = provider.buildCommand(task);
    const result = await executeWithVerification(
      task,
      providerId,
      [cmd, ...args].join(" "),
      buildReviewPrompt(task, feedback.comments),
      worktree.worktreePath,
      timeoutMs
    );
    const status = finishReview(task, providerId, result, runId);
    await deliver(task, providerId, worktree, status, result.stdout, runId);
  })().catch((err) => {
    running.delete(providerId);
    appendLog(taskId, `[review] erro inesperado: ${(err as Error).message}`, runId);
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId);
    db.prepare(
      "UPDATE task_runs SET status = 'failed', finished_at = datetime('now') WHERE id = ? AND status = 'running'"
    ).run(runId);
    emit({ type: "task", taskId, status: "failed" });
  });
}

/** desfecho do atendimento de review — sempre ANEXA ao log da tarefa (nunca sobrescreve) */
function finishReview(
  task: TaskRow,
  providerId: ProviderId,
  r: ExecResult,
  runId: number
): "done" | "failed" {
  running.delete(providerId);
  const status = r.succeeded && !r.timedOut && !r.verifyFailed ? "done" : "failed";

  let log = r.stdout;
  if (r.stderr.trim()) log += `\n[stderr]\n${r.stderr}`;
  if (r.verifyNotes.length > 0) log += `\n${r.verifyNotes.join("\n")}`;
  if (r.timedOut) log += "\n[executor] atendimento encerrado por timeout";

  db.prepare(
    "UPDATE tasks SET status = ?, finished_at = datetime('now'), exit_code = ?, output_log = COALESCE(output_log, '') || ? WHERE id = ?"
  ).run(
    status,
    r.exitCode,
    `\n\n===== atendimento de review =====\n${log}`.slice(0, MAX_LOG_BYTES),
    task.id
  );
  finishRun(runId, status, r.exitCode, log, r.usage);
  accumulateUsage(task.id, r.usage);
  emit({ type: "task", taskId: task.id, status });
  return status;
}

/** pós-execução da entrega por PR: commit/push/PR no sucesso, autópsia na falha */
async function deliver(
  task: TaskRow,
  providerId: ProviderId,
  worktree: PreparedWorktree,
  status: "done" | "failed" | "pending",
  stdout: string,
  runId: number
) {
  if (status !== "done") {
    appendLog(
      task.id,
      `[entrega] tarefa não concluída — worktree preservada para inspeção: ${worktree.worktreePath} (branch ${worktree.branch})`,
      runId
    );
    emit({ type: "task", taskId: task.id, status });
    return;
  }

  // anexos não fazem parte do trabalho — não devem entrar no PR
  rmSync(join(worktree.worktreePath, "anexos"), { recursive: true, force: true });

  const summary =
    providerId === "claude"
      ? parseClaudeEnvelope(stdout)?.result ?? null
      : stdout.slice(-3000) || null;
  const outcome = await deliverPullRequest(worktree, {
    title: task.title,
    body: buildPrBody(task, summary),
  });
  appendLog(task.id, outcome.notes.join("\n"), runId);
  db.prepare(
    "UPDATE tasks SET deliver_status = ?, pr_url = COALESCE(?, pr_url) WHERE id = ?"
  ).run(outcome.status, outcome.prUrl, task.id);
  emit({ type: "task", taskId: task.id, status });
}

function appendLog(taskId: number, text: string, runId?: number) {
  db.prepare(
    "UPDATE tasks SET output_log = COALESCE(output_log, '') || ? WHERE id = ?"
  ).run(`\n${text}`, taskId);
  if (runId !== undefined) {
    db.prepare(
      "UPDATE task_runs SET output_log = COALESCE(output_log, '') || ? WHERE id = ?"
    ).run(`\n${text}`, runId);
  }
}

type RunType = "exec" | "review_attend" | "pr_review";

/** abre um registro no histórico de execuções (status inicial: running) */
function startRun(task: TaskRow, runType: RunType, providerId: ProviderId): number {
  const r = db
    .prepare(
      "INSERT INTO task_runs (task_id, run_type, provider, model) VALUES (?, ?, ?, ?)"
    )
    .run(task.id, runType, providerId, task.model);
  return Number(r.lastInsertRowid);
}

/** fecha o registro do run com o desfecho e o log próprio dele */
function finishRun(
  runId: number,
  status: "done" | "failed" | "pending",
  exitCode: number | null,
  log: string,
  usage: RunUsage | null
) {
  db.prepare(
    `UPDATE task_runs SET status = ?, exit_code = ?, output_log = ?,
            cost_usd = ?, tokens_in = ?, tokens_out = ?, finished_at = datetime('now')
     WHERE id = ?`
  ).run(
    status,
    exitCode,
    log.slice(0, MAX_LOG_BYTES),
    usage?.costUsd ?? null,
    usage?.tokensIn ?? null,
    usage?.tokensOut ?? null,
    runId
  );
}

/** falha de preparação (antes da IA rodar): tarefa falha e o run registra o porquê */
function failBeforeStart(
  task: TaskRow,
  runType: RunType,
  providerId: ProviderId,
  message: string
) {
  db.prepare("UPDATE tasks SET status = 'failed', output_log = ? WHERE id = ?").run(
    message,
    task.id
  );
  db.prepare(
    `INSERT INTO task_runs (task_id, run_type, provider, model, status, output_log, finished_at)
     VALUES (?, ?, ?, ?, 'failed', ?, datetime('now'))`
  ).run(task.id, runType, providerId, task.model, message);
  emit({ type: "task", taskId: task.id, status: "failed" });
}

function finishTask(
  task: TaskRow,
  providerId: ProviderId,
  r: ExecResult,
  runId: number
): "done" | "failed" | "pending" {
  running.delete(providerId);

  let log = r.stdout + (r.stderr.trim() ? `\n[stderr]\n${r.stderr}` : "");
  if (r.verifyNotes.length > 0) log += `\n${r.verifyNotes.join("\n")}`;
  let status: "done" | "failed" | "pending";

  if (r.timedOut) {
    status = "failed";
    log += "\n[executor] tarefa encerrada por timeout";
  } else if (r.verifyFailed) {
    // verificação reprovada mesmo após a rodada de correção — sem nova
    // tentativa automática (repetir a tarefa inteira só queimaria tokens)
    status = "failed";
  } else if (r.succeeded) {
    status = "done";
  } else {
    // Only failures are checked for rate-limit markers — a successful run may
    // legitimately mention "rate limit" in its result text.
    const envelope = providerId === "claude" ? parseClaudeEnvelope(r.stdout) : null;
    const failureText = `${envelope?.result ?? ""}\n${r.stderr}\n${r.stdout.slice(-2000)}`;
    if (looksRateLimited(failureText)) {
      status = "pending";
      blockedUntil.set(providerId, Date.now() + 30 * 60_000);
      log += "\n[executor] rate limit detectado — tarefa devolvida à fila, provider bloqueado por 30 min";
    } else if (task.attempts + 1 < task.max_attempts) {
      status = "pending";
      log += `\n[executor] falha (exit ${r.exitCode}) — nova tentativa será feita (${task.attempts + 1}/${task.max_attempts})`;
    } else {
      status = "failed";
    }
  }

  db.prepare(
    `UPDATE tasks SET status = ?, finished_at = datetime('now'), exit_code = ?, output_log = ? WHERE id = ?`
  ).run(status, r.exitCode, log.slice(0, MAX_LOG_BYTES), task.id);
  finishRun(runId, status, r.exitCode, log, r.usage);
  accumulateUsage(task.id, r.usage);
  emit({ type: "task", taskId: task.id, status });
  return status;
}
