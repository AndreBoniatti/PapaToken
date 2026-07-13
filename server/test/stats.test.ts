import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { extractRunUsage } from "../src/executor.js";

const envelope = JSON.stringify({
  type: "result",
  is_error: false,
  result: "feito",
  total_cost_usd: 0.0219705,
  usage: {
    input_tokens: 18,
    output_tokens: 563,
    cache_creation_input_tokens: 7341,
    cache_read_input_tokens: 37645,
  },
});

describe("extractRunUsage", () => {
  it("extrai custo e soma tokens de entrada (diretos + cache) do envelope", () => {
    const usage = extractRunUsage("claude", `lixo antes\n${envelope}\n`);
    expect(usage).toEqual({
      costUsd: 0.0219705,
      tokensIn: 18 + 7341 + 37645,
      tokensOut: 563,
    });
  });

  it("retorna null para codex e para saída sem envelope", () => {
    expect(extractRunUsage("codex", envelope)).toBeNull();
    expect(extractRunUsage("claude", "saída qualquer sem json")).toBeNull();
  });
});

describe("GET /api/stats", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("agrega custo/tokens no mês e no total", async () => {
    const create = async (title: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { title, prompt: "p" },
        })
      ).json();
    const recente = await create("stats recente");
    const antiga = await create("stats antiga");

    db.prepare(
      "UPDATE tasks SET status = 'done', finished_at = datetime('now'), cost_usd = 0.02, tokens_in = 1000, tokens_out = 200 WHERE id = ?"
    ).run(recente.id);
    db.prepare(
      "UPDATE tasks SET status = 'done', finished_at = '2026-01-15 10:00:00', cost_usd = 0.05, tokens_in = 3000, tokens_out = 700 WHERE id = ?"
    ).run(antiga.id);

    const stats = (await app.inject({ method: "GET", url: "/api/stats" })).json();
    expect(stats.month.tasks_done).toBe(1);
    expect(stats.month.cost_usd).toBeCloseTo(0.02, 5);
    expect(stats.month.tokens_in).toBe(1000);
    expect(stats.total.tasks_done).toBe(2);
    expect(stats.total.cost_usd).toBeCloseTo(0.07, 5);
    expect(stats.total.tokens_out).toBe(900);
  });
});
