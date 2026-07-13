import { describe, expect, it } from "vitest";
import {
  buildPrBody,
  humanizeDeliveryError,
  isValidBranchName,
  parseDefaultBranch,
  parseGhAuthStatus,
  renderBranchTemplate,
  slugify,
  uniqueBranchName,
} from "../src/git.js";

describe("slugify", () => {
  it("normaliza acentos, espaços e símbolos", () => {
    expect(slugify("Corrigir validação do login!")).toBe("corrigir-validacao-do-login");
    expect(slugify("Ação & Reação (v2)")).toBe("acao-reacao-v2");
  });

  it("trunca títulos longos sem deixar hífen pendurado", () => {
    const slug = slugify("a".repeat(35) + " bbbbbbbbbb");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("título sem nada aproveitável vira 'tarefa'", () => {
    expect(slugify("!!! ???")).toBe("tarefa");
  });
});

describe("renderBranchTemplate", () => {
  const task = { id: 42, title: "Ajustar relatório" };

  it("substitui {id}, {slug} e {date}", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    expect(renderBranchTemplate("feat/{slug}", task, now)).toBe("feat/ajustar-relatorio");
    expect(renderBranchTemplate("papatoken/tarefa-{id}-{slug}", task, now)).toBe(
      "papatoken/tarefa-42-ajustar-relatorio"
    );
    expect(renderBranchTemplate("{date}/{id}", task, now)).toBe("2026-07-12/42");
  });
});

describe("isValidBranchName", () => {
  it("aceita nomes comuns", () => {
    for (const name of ["main", "feat/nova-tela", "JIRA-123", "release/v1.2.3", "a"]) {
      expect(isValidBranchName(name), name).toBe(true);
    }
  });

  it("rejeita formas perigosas ou inválidas no git", () => {
    for (const name of ["", "-x", "a..b", "feat/", "x.lock", "com espaço", "~tilde", "a".repeat(101)]) {
      expect(isValidBranchName(name), name).toBe(false);
    }
  });
});

describe("parseDefaultBranch", () => {
  it("extrai a branch padrão da saída de ls-remote --symref", () => {
    const output =
      "ref: refs/heads/main\tHEAD\n" +
      "1a2b3c4d5e6f7890abcdef1234567890abcdef12\tHEAD\n";
    expect(parseDefaultBranch(output)).toBe("main");
  });

  it("suporta nomes com barra e retorna null quando não reconhece", () => {
    expect(parseDefaultBranch("ref: refs/heads/develop/v2\tHEAD\n")).toBe("develop/v2");
    expect(parseDefaultBranch("saída inesperada")).toBeNull();
  });
});

describe("uniqueBranchName", () => {
  it("mantém o nome quando livre e sufixa quando ocupado", () => {
    expect(uniqueBranchName("feat/x", new Set())).toBe("feat/x");
    expect(uniqueBranchName("feat/x", new Set(["feat/x"]))).toBe("feat/x-2");
    expect(uniqueBranchName("feat/x", new Set(["feat/x", "feat/x-2"]))).toBe("feat/x-3");
  });
});

describe("parseGhAuthStatus", () => {
  it("reconhece a saída de quem está logado", () => {
    const output =
      "github.com\n" +
      "  ✓ Logged in to github.com account AndreBoniatti (keyring)\n" +
      "  - Active account: true\n";
    expect(parseGhAuthStatus(output)).toEqual({
      authenticated: true,
      account: "AndreBoniatti",
    });
  });

  it("reconhece gh instalado sem login", () => {
    const output = "You are not logged into any GitHub hosts. To log in, run: gh auth login\n";
    expect(parseGhAuthStatus(output).authenticated).toBe(false);
  });
});

describe("humanizeDeliveryError", () => {
  it("traduz gh ausente, sem login e push sem credenciais para ações claras", () => {
    expect(humanizeDeliveryError("gh pr create: [spawn error] spawn gh ENOENT")).toContain(
      "winget install GitHub.cli"
    );
    expect(
      humanizeDeliveryError("gh pr create: To get started with GitHub CLI, run: gh auth login")
    ).toContain('"gh auth login"');
    expect(
      humanizeDeliveryError("git push: fatal: could not read Username for 'https://github.com'")
    ).toContain("gh auth setup-git");
  });

  it("preserva a mensagem original (entre colchetes ou intacta)", () => {
    expect(humanizeDeliveryError("erro qualquer sem tradução")).toBe(
      "erro qualquer sem tradução"
    );
    expect(humanizeDeliveryError("gh pr create: gh auth login required")).toContain(
      "gh auth login required"
    );
  });
});

describe("buildPrBody", () => {
  it("inclui o resumo e o rodapé com o número da tarefa", () => {
    const body = buildPrBody({ id: 7 }, "Refatorei o módulo X.");
    expect(body).toContain("Refatorei o módulo X.");
    expect(body).toContain("Tarefa #7");
  });

  it("sem resumo, usa o marcador e limita resumos gigantes", () => {
    expect(buildPrBody({ id: 1 }, null)).toContain("_(sem resumo de resultado)_");
    const body = buildPrBody({ id: 1 }, "x".repeat(10_000));
    expect(body.length).toBeLessThan(5_000);
  });
});
