import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyWindow, codexProvider, resetsAtIso } from "../src/providers/codex.js";
import { setSetting } from "../src/db.js";
import type { TaskRow } from "../src/providers/types.js";

// O CODEX_HOME aponta para test/fixtures/codex-home (ver setup.ts); o relógio
// é congelado perto do timestamp dos eventos da fixture para o cálculo de
// frescor/reset ser determinístico.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T12:30:00Z"));
});
afterAll(() => vi.useRealTimers());

describe("resetsAtIso", () => {
  const eventAt = new Date("2026-07-13T21:32:41Z");

  it("interpreta epoch em SEGUNDOS (formato atual do Codex) — não cai em 1970", () => {
    // era o bug: new Date(1784494551) tratava como ms e virava jan/1970
    const iso = resetsAtIso(1784494551, eventAt);
    expect(iso).toBe(new Date(1784494551 * 1000).toISOString());
    expect(new Date(iso!).getUTCFullYear()).toBe(2026);
  });

  it("aceita string ISO e string numérica", () => {
    expect(resetsAtIso("2026-07-16T12:00:00Z", eventAt)).toBe("2026-07-16T12:00:00.000Z");
    expect(resetsAtIso("1784494551", eventAt)).toBe(new Date(1784494551 * 1000).toISOString());
  });

  it("cai para resets_in_seconds quando não há resets_at, senão null", () => {
    expect(resetsAtIso(undefined, eventAt, 3600)).toBe("2026-07-13T22:32:41.000Z");
    expect(resetsAtIso(undefined, eventAt)).toBeNull();
  });
});

describe("classifyWindow", () => {
  it("5h → sessão, 7 dias → semanal, sem window_minutes → sessão", () => {
    expect(classifyWindow({ window_minutes: 300 })).toBe("session");
    expect(classifyWindow({ window_minutes: 10080 })).toBe("weekly");
    expect(classifyWindow({})).toBe("session");
  });
});

describe("buildCommand honra o codex_sandbox_mode", () => {
  const task = { id: 1, model: null, effort: null, attachments: "[]" } as TaskRow;

  it("danger-full-access: usa -s danger-full-access, sem config de network", () => {
    setSetting("codex_sandbox_mode", "danger-full-access");
    const { args } = codexProvider.buildCommand(task);
    expect(args).toContain("danger-full-access");
    expect(args.join(" ")).not.toContain("network_access");
  });

  it("workspace-write: usa -s workspace-write + network_access", () => {
    setSetting("codex_sandbox_mode", "workspace-write");
    const { args } = codexProvider.buildCommand(task);
    const s = args.join(" ");
    expect(s).toContain("-s workspace-write");
    expect(s).toContain("sandbox_workspace_write.network_access=true");
  });

  it("review de PR: sempre read-only, mesmo com danger-full-access configurado", () => {
    setSetting("codex_sandbox_mode", "danger-full-access");
    const review = { ...task, kind: "pr_review" } as TaskRow;
    const { args } = codexProvider.buildCommand(review);
    expect(args.join(" ")).toContain("-s read-only");
  });
});

describe("leitura de uso do Codex a partir dos JSONL de sessão", () => {
  it("usa o último rate_limits válido, ignorando linhas malformadas", async () => {
    const usage = await codexProvider.getUsage();
    expect(usage.ok).toBe(true);

    // último evento válido: primary 37.5% às 12:00, reset em 7200s
    const session = usage.windows.find((w) => w.id === "session");
    expect(session?.usedPercent).toBe(37.5);
    expect(session?.resetsAt).toBe("2026-07-11T14:00:00.000Z");
    expect(session?.estimated).toBe(true);

    const weekly = usage.windows.find((w) => w.id === "weekly");
    expect(weekly?.usedPercent).toBe(12.25);
    expect(weekly?.resetsAt).toBe("2026-07-16T12:00:00.000Z");
  });

  it("zera a janela de sessão quando o dado é mais velho que a própria janela", async () => {
    // 6h30 depois do evento (> 300 min) e além do TTL do cache interno
    vi.setSystemTime(new Date("2026-07-11T18:30:00Z"));
    const usage = await codexProvider.getUsage();
    expect(usage.ok).toBe(true);
    expect(usage.windows.find((w) => w.id === "session")?.usedPercent).toBe(0);
    // a semanal continua fazendo sentido e é preservada
    expect(usage.windows.find((w) => w.id === "weekly")?.usedPercent).toBe(12.25);
  });
});
