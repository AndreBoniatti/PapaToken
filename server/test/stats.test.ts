import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { extractRunUsage } from "../src/executor.js";
import { parseCodexTokens } from "../src/providers/codex.js";

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

describe("parseCodexTokens", () => {
  it("lê o total do stderr, ignorando separador de milhar (pt-BR e en-US)", () => {
    expect(parseCodexTokens("...\ntokens used\n55.909\n")).toBe(55909);
    expect(parseCodexTokens("tokens used: 55,909")).toBe(55909);
    expect(parseCodexTokens("tokens used 1200")).toBe(1200);
  });

  it("pega a última ocorrência e retorna null quando não há", () => {
    expect(parseCodexTokens("tokens used 10\n...\ntokens used\n2.500")).toBe(2500);
    expect(parseCodexTokens("sem contagem aqui")).toBeNull();
  });
});

describe("extractRunUsage", () => {
  it("extrai custo e soma tokens de entrada (diretos + cache) do envelope Claude", () => {
    const usage = extractRunUsage("claude", { stdout: `lixo antes\n${envelope}\n`, stderr: "" });
    expect(usage).toEqual({
      costUsd: 0.0219705,
      tokensIn: 18 + 7341 + 37645,
      tokensOut: 563,
    });
  });

  it("Codex: total do stderr vai para tokensOut, sem custo", () => {
    const usage = extractRunUsage("codex", {
      stdout: "resposta em markdown",
      stderr: "OpenAI Codex\n...\ntokens used\n55.909",
    });
    expect(usage).toEqual({ costUsd: 0, tokensIn: 0, tokensOut: 55909 });
  });

  it("retorna null sem envelope (Claude) e sem contagem (Codex)", () => {
    expect(extractRunUsage("claude", { stdout: "sem json", stderr: "" })).toBeNull();
    expect(extractRunUsage("codex", { stdout: "x", stderr: "sem tokens" })).toBeNull();
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

  it("agrega custo/tokens no mês e no total, com quebra por provider", async () => {
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
    const orfa = await create("stats sem provider");

    db.prepare(
      "UPDATE tasks SET status = 'done', finished_at = datetime('now'), executed_by = 'claude', cost_usd = 0.02, tokens_in = 1000, tokens_out = 200 WHERE id = ?"
    ).run(recente.id);
    // Codex não expõe custo: fica 0, com o total de tokens em tokens_out
    db.prepare(
      "UPDATE tasks SET status = 'done', finished_at = '2026-01-15 10:00:00', executed_by = 'codex', cost_usd = 0, tokens_in = 0, tokens_out = 3700 WHERE id = ?"
    ).run(antiga.id);
    db.prepare(
      "UPDATE tasks SET status = 'done', finished_at = '2026-01-10 10:00:00', cost_usd = 0.05, tokens_in = 3000, tokens_out = 700 WHERE id = ?"
    ).run(orfa.id);

    const stats = (await app.inject({ method: "GET", url: "/api/stats" })).json();
    expect(stats.month.tasks_done).toBe(1);
    expect(stats.month.cost_usd).toBeCloseTo(0.02, 5);
    expect(stats.month.tokens_in).toBe(1000);
    expect(stats.month.claude.tasks_done).toBe(1);
    expect(stats.month.claude.cost_usd).toBeCloseTo(0.02, 5);
    expect(stats.month.codex.tasks_done).toBe(0);

    expect(stats.total.tasks_done).toBe(3);
    expect(stats.total.cost_usd).toBeCloseTo(0.07, 5);
    expect(stats.total.claude.tasks_done).toBe(1);
    expect(stats.total.codex.tasks_done).toBe(1);
    expect(stats.total.codex.cost_usd).toBe(0);
    expect(stats.total.codex.tokens_out).toBe(3700);
    // tarefa sem executed_by entra só no agregado geral (claude + codex < total)
    expect(stats.total.claude.tasks_done + stats.total.codex.tasks_done).toBeLessThan(
      stats.total.tasks_done
    );
  });
});
