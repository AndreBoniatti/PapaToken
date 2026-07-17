import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  extractCodexError,
  listCodexModelCandidates,
  parseModelsCache,
} from "../src/codex-models.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

describe("parseModelsCache", () => {
  it("mantém só os visibility=list, com display_name e supported_in_api", () => {
    const models = parseModelsCache(
      JSON.stringify({
        models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_in_api: true },
          { slug: "codex-auto-review", visibility: "hide", supported_in_api: true },
          { slug: "gpt-5.3-codex-spark", visibility: "list", supported_in_api: false },
        ],
      })
    );
    expect(models).toEqual([
      { slug: "gpt-5.5", displayName: "GPT-5.5", supportedInApi: true },
      { slug: "gpt-5.3-codex-spark", displayName: null, supportedInApi: false },
    ]);
  });

  it("entradas sem slug ou malformadas são ignoradas sem quebrar", () => {
    const models = parseModelsCache(
      JSON.stringify({ models: [null, { visibility: "list" }, { slug: 42, visibility: "list" }] })
    );
    expect(models).toEqual([]);
  });

  it("formato inesperado (sem models[]) lança erro explicativo", () => {
    expect(() => parseModelsCache("{}")).toThrow(/models/);
    expect(() => parseModelsCache("não é json")).toThrow();
  });
});

describe("listCodexModelCandidates (CODEX_HOME de fixture — ver setup.ts)", () => {
  it("lê o models_cache.json e devolve os selecionáveis", () => {
    const res = listCodexModelCandidates();
    expect(res.ok).toBe(true);
    expect(res.models.map((m) => m.slug)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex-spark",
    ]);
  });

  it("sem o arquivo de cache, explica como gerá-lo", () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "C:\\nao\\existe\\papatoken-test";
    try {
      const res = listCodexModelCandidates();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/models_cache\.json/);
    } finally {
      process.env.CODEX_HOME = prev;
    }
  });
});

describe("extractCodexError", () => {
  it("prefere a linha com ERROR (o 400 de modelo não suportado)", () => {
    const stderr =
      "reading prompt from stdin...\n" +
      'ERROR: unexpected status 400 Bad Request: {"detail":"The model `gpt-5.6-sol` is not supported when using Codex with a ChatGPT account."}\n';
    expect(extractCodexError(stderr)).toContain("gpt-5.6-sol");
  });

  it("sem linha de erro, usa a última linha; stderr vazio dá null", () => {
    expect(extractCodexError("a\nb\n")).toBe("b");
    expect(extractCodexError("")).toBeNull();
  });

  it("trunca linhas gigantes", () => {
    const note = extractCodexError(`ERROR: ${"x".repeat(500)}`);
    expect(note!.length).toBeLessThanOrEqual(241);
  });
});

describe("rotas de modelos do Codex", () => {
  it("GET candidates entrega os modelos do cache", async () => {
    const res = await app.inject({ method: "GET", url: "/api/codex/models/candidates" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.models.some((m: { slug: string }) => m.slug === "gpt-5.5")).toBe(true);
  });

  it("POST test rejeita slug com caracteres perigosos (vai para a linha de comando)", async () => {
    for (const model of ["gpt 5.5", "x;rm -rf", "", "a".repeat(65)]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/codex/models/test",
        payload: { model },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
