import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, getSettings } from "./db.js";
import { emit } from "./events.js";
import {
  buildPrBody,
  deliverPullRequest,
  deliveryBlocker,
  isValidBranchName,
  prepareWorktree,
  renderBranchTemplate,
} from "./git.js";
import type { PreparedWorktree } from "./git.js";
import { getProvider } from "./providers/index.js";
import { parseAttachments } from "./providers/types.js";
import type { ProviderId, TaskRow } from "./providers/types.js";

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

  let stdout = "";
  let stderr = "";

  const isWindows = process.platform === "win32";

  const { exitCode, timedOut } = await new Promise<{
    exitCode: number | null;
    timedOut: boolean;
  }>((resolve) => {
    // shell:true is required on Windows for npm .cmd shims; the command line is
    // built only from static strings — the prompt travels via stdin, never
    // through the shell. No POSIX, detached cria um process group próprio para
    // o kill de timeout alcançar a árvore inteira (shell + CLI).
    const child = spawn([cmd, ...args].join(" "), {
      cwd: execCwd,
      shell: true,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

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

    child.stdin.write(buildPrompt(task));
    child.stdin.end();

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: killedByTimeout });
    });
  });

  const status = finishTask(task, providerId, exitCode, stdout, stderr, timedOut);
  if (worktree) {
    await deliver(task, providerId, worktree, status, stdout);
  }
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
  exitCode: number | null,
  stdout: string,
  stderr: string,
  timedOut: boolean
): "done" | "failed" | "pending" {
  running.delete(providerId);

  let log = stdout + (stderr.trim() ? `\n[stderr]\n${stderr}` : "");
  let status: "done" | "failed" | "pending";

  const envelope = providerId === "claude" ? parseClaudeEnvelope(stdout) : null;
  const succeeded = envelope ? envelope.is_error === false : exitCode === 0;

  if (timedOut) {
    status = "failed";
    log += "\n[executor] tarefa encerrada por timeout";
  } else if (succeeded) {
    status = "done";
  } else {
    // Only failures are checked for rate-limit markers — a successful run may
    // legitimately mention "rate limit" in its result text.
    const failureText = `${envelope?.result ?? ""}\n${stderr}\n${stdout.slice(-2000)}`;
    if (looksRateLimited(failureText)) {
      status = "pending";
      blockedUntil.set(providerId, Date.now() + 30 * 60_000);
      log += "\n[executor] rate limit detectado — tarefa devolvida à fila, provider bloqueado por 30 min";
    } else if (task.attempts + 1 < task.max_attempts) {
      status = "pending";
      log += `\n[executor] falha (exit ${exitCode}) — nova tentativa será feita (${task.attempts + 1}/${task.max_attempts})`;
    } else {
      status = "failed";
    }
  }

  db.prepare(
    `UPDATE tasks SET status = ?, finished_at = datetime('now'), exit_code = ?, output_log = ? WHERE id = ?`
  ).run(status, exitCode, log.slice(0, MAX_LOG_BYTES), task.id);
  emit({ type: "task", taskId: task.id, status });
  return status;
}
