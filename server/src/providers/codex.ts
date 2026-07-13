import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseAttachments } from "./types.js";
import type { Provider, TaskRow, UsageResult, UsageWindow } from "./types.js";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const SESSIONS_DIR = join(CODEX_HOME, "sessions");
const CACHE_TTL_MS = 60_000;

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
  resets_at?: string;
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
  let resetsAt: string | null = null;
  if (w.resets_at) resetsAt = new Date(w.resets_at).toISOString();
  else if (typeof w.resets_in_seconds === "number") {
    resetsAt = new Date(eventAt.getTime() + w.resets_in_seconds * 1000).toISOString();
  }
  return { id, usedPercent: w.used_percent ?? 0, resetsAt, estimated: true };
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
    if (found.limits.primary) windows.push(toWindow("session", found.limits.primary, found.at));
    if (found.limits.secondary) windows.push(toWindow("weekly", found.limits.secondary, found.at));
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
    // Prompt via stdin ("-"); sandbox workspace-write = pode editar o cwd.
    // network_access permite buscas/downloads dentro do sandbox.
    const args = [
      "exec",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--skip-git-repo-check",
    ];
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
