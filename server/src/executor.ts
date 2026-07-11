import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { db, getSettings } from "./db.js";
import { emit } from "./events.js";
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

  try {
    mkdirSync(task.cwd, { recursive: true });
  } catch (err) {
    db.prepare(
      "UPDATE tasks SET status = 'failed', output_log = ? WHERE id = ?"
    ).run(`[executor] diretório de trabalho inválido: ${(err as Error).message}`, taskId);
    emit({ type: "task", taskId, status: "failed" });
    return;
  }

  running.set(providerId, taskId);
  db.prepare(
    "UPDATE tasks SET status = 'running', started_at = datetime('now'), executed_by = ?, attempts = attempts + 1 WHERE id = ?"
  ).run(providerId, taskId);
  emit({ type: "task", taskId, status: "running" });

  let stdout = "";
  let stderr = "";

  const isWindows = process.platform === "win32";

  await new Promise<void>((resolve) => {
    // shell:true is required on Windows for npm .cmd shims; the command line is
    // built only from static strings — the prompt travels via stdin, never
    // through the shell. No POSIX, detached cria um process group próprio para
    // o kill de timeout alcançar a árvore inteira (shell + CLI).
    const child = spawn([cmd, ...args].join(" "), {
      cwd: task.cwd,
      shell: true,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
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
      finishTask(task, providerId, code, stdout, stderr, timedOut);
      resolve();
    });
  });
}

function finishTask(
  task: TaskRow,
  providerId: ProviderId,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  timedOut: boolean
) {
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
}
