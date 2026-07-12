import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { codexProvider } from "../src/providers/codex.js";

// O CODEX_HOME aponta para test/fixtures/codex-home (ver setup.ts); o relógio
// é congelado perto do timestamp dos eventos da fixture para o cálculo de
// frescor/reset ser determinístico.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T12:30:00Z"));
});
afterAll(() => vi.useRealTimers());

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
