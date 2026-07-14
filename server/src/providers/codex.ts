import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSettings } from "../db.js";
import { parseAttachments } from "./types.js";
import type { Provider, TaskRow, UsageResult, UsageWindow } from "./types.js";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const SESSIONS_DIR = join(CODEX_HOME, "sessions");
const CACHE_TTL_MS = 60_000;

/**
 * Total de tokens de uma execução do `codex exec`, impresso no stderr como
 * "tokens used\n55.909" (ou "tokens used: 55,909"). Diferente do Claude, o
 * Codex dá só um total, sem separar entrada/saída nem custo. Pega a última
 * ocorrência (o total final da sessão) e ignora separadores de milhar.
 */
export function parseCodexTokens(stderr: string): number | null {
  const matches = [...stderr.matchAll(/tokens used[:\s]*([\d.,]+)/gi)];
  if (matches.length === 0) return null;
  const digits = matches[matches.length - 1][1].replace(/[.,]/g, "");
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Newest .jsonl session files, most recent first. */
function latestSessionFiles(limit = 5): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files: { path: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) {
        files.push({ path: p, mtime: statSync(p).mtimeMs });
      }
    }
  };
  walk(SESSIONS_DIR);
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => f.path);
}

interface RateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_in_seconds?: number;
  /** ISO string em versões antigas; epoch (segundos) nas atuais do Codex */
  resets_at?: string | number;
}

/**
 * Normaliza o `resets_at` do Codex para ISO. O campo pode vir como:
 * - epoch em SEGUNDOS (Codex atual, ex.: 1784494551) — o caso que quebrava,
 *   pois `new Date(n)` interpreta número como MILISSEGUNDOS e cai em 1970;
 * - epoch em milissegundos; ou string ISO (versões antigas).
 * Sem `resets_at`, cai para `resets_in_seconds` relativo ao evento.
 */
export function resetsAtIso(
  value: string | number | undefined | null,
  eventAt: Date,
  resetsInSeconds?: number
): string | null {
  if (value !== undefined && value !== null && value !== "") {
    let ms: number | null = null;
    if (typeof value === "number" || /^\d+$/.test(String(value))) {
      const n = Number(value);
      // heurística: < 1e12 ⇒ segundos (qualquer data moderna); senão já é ms
      ms = n < 1e12 ? n * 1000 : n;
    } else {
      const t = new Date(value).getTime();
      ms = Number.isNaN(t) ? null : t;
    }
    if (ms !== null && !Number.isNaN(new Date(ms).getTime())) {
      return new Date(ms).toISOString();
    }
  }
  if (typeof resetsInSeconds === "number") {
    return new Date(eventAt.getTime() + resetsInSeconds * 1000).toISOString();
  }
  return null;
}

/** classifica a janela pelo tamanho: ~5h = sessão, ~7 dias = semanal.
 *  O Codex nem sempre põe a 5h em `primary` e a semanal em `secondary`. */
export function classifyWindow(w: RateLimitWindow): UsageWindow["id"] {
  // 300 (5h) « 1440 (1 dia) « 10080 (7 dias); sem o dado, assume sessão
  return typeof w.window_minutes === "number" && w.window_minutes >= 1440
    ? "weekly"
    : "session";
}

interface RateLimits {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

/** Scan a session file bottom-up for the last rate_limits payload. */
function lastRateLimits(path: string): { limits: RateLimits; at: Date } | null {
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("rate_limits")) continue;
    try {
      const obj = JSON.parse(lines[i]);
      const payload = obj.payload ?? obj;
      const limits: RateLimits | undefined =
        payload.rate_limits ?? payload.info?.rate_limits;
      if (limits && (limits.primary || limits.secondary)) {
        const at = obj.timestamp ? new Date(obj.timestamp) : new Date(statSync(path).mtimeMs);
        return { limits, at };
      }
    } catch {
      // malformed line — keep scanning
    }
  }
  return null;
}

