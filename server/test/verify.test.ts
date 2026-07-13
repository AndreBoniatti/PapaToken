import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runVerifyCommand, suggestVerifyCommands } from "../src/verify.js";
import { buildVerifyFeedbackPrompt, cliOnPath, setupMessage } from "../src/executor.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/suggest/${name}`, import.meta.url));

describe("suggestVerifyCommands", () => {
  it("sugere scripts npm na ordem check > test (lint só sem check)", () => {
    expect(suggestVerifyCommands(fixture("node-repo"))).toEqual([
      "npm run check",
      "npm test",
    ]);
  });

  it("reconhece projetos rust e não sugere nada para pasta vazia", () => {
    expect(suggestVerifyCommands(fixture("rust-repo"))).toEqual(["cargo test"]);
    expect(suggestVerifyCommands(fixture("empty-repo"))).toEqual([]);
  });
});

describe("runVerifyCommand", () => {
  it("captura saída e código de sucesso", async () => {
    const r = await runVerifyCommand('node -e "console.log(1+1)"', process.cwd(), 30_000);
    expect(r.code).toBe(0);
    expect(r.output).toContain("2");
    expect(r.timedOut).toBe(false);
  });

  it("reporta código de falha", async () => {
    const r = await runVerifyCommand(
      'node -e "console.error(String.fromCharCode(102,97,108,104,111,117)); process.exit(3)"',
      process.cwd(),
      30_000
    );
    expect(r.code).toBe(3);
    expect(r.output).toContain("falhou");
  });
});

describe("pre-flight de provider (setup)", () => {
  it("mensagem de CLI ausente traz instalação, login e reinício do servidor", () => {
    const msg = setupMessage("claude", "cli");
    expect(msg).toContain("npm install -g @anthropic-ai/claude-code");
    expect(msg).toContain("Reinicie o servidor");
    expect(setupMessage("codex", "cli")).toContain("npm install -g @openai/codex");
  });

  it("mensagem de login orienta o comando certo por provider", () => {
    expect(setupMessage("claude", "login")).toContain('"claude"');
    expect(setupMessage("codex", "login")).toContain("codex login");
  });

  it("cliOnPath detecta comandos existentes e inexistentes", async () => {
    expect(await cliOnPath("node")).toBe(true);
    expect(await cliOnPath("comando-que-nao-existe-xyz")).toBe(false);
  });
});

describe("buildVerifyFeedbackPrompt", () => {
  it("inclui a tarefa original, o comando e a saída truncada do fim", () => {
    const prompt = buildVerifyFeedbackPrompt(
      { prompt: "Implementar a função X" },
      "npm test",
      "a".repeat(5000) + "ERRO FINAL"
    );
    expect(prompt).toContain("Implementar a função X");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("ERRO FINAL");
    // trunca para o fim da saída (4000 chars)
    expect(prompt.length).toBeLessThan(5000);
  });
});
