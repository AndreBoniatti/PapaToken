import { describe, expect, it } from "vitest";
import { extractReviewComments, parsePrUrl } from "../src/git.js";
import { buildReviewPrompt } from "../src/executor.js";

describe("parsePrUrl", () => {
  it("extrai owner/repo/número de URLs de PR", () => {
    expect(parsePrUrl("https://github.com/AndreBoniatti/just-a-test/pull/1")).toEqual({
      owner: "AndreBoniatti",
      repo: "just-a-test",
      number: 1,
    });
  });

  it("rejeita URLs que não são de PR", () => {
    expect(parsePrUrl("https://github.com/a/b")).toBeNull();
    expect(parsePrUrl("https://gitlab.com/a/b/pull/1")).toBeNull();
  });
});

describe("extractReviewComments", () => {
  const pr = {
    comments: [
      { author: { login: "andre" }, body: "comentário antigo", createdAt: "2026-07-10T10:00:00Z" },
      { author: { login: "andre" }, body: "comentário novo", createdAt: "2026-07-13T10:00:00Z" },
    ],
    reviews: [
      { author: { login: "andre" }, body: "mude a função X", submittedAt: "2026-07-13T11:00:00Z" },
      { author: { login: "andre" }, body: "", submittedAt: "2026-07-13T11:00:00Z" },
    ],
  };
  const inline = [
    {
      user: { login: "andre" },
      body: "renomeie isto",
      path: "src/a.ts",
      line: 42,
      created_at: "2026-07-13T09:00:00Z",
    },
  ];

  it("filtra pelo último commit e ordena por data", () => {
    const comments = extractReviewComments(pr, inline, "2026-07-12T00:00:00Z");
    expect(comments.map((c) => c.body)).toEqual([
      "renomeie isto",
      "comentário novo",
      "mude a função X",
    ]);
    expect(comments[0]).toMatchObject({ path: "src/a.ts", line: 42 });
  });

  it("sem data de corte, inclui tudo que tem corpo", () => {
    expect(extractReviewComments(pr, inline, null)).toHaveLength(4);
  });
});

describe("buildReviewPrompt", () => {
  it("lista os comentários com autor e localização", () => {
    const prompt = buildReviewPrompt({ prompt: "Tarefa X" }, [
      { author: "andre", body: "renomeie isto", path: "src/a.ts", line: 42, createdAt: "" },
      { author: "andre", body: "comentário geral", createdAt: "" },
    ]);
    expect(prompt).toContain("Tarefa X");
    expect(prompt).toContain("@andre (src/a.ts:42): renomeie isto");
    expect(prompt).toContain("@andre: comentário geral");
    expect(prompt).toContain("Não rode git commit/push");
  });
});