function toWindow(
  id: UsageWindow["id"],
  w: RateLimitWindow,
  eventAt: Date
): UsageWindow {
  return {
    id,
    usedPercent: w.used_percent ?? 0,
    resetsAt: resetsAtIso(w.resets_at, eventAt, w.resets_in_seconds),
    estimated: true,
  };
}

let cache: { at: number; result: UsageResult } | null = null;

function readUsageFromSessions(): UsageResult {
  const files = latestSessionFiles();
  if (files.length === 0) {
    return {
      ok: false,
      windows: [],
      error:
        "Sem dados de uso do Codex nesta máquina. Instale (npm install -g @openai/codex), rode \"codex login\" e use o Codex uma vez — o uso é lido das sessões locais.",
    };
  }
  for (const file of files) {
    const found = lastRateLimits(file);
    if (!found) continue;
    const windows: UsageWindow[] = [];
    // classifica cada janela pelo próprio window_minutes (sessão vs semanal),
    // pois o Codex nem sempre põe a 5h em primary e a semanal em secondary
    for (const w of [found.limits.primary, found.limits.secondary]) {
      if (!w) continue;
      const id = classifyWindow(w);
      if (windows.some((x) => x.id === id)) continue; // não duplica a mesma janela
      windows.push(toWindow(id, w, found.at));
    }
    if (windows.length > 0) {
      // Data is only as fresh as the last Codex interaction — flag staleness.
      const ageMin = (Date.now() - found.at.getTime()) / 60_000;
      if (ageMin > 300) {
        // older than a full 5h window: percentages no longer meaningful
        return {
          ok: true,
          windows: windows.map((w) => ({ ...w, usedPercent: w.id === "session" ? 0 : w.usedPercent })),
        };
      }
      return { ok: true, windows };
    }
  }
  return {
    ok: false,
    windows: [],
    error: "Nenhum dado de rate limit encontrado nas sessões recentes do Codex.",
  };
}

export const codexProvider: Provider = {
  id: "codex",

  async isAvailable() {
    return existsSync(join(CODEX_HOME, "auth.json"));
  },

  async getUsage() {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
    try {
      const result = readUsageFromSessions();
      cache = { at: Date.now(), result };
      return result;
    } catch (err) {
      const result: UsageResult = {
        ok: false,
        windows: [],
        error: `Falha ao ler sessões do Codex: ${(err as Error).message}`,
      };
      cache = { at: Date.now(), result };
      return result;
    }
  },

  buildCommand(task: TaskRow) {
    // Prompt via stdin ("-"). Sandbox configurável (ver setting codex_sandbox_mode):
    // - workspace-write: edita o cwd + rede (mas no Windows vira read-only);
    // - danger-full-access: sem sandbox, roda qualquer comando (necessário no
    //   Windows para escrever arquivo; equivale ao bypassPermissions do Claude).
    // Tarefas de review de PR são leitura pura — read-only sempre (funciona
    // inclusive no Windows e é o modo mais seguro).
    const mode =
      task.kind === "pr_review"
        ? "read-only"
        : getSettings().codex_sandbox_mode === "danger-full-access"
          ? "danger-full-access"
          : "workspace-write";
    const args = ["exec", "-s", mode];
    if (mode === "workspace-write") {
      // network_access só se aplica ao sandbox workspace-write
      args.push("-c", "sandbox_workspace_write.network_access=true");
    }
    args.push("--skip-git-repo-check");
    if (task.model) args.push("-m", task.model);
    if (task.effort) args.push("-c", `model_reasoning_effort=${task.effort}`);
    // imagens anexadas entram no prompt inicial via -i (caminho relativo ao cwd)
    for (const f of parseAttachments(task)) {
      if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(f)) args.push("-i", `"anexos/${f}"`);
    }
    args.push("-");
    return { cmd: "codex", args };
  },
};
