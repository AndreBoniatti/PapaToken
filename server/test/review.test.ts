import { describe, expect, it } from "vitest";
import {
  extractReviewComments,
  parsePrUrl,
  REVIEW_COMMENT_MARKER,
  splitReviewHistory,
} from "../src/git.js";
import { buildPrReviewPrompt, buildReviewPrompt } from "../src/executor.js";

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

describe("splitReviewHistory", () => {
  const pr = {
    comments: [
      { author: { login: "dev" }, body: "comentário antes do review", createdAt: "2026-07-10T10:00:00Z" },
      {
        author: { login: "bot" },
        body: `## Resumo\ntudo certo\n\n---\n${REVIEW_COMMENT_MARKER}`,
        createdAt: "2026-07-11T10:00:00Z",
      },
      { author: { login: "dev" }, body: "ajustei o ponto 1, e o 2?", createdAt: "2026-07-12T10:00:00Z" },
    ],
    reviews: [],
  };
  const inline = [
    {
      user: { login: "dev" },
      body: "isto ainda falta",
      path: "src/a.ts",
      line: 5,
      created_at: "2026-07-12T11:00:00Z",
    },
  ];

  it("acha a última revisão nossa e a discussão humana posterior a ela", () => {
    const { previousReview, discussion } = splitReviewHistory(pr, inline, REVIEW_COMMENT_MARKER);
    expect(previousReview).toContain("## Resumo");
    expect(previousReview).toContain(REVIEW_COMMENT_MARKER);
    // só o que veio depois do nosso review, sem incluir o próprio review
    expect(discussion.map((c) => c.body)).toEqual(["ajustei o ponto 1, e o 2?", "isto ainda falta"]);
  });

  it("sem revisão anterior, a discussão traz todos os comentários humanos", () => {
    const semReview = {
      comments: [{ author: { login: "dev" }, body: "oi", createdAt: "2026-07-10T10:00:00Z" }],
      reviews: [],
    };
    const { previousReview, discussion } = splitReviewHistory(semReview, [], REVIEW_COMMENT_MARKER);
    expect(previousReview).toBeNull();
    expect(discussion).toHaveLength(1);
  });
});

describe("buildPrReviewPrompt (tarefa de code review)", () => {
  const pr = {
    title: "Adiciona validação de login",
    body: "Corrige o bug #12",
    author: "fulano",
    headRefName: "fix/login",
    baseRefName: "main",
    changedFiles: 3,
    additions: 40,
    deletions: 5,
    diff: "diff --git a/src/login.ts b/src/login.ts\n+if (!user) throw new Error();",
  };

  it("inclui contexto do PR, diff, instruções extras e o template de saída", () => {
    const prompt = buildPrReviewPrompt({ prompt: "foque em segurança" }, pr);
    expect(prompt).toContain("Adiciona validação de login");
    expect(prompt).toContain("@fulano");
    expect(prompt).toContain("main ← fix/login");
    expect(prompt).toContain("foque em segurança");
    expect(prompt).toContain("diff --git a/src/login.ts");
    expect(prompt).toContain("## Resumo");
    expect(prompt).toContain("## Problemas");
    expect(prompt).toContain("NÃO modifique nenhum arquivo");
    expect(prompt).toContain("decisão é humana");
  });

  it("sem instruções extras usa '(nenhuma)' e trunca diffs gigantes", () => {
    expect(buildPrReviewPrompt({ prompt: "" }, pr)).toContain("(nenhuma)");
    const gigante = buildPrReviewPrompt({ prompt: "" }, { ...pr, diff: "x".repeat(200_000) });
    expect(gigante).toContain("diff truncado");
    expect(gigante.length).toBeLessThan(100_000);
  });

  it("re-revisão carrega a revisão anterior, a discussão e o pedido de não repetir", () => {
    const prompt = buildPrReviewPrompt({ prompt: "" }, pr, {
      previousReview: "## Resumo\nfoo\n🔴 problema X em src/a.ts:3",
      discussion: [{ author: "dev", body: "corrigi o X", path: "src/a.ts", line: 9, createdAt: "" }],
    });
    expect(prompt).toContain("já revisou este Pull Request antes");
    expect(prompt).toContain("[Sua revisão anterior]");
    expect(prompt).toContain("problema X");
    expect(prompt).toContain("[Discussão desde a sua última revisão]");
    expect(prompt).toContain("@dev (src/a.ts:9): corrigi o X");
    expect(prompt).toContain("NÃO repita pontos que já foram resolvidos");
    // continua com o template de saída completo
    expect(prompt).toContain("## Resumo");
    expect(prompt).toContain("decisão é humana");
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
