/**
 * Smoke manual do fluxo de entrega por PR (não roda no vitest).
 *
 *   npx tsx test/smoke-git.ts [pasta-temporária]
 *
 * Monta um "origin" local (bare repo num caminho contendo github.com, para
 * passar na validação de remote), exercita prepareWorktree/deliverPullRequest
 * de ponta a ponta e verifica: detecção de branch padrão, base alternativa,
 * commit+push reais, preservação da worktree quando o gh falha (esperado
 * aqui — o remote não é o GitHub de verdade) e o caso "sem alterações".
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverPullRequest, prepareWorktree } from "../src/git.js";

const base = process.argv[2] ?? join(tmpdir(), "papatoken-smoke-git");
const sh = (cwd: string, cmd: string, ...args: string[]) =>
  execFileSync(cmd, args, { cwd, stdio: "pipe" }).toString("utf8");
const git = (cwd: string, ...args: string[]) => sh(cwd, "git", ...args);
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    console.error(`✗ FALHOU: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
};

rmSync(base, { recursive: true, force: true });

// "origin": bare repo; o caminho contém github.com só para passar na validação
const bare = join(base, "github.com", "remote.git");
mkdirSync(bare, { recursive: true });
git(bare, "init", "--bare", "-b", "main");

// clone de trabalho com main + stage publicadas
const repo = join(base, "repo");
mkdirSync(repo, { recursive: true });
git(repo, "init", "-b", "main");
git(repo, "config", "user.email", "smoke@papatoken.local");
git(repo, "config", "user.name", "PapaToken Smoke");
writeFileSync(join(repo, "README.md"), "# smoke\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "commit inicial");
git(repo, "remote", "add", "origin", bare);
git(repo, "push", "-u", "origin", "main");
git(repo, "checkout", "-b", "stage");
writeFileSync(join(repo, "stage.txt"), "só existe na stage\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "commit da stage");
git(repo, "push", "-u", "origin", "stage");
git(repo, "checkout", "main");

const worktreesDir = join(base, "worktrees");

// 1) base explícita (stage) + trabalho da "IA" + entrega
const wt = await prepareWorktree({
  repoPath: repo,
  baseBranch: "stage",
  desiredBranch: "feat/teste-smoke",
  worktreesDir,
  taskId: 999,
});
assert(wt.baseBranch === "stage", "usa a branch base pedida (stage)");
assert(
  existsSync(join(wt.worktreePath, "stage.txt")),
  "worktree parte do conteúdo de origin/stage"
);
assert(
  git(repo, "status", "--porcelain").trim() === "",
  "checkout original do usuário permanece intocado"
);

writeFileSync(join(wt.worktreePath, "novo-arquivo.txt"), "trabalho da IA\n");
const outcome = await deliverPullRequest(wt, { title: "Tarefa smoke", body: "corpo" });

assert(
  outcome.status === "failed",
  "gh pr create falha como esperado (origin não é GitHub real)"
);
assert(
  outcome.notes.some((n) => n.includes("commit criado")),
  "commit foi criado antes da falha"
);
assert(
  outcome.notes.some((n) => n.includes("enviada para origin")),
  "push aconteceu antes da falha"
);
assert(
  git(bare, "branch", "--list", "feat/teste-smoke").includes("feat/teste-smoke"),
  "branch feat/teste-smoke existe no remote"
);
assert(existsSync(wt.worktreePath), "worktree preservada para inspeção após a falha");

// 2) detecção da branch padrão + caso "IA não alterou nada"
const wt2 = await prepareWorktree({
  repoPath: repo,
  baseBranch: null,
  desiredBranch: "feat/vazia",
  worktreesDir,
  taskId: 998,
});
assert(wt2.baseBranch === "main", "detecta main como branch padrão do remote");

const vazio = await deliverPullRequest(wt2, { title: "Nada", body: "corpo" });
assert(
  vazio.status === "no_changes" && vazio.prUrl === null,
  "sem alterações: desfecho no_changes e nenhum PR"
);
assert(
  vazio.notes.some((n) => n.includes("nenhuma alteração")),
  "log explica que não houve alterações"
);
assert(!existsSync(wt2.worktreePath), "worktree limpa quando não há entrega");

// 3) colisão de nome de branch → sufixo
const wt3 = await prepareWorktree({
  repoPath: repo,
  baseBranch: "main",
  desiredBranch: "feat/teste-smoke",
  worktreesDir,
  taskId: 997,
});
assert(wt3.branch === "feat/teste-smoke-2", `colisão vira sufixo (${wt3.branch})`);

console.log("\nSmoke OK — tudo verificado.");
