import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, getSettings } from "./db.js";
import { emit } from "./events.js";
import {
  buildPrBody,
  deliverPullRequest,
  deliveryBlocker,
  fetchReviewFeedback,
  isValidBranchName,
  prepareReviewWorktree,
  prepareWorktree,
  renderBranchTemplate,
} from "./git.js";
import type { PreparedWorktree, ReviewComment } from "./git.js";
import { getProvider } from "./providers/index.js";
import { parseAttachments } from "./providers/types.js";
import type { ProviderId, TaskRow } from "./providers/types.js";
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
 * Custo/tokens de UMA rodada da IA, extraídos do envelope JSON do Claude.
 * O Codex não expõe custo no stdout do exec — retorna null (a UI mostra "—").
 */
export function extractRunUsage(providerId: ProviderId, stdout: string): RunUsage | null {
  if (providerId !== "claude") return null;
  const env = parseClaudeEnvelope(stdout);
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

  const settings = getSettings();
  const timeoutMs = Number(settings.task_timeout_min ?? "30") * 60_000;
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
      db.prepare(
        "UPDATE tasks SET status = 'failed', output_log = ? WHERE id = ?"
      ).run(`[entrega] preparação da worktree falhou: ${(err as Error).message}`, taskId);
      emit({ type: "task", taskId, status: "failed" });
      return;
    }
  }
  const execCwd = worktree?.worktreePath ?? task.cwd;

  if (!worktree) {
    try {
      mkdirSync(task.cwd, { recursive: true });
    } catch (err) {
      db.prepare(
        "UPDATE tasks SET status = 'failed', output_log = ? WHERE id = ?"
      ).run(`[executor] diretório de trabalho inválido: ${(err as Error).message}`, taskId);
      emit({ type: "task", taskId, status: "failed" });
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

  const result = await executeWithVerification(
    task,
    providerId,
    [cmd, ...args].join(" "),
    buildPrompt(task),
    execCwd,
    timeoutMs
  );

  const status = finishTask(task, providerId, result);
  if (worktree) {
    await deliver(task, providerId, worktree, status, result.stdout);
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
  let usage = extractRunUsage(providerId, first.stdout);

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
      usage = sumUsage(usage, extractRunUsage(providerId, second.stdout));

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
    const status = finishReview(task, providerId, result);
    await deliver(task, providerId, worktree, status, result.stdout);
  })().catch((err) => {
    running.delete(providerId);
    appendLog(taskId, `[review] erro inesperado: ${(err as Error).message}`);
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId);
    emit({ type: "task", taskId, status: "failed" });
  });
}

/** desfecho do atendimento de review — sempre ANEXA ao log (nunca sobrescreve) */
function finishReview(
  task: TaskRow,
  providerId: ProviderId,
  r: ExecResult
): "done" | "failed" {
  running.delete(providerId);
  const status = r.succeeded && !r.timedOut && !r.verifyFailed ? "done" : "failed";

  let section = `\n\n===== atendimento de review =====\n${r.stdout}`;
  if (r.stderr.trim()) section += `\n[stderr]\n${r.stderr}`;
  if (r.verifyNotes.length > 0) section += `\n${r.verifyNotes.join("\n")}`;
  if (r.timedOut) section += "\n[executor] atendimento encerrado por timeout";

  db.prepare(
    "UPDATE tasks SET status = ?, finished_at = datetime('now'), exit_code = ?, output_log = COALESCE(output_log, '') || ? WHERE id = ?"
  ).run(status, r.exitCode, section.slice(0, MAX_LOG_BYTES), task.id);
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
  stdout: string
) {
  if (status !== "done") {
    appendLog(
      task.id,
      `[entrega] tarefa não concluída — worktree preservada para inspeção: ${worktree.worktreePath} (branch ${worktree.branch})`
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
  appendLog(task.id, outcome.notes.join("\n"));
  db.prepare(
    "UPDATE tasks SET deliver_status = ?, pr_url = COALESCE(?, pr_url) WHERE id = ?"
  ).run(outcome.status, outcome.prUrl, task.id);
  emit({ type: "task", taskId: task.id, status });
}

function appendLog(taskId: number, text: string) {
  db.prepare(
    "UPDATE tasks SET output_log = COALESCE(output_log, '') || ? WHERE id = ?"
  ).run(`\n${text}`, taskId);
}

function finishTask(
  task: TaskRow,
  providerId: ProviderId,
  r: ExecResult
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
  accumulateUsage(task.id, r.usage);
  emit({ type: "task", taskId: task.id, status });
  return status;
}
