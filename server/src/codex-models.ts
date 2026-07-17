import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProvider } from "./executor.js";

/**
 * Detecção/validação dos modelos do Codex desta conta.
 *
 * O Codex CLI não tem comando de listar modelos, mas cacheia a lista em
 * ~/.codex/models_cache.json (campo models[] com slug/display_name/visibility).
 * Os selecionáveis são os visibility === "list" — é a fonte da verdade da
 * CONTA logada, diferente das listas públicas: o app/extensão do ChatGPT
 * mostram modelos (ex.: gpt-5.6-sol) que o CLI recusa com 400.
 * O formato não é documentado — parse defensivo com mensagem clara.
 */

// avaliado a cada chamada (diferente do providers/codex.ts) para os testes
// poderem trocar o CODEX_HOME sem reimportar o módulo
function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export interface CodexModelCandidate {
  slug: string;
  displayName: string | null;
  /** false = fora da API, mas roda pela conta ChatGPT (ex.: gpt-5.3-codex-spark) */
  supportedInApi: boolean | null;
}

export interface CandidatesResult {
  ok: boolean;
  models: CodexModelCandidate[];
  error?: string;
}

/** Extrai os candidatos (visibility === "list") do conteúdo do models_cache.json. */
export function parseModelsCache(raw: string): CodexModelCandidate[] {
  const data = JSON.parse(raw) as { models?: unknown };
  if (!Array.isArray(data.models)) {
    throw new Error('campo "models" ausente — o formato do cache pode ter mudado');
  }
  const out: CodexModelCandidate[] = [];
  for (const m of data.models as Record<string, unknown>[]) {
    if (!m || typeof m.slug !== "string" || m.visibility !== "list") continue;
    out.push({
      slug: m.slug,
      displayName: typeof m.display_name === "string" ? m.display_name : null,
      supportedInApi: typeof m.supported_in_api === "boolean" ? m.supported_in_api : null,
    });
  }
  return out;
}

/** Lê os modelos que o Codex CLI conhece nesta conta (cache local, sem rede). */
export function listCodexModelCandidates(): CandidatesResult {
  const path = join(codexHome(), "models_cache.json");
  if (!existsSync(path)) {
    return {
      ok: false,
      models: [],
      error:
        "Cache de modelos do Codex não encontrado nesta máquina. Rode o Codex uma vez (ex.: \"codex\") para ele gerar o ~/.codex/models_cache.json.",
    };
  }
  try {
    const models = parseModelsCache(readFileSync(path, "utf8"));
    if (models.length === 0) {
      return { ok: false, models: [], error: "O cache de modelos existe, mas não tem nenhum modelo selecionável." };
    }
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: `Falha ao ler o cache de modelos do Codex: ${(err as Error).message}`,
    };
  }
}

/**
 * Linha de erro mais útil do stderr do codex — modelo inválido sai como
 * 'ERROR: unexpected status 400 ... "The model `x` is not supported..."'.
 */
export function extractCodexError(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const err = lines.find((l) => /error/i.test(l)) ?? lines[lines.length - 1];
  if (!err) return null;
  return err.length > 240 ? `${err.slice(0, 240)}…` : err;
}

export interface ModelTestResult {
  model: string;
  ok: boolean;
  note: string | null;
}

/**
 * Smoke test de um modelo: `codex exec -m <slug>` com prompt mínimo. Modelo
 * inválido falha rápido com 400 sem gastar tokens; válido gasta uns poucos.
 * Sandbox read-only — o mais seguro e funciona inclusive no Windows.
 */
export async function testCodexModel(slug: string, timeoutMs = 120_000): Promise<ModelTestResult> {
  const commandLine = [
    "codex", "exec", "-s", "read-only", "--skip-git-repo-check", "-m", slug, "-",
  ].join(" ");
  const r = await spawnProvider(commandLine, "Responda apenas: ok", tmpdir(), timeoutMs);
  if (r.timedOut) {
    return { model: slug, ok: false, note: `sem resposta em ${Math.round(timeoutMs / 1000)}s (timeout)` };
  }
  if (r.exitCode === 0) return { model: slug, ok: true, note: null };
  return { model: slug, ok: false, note: extractCodexError(r.stderr) ?? `exit ${r.exitCode}` };
}
