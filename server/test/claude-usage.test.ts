import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUsageResponse } from "../src/providers/claude.js";
import type { OauthUsageResponse } from "../src/providers/claude.js";

function fixture(name: string): OauthUsageResponse {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
  );
}

describe("parse da resposta do endpoint OAuth de uso do Claude", () => {
  it("extrai a sessão de limits[] e pega a pior das janelas semanais", () => {
    const result = parseUsageResponse(fixture("oauth-usage.json"));
    expect(result.ok).toBe(true);

    const session = result.windows.find((w) => w.id === "session");
    expect(session).toEqual({
      id: "session",
      usedPercent: 42,
      resetsAt: "2026-07-11T15:00:00Z",
    });

    // há duas entradas weekly (13% e 27.5%) — vale a pior
    const weekly = result.windows.find((w) => w.id === "weekly");
    expect(weekly?.usedPercent).toBe(27.5);
  });

  it("cai para five_hour quando limits[] não existe", () => {
    const result = parseUsageResponse(fixture("oauth-usage-five-hour.json"));
    expect(result.ok).toBe(true);
    expect(result.windows).toEqual([
      { id: "session", usedPercent: 61.2, resetsAt: "2026-07-11T16:30:00Z" },
    ]);
  });

  it("sinaliza mudança de formato quando nenhuma janela é reconhecida", () => {
    const result = parseUsageResponse({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("formato mudou");
  });
});
