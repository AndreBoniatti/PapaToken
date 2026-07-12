import { describe, expect, it } from "vitest";
import { decide } from "../src/scheduler.js";
import type { UsageResult } from "../src/providers/types.js";

const NOW = Date.parse("2026-07-11T12:00:00Z");

const settings = {
  safety_ceiling_pct: "90",
  min_free_pct: "15",
  dispatch_window_min: "60",
  mode: "window",
};

function usage(opts: {
  sessionPct: number;
  resetsInMin?: number | null;
  weeklyPct?: number;
}): UsageResult {
  const resetsAt =
    opts.resetsInMin === null || opts.resetsInMin === undefined
      ? null
      : new Date(NOW + opts.resetsInMin * 60_000).toISOString();
  return {
    ok: true,
    windows: [
      { id: "session", usedPercent: opts.sessionPct, resetsAt },
      {
        id: "weekly",
        usedPercent: opts.weeklyPct ?? 10,
        resetsAt: new Date(NOW + 3 * 24 * 60 * 60_000).toISOString(),
      },
    ],
  };
}

const idle = { running: false, blocked: false, now: NOW };

describe("decide (algoritmo de despacho)", () => {
  it("não despacha sem dados de uso", () => {
    expect(decide({ ...idle, usage: undefined }, settings).dispatch).toBe(false);
    expect(
      decide({ ...idle, usage: { ok: false, windows: [], error: "x" } }, settings).dispatch
    ).toBe(false);
  });

  it("não despacha com o provider já executando ou bloqueado", () => {
    const u = usage({ sessionPct: 10, resetsInMin: 30 });
    expect(decide({ ...idle, usage: u, running: true }, settings)).toEqual({
      dispatch: false,
      reason: "já executando",
    });
    expect(decide({ ...idle, usage: u, blocked: true }, settings)).toEqual({
      dispatch: false,
      reason: "bloqueado por rate limit",
    });
  });

  it("respeita o teto de segurança na janela semanal", () => {
    const d = decide(
      { ...idle, usage: usage({ sessionPct: 10, resetsInMin: 30, weeklyPct: 92 }) },
      settings
    );
    expect(d.dispatch).toBe(false);
    expect(d.reason).toContain("semanal");
  });

  it("respeita o teto de segurança na janela de 5h (inclusive no limite exato)", () => {
    expect(
      decide({ ...idle, usage: usage({ sessionPct: 95, resetsInMin: 30 }) }, settings).dispatch
    ).toBe(false);
    expect(
      decide({ ...idle, usage: usage({ sessionPct: 90, resetsInMin: 30 }) }, settings).dispatch
    ).toBe(false);
  });

  it("não despacha quando a sobra até o teto é menor que o mínimo", () => {
    // teto 90 - uso 80 = 10% livres < mínimo de 15%
    const d = decide({ ...idle, usage: usage({ sessionPct: 80, resetsInMin: 30 }) }, settings);
    expect(d.dispatch).toBe(false);
    expect(d.reason).toContain("sobra");
  });

  it("modo window: despacha só perto do reset da sessão", () => {
    const perto = decide({ ...idle, usage: usage({ sessionPct: 40, resetsInMin: 45 }) }, settings);
    expect(perto.dispatch).toBe(true);

    const longe = decide({ ...idle, usage: usage({ sessionPct: 40, resetsInMin: 120 }) }, settings);
    expect(longe.dispatch).toBe(false);
    expect(longe.reason).toContain("fora da janela");
  });

  it("modo window: não despacha sem saber quando a janela reseta", () => {
    const d = decide({ ...idle, usage: usage({ sessionPct: 40, resetsInMin: null }) }, settings);
    expect(d.dispatch).toBe(false);
    expect(d.reason).toContain("reset");
  });

  it("modo aggressive: despacha sempre que houver sobra, mesmo longe do reset", () => {
    const d = decide(
      { ...idle, usage: usage({ sessionPct: 40, resetsInMin: 240 }) },
      { ...settings, mode: "aggressive" }
    );
    expect(d.dispatch).toBe(true);
  });
});
