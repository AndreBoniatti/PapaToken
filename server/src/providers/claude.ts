import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSettings } from "../db.js";
import type { Provider, TaskRow, UsageResult, UsageWindow } from "./types.js";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 180_000; // endpoint rate-limits aggressive polling

interface OAuthCreds {
  accessToken: string;
  expiresAt: number; // epoch ms
  subscriptionType?: string;
}

function readCreds(): OAuthCreds | null {
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
    const oauth = raw.claudeAiOauth ?? raw;
    if (!oauth?.accessToken) return null;
    return oauth as OAuthCreds;
  } catch {
    return null;
  }
}

/**
 * Response shape of the (undocumented) OAuth usage endpoint — the same data
 * that powers Claude Code's /usage. Verified against the live endpoint:
 * `limits` carries one entry per window with group "session" | "weekly".
 */
interface OauthUsageResponse {
  five_hour?: { utilization: number; resets_at: string | null } | null;
  limits?: {
    kind: string;
    group: "session" | "weekly" | string;
    percent: number;
    resets_at: string | null;
    is_active: boolean;
  }[];
}

let cache: { at: number; result: UsageResult } | null = null;

async function fetchUsage(): Promise<UsageResult> {
  const creds = readCreds();
  if (!creds) {
    return { ok: false, windows: [], error: "Credenciais do Claude Code não encontradas — faça login no Claude Code." };
  }
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    return { ok: false, windows: [], error: "Token OAuth expirado — abra o Claude Code para renovar." };
  }

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-cli/2.1.205 (external, cli)",
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    return { ok: false, windows: [], error: "Não autorizado (401) — abra o Claude Code para renovar o login." };
  }
  if (res.status === 429) {
    return { ok: false, windows: [], error: "Endpoint de uso limitou as consultas (429) — aguardando." };
  }
  if (!res.ok) {
    return { ok: false, windows: [], error: `Endpoint de uso respondeu ${res.status}.` };
  }

  const data = (await res.json()) as OauthUsageResponse;
  const windows: UsageWindow[] = [];

  const session = data.limits?.find((l) => l.group === "session");
  if (session) {
    windows.push({ id: "session", usedPercent: session.percent, resetsAt: session.resets_at });
  } else if (data.five_hour) {
    windows.push({
      id: "session",
      usedPercent: data.five_hour.utilization,
      resetsAt: data.five_hour.resets_at,
    });
  }

  // Weekly may appear as several scoped entries (per model) — take the worst.
  const weeklies = (data.limits ?? []).filter((l) => l.group === "weekly");
  if (weeklies.length > 0) {
    const worst = weeklies.reduce((a, b) => (b.percent > a.percent ? b : a));
    windows.push({ id: "weekly", usedPercent: worst.percent, resetsAt: worst.resets_at });
  }

  if (windows.length === 0) {
    return { ok: false, windows: [], error: "Resposta do endpoint de uso sem janelas reconhecíveis (formato mudou?)." };
  }
  return { ok: true, windows };
}

export const claudeProvider: Provider = {
  id: "claude",

  async isAvailable() {
    return readCreds() !== null;
  },

  async getUsage() {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
    try {
      const result = await fetchUsage();
      // don't cache transient failures for the full TTL
      cache = { at: result.ok ? Date.now() : Date.now() - CACHE_TTL_MS + 30_000, result };
      return result;
    } catch (err) {
      const result: UsageResult = {
        ok: false,
        windows: [],
        error: `Falha ao consultar uso: ${(err as Error).message}`,
      };
      cache = { at: Date.now() - CACHE_TTL_MS + 30_000, result };
      return result;
    }
  },

  buildCommand(_task: TaskRow) {
    // Prompt is delivered via stdin (see executor) to avoid shell-quoting issues.
    const autonomous =
      getSettings().claude_permission_mode === "bypassPermissions";
    return {
      cmd: "claude",
      args: autonomous
        ? ["-p", "--output-format", "json", "--dangerously-skip-permissions"]
        : ["-p", "--output-format", "json", "--permission-mode", "acceptEdits"],
    };
  },
};
