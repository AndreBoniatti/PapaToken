import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VerifyResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 100_000;

/**
 * Roda o comando de verificação da tarefa (linha digitada pelo usuário —
 * precisa de shell) no diretório indicado, com timeout e saída combinada.
 */
export function runVerifyCommand(
  cmdLine: string,
  cwd: string,
  timeoutMs: number
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const child = spawn(cmdLine, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: true });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (err) => {
      output += `\n[spawn error] ${err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** espia o diretório e sugere comandos de verificação prováveis (nunca executa) */
export function suggestVerifyCommands(dir: string): string[] {
  const out: string[] = [];
  try {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<
        string,
        string
      >;
      if (scripts.check) out.push("npm run check");
      if (scripts.test) out.push("npm test");
      if (scripts.lint && !scripts.check) out.push("npm run lint");
    }
  } catch {
    // package.json ilegível — segue para as outras heurísticas
  }
  if (existsSync(join(dir, "Cargo.toml"))) out.push("cargo test");
  if (existsSync(join(dir, "go.mod"))) out.push("go test ./...");
  if (
    ["pyproject.toml", "pytest.ini", "setup.cfg"].some((f) => existsSync(join(dir, f)))
  ) {
    out.push("pytest");
  }
  try {
    const makefile = join(dir, "Makefile");
    if (existsSync(makefile) && /^test:/m.test(readFileSync(makefile, "utf8"))) {
      out.push("make test");
    }
  } catch {
    // Makefile ilegível — ignora
  }
  return out;
}
