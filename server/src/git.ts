import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * spawn SEM shell — git e gh são executáveis nativos no Windows e no Linux,
 * e argumentos em array dispensam escaping (títulos com aspas, acentos etc.).
 */
export function run(cmd: string, args: string[], cwd: string): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) =>
      resolve({ code: null, stdout, stderr: `${stderr}\n[spawn error] ${err.message}` })
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const git = (args: string[], cwd: string) => run("git", args, cwd);

/**
 * O gh pode não estar no PATH herdado pelo servidor (ex.: processo iniciado
 * antes de instalar o GitHub CLI) — no Windows, tenta o caminho padrão da
 * instalação antes de desistir.
 */
async function runGh(args: string[], cwd: string): Promise<CmdResult> {
  const r = await run("gh", args, cwd);
  if (r.code === null && r.stderr.includes("ENOENT") && process.platform === "win32") {
    const fallback = join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "GitHub CLI",
      "gh.exe"
    );
    if (existsSync(fallback)) return run(fallback, args, cwd);
  }
  return r;
}

/** git que falhou vira exceção com o stderr — os chamadores anotam no log da tarefa */
async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  }
  return r.stdout;
}

// ---------- diagnóstico do ambiente de entrega ----------

export interface GitDoctor {
  git: { installed: boolean; version: string | null };
  gh: { installed: boolean; authenticated: boolean; account: string | null };
}

/** saída de `gh auth status` → estado de login (a saída vai para stdout ou stderr
 *  conforme a versão do gh — os chamadores passam as duas concatenadas) */
export function parseGhAuthStatus(output: string): {
  authenticated: boolean;
  account: string | null;
} {
  return {
    authenticated: /logged in to/i.test(output),
    account: output.match(/account (\S+)/i)?.[1] ?? null,
  };
}

let doctorCache: { at: number; result: GitDoctor } | null = null;
const DOCTOR_TTL_MS = 60_000; // gh auth status lê o keyring local — rápido e offline

export async function gitDoctor(): Promise<GitDoctor> {
  if (doctorCache && Date.now() - doctorCache.at < DOCTOR_TTL_MS) return doctorCache.result;
  const cwd = process.cwd();
  const gitV = await run("git", ["--version"], cwd);
  const auth = await runGh(["auth", "status"], cwd);
  const result: GitDoctor = {
    git: { installed: gitV.code === 0, version: gitV.stdout.trim() || null },
    gh:
      auth.code === null
        ? { installed: false, authenticated: false, account: null }
        : { installed: true, ...parseGhAuthStatus(auth.stdout + auth.stderr) },
  };
  doctorCache = { at: Date.now(), result };
  return result;
}

/** null quando o ambiente está pronto para entregar PRs; senão, o que falta */
export async function deliveryBlocker(): Promise<string | null> {
  const d = await gitDoctor();
  if (!d.git.installed) return "git não está instalado (ou não está no PATH do servidor)";
  if (!d.gh.installed) {
    return "GitHub CLI (gh) não está instalado — Windows: winget install GitHub.cli · Linux: apt install gh";
  }
  if (!d.gh.authenticated) {
    return 'GitHub CLI sem autenticação — rode "gh auth login" no terminal e devolva a tarefa à fila';
  }
  return null;
}

/** traduz erros comuns de git/gh para mensagens acionáveis (original entre colchetes) */
export function humanizeDeliveryError(message: string): string {
  const s = message.toLowerCase();
  if (s.includes("enoent")) {
    return `GitHub CLI (gh) não encontrado — instale (Windows: winget install GitHub.cli · Linux: apt install gh) e reinicie o servidor [${message}]`;
  }
  if (s.includes("not logged") || s.includes("gh auth login") || s.includes("authentication token")) {
    return `GitHub CLI sem autenticação — rode "gh auth login" no terminal [${message}]`;
  }
  if (s.includes("could not read username") || s.includes("authentication failed")) {
    return `git push sem credenciais — rode "gh auth setup-git" para o git usar o login do gh [${message}]`;
  }
  if (s.includes("protected branch")) {
    return `a branch é protegida no GitHub — ajuste as regras do repositório ou use outra base [${message}]`;
  }
  if (s.includes("permission") || s.includes("403")) {
    return `sem permissão de escrita no repositório — confira o acesso da sua conta [${message}]`;
  }
  return message;
}

// ---------- funções puras (testáveis sem repo) ----------

/** título → pedaço seguro de nome de branch (sem acentos/símbolos, minúsculo) */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "tarefa";
}

export function renderBranchTemplate(
  template: string,
  task: { id: number; title: string },
  now = new Date()
): string {
  return template
    .replaceAll("{id}", String(task.id))
    .replaceAll("{slug}", slugify(task.title))
    .replaceAll("{date}", now.toISOString().slice(0, 10));
}

/** subconjunto seguro das regras de nome de branch do git */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (name.includes("..") || name.endsWith("/") || name.endsWith(".lock")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name);
}

/** saída de `git ls-remote --symref origin HEAD` → nome da branch padrão do remote */
export function parseDefaultBranch(output: string): string | null {
  const m = output.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  return m ? m[1] : null;
}

/** evita colisão com branches existentes acrescentando -2, -3, … */
export function uniqueBranchName(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function buildPrBody(
  task: { id: number },
  resultSummary: string | null | undefined
): string {
  const summary = (resultSummary ?? "").trim();
  return [
    summary ? summary.slice(0, 4000) : "_(sem resumo de resultado)_",
    "---",
    `Tarefa #${task.id} executada automaticamente pelo 🟡 PapaToken.`,
  ].join("\n\n");
}

// ---------- ciclo de review de PR ----------

export function parsePrUrl(
  url: string
): { owner: string; repo: string; number: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export interface ReviewComment {
  author: string;
  body: string;
  /** arquivo/linha quando é comentário inline no diff */
  path?: string;
  line?: number;
  createdAt: string;
}

interface PrViewJson {
  state?: string;
  headRefName?: string;
  baseRefName?: string;
  comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
  reviews?: {
    author?: { login?: string };
    body?: string;
    state?: string;
    submittedAt?: string;
  }[];
  commits?: { committedDate?: string }[];
}

interface InlineCommentJson {
  user?: { login?: string };
  body?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  created_at?: string;
}

/**
 * Junta comentários de conversa, corpos de review e comentários inline,
 * mantendo apenas os posteriores ao último commit do PR (feedback ainda
 * não atendido por um push).
 */
export function extractReviewComments(
  pr: PrViewJson,
  inline: InlineCommentJson[],
  sinceIso: string | null
): ReviewComment[] {
  const out: ReviewComment[] = [];
  for (const c of pr.comments ?? []) {
    if (c.body?.trim()) {
      out.push({ author: c.author?.login ?? "?", body: c.body, createdAt: c.createdAt ?? "" });
    }
  }
  for (const r of pr.reviews ?? []) {
    if (r.body?.trim()) {
      out.push({ author: r.author?.login ?? "?", body: r.body, createdAt: r.submittedAt ?? "" });
    }
  }
  for (const c of inline) {
    if (c.body?.trim()) {
      out.push({
        author: c.user?.login ?? "?",
        body: c.body,
        path: c.path,
        line: c.line ?? c.original_line ?? undefined,
        createdAt: c.created_at ?? "",
      });
    }
  }
  const filtered = sinceIso ? out.filter((c) => c.createdAt > sinceIso) : out;
  return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface ReviewFeedback {
  branch: string;
  baseBranch: string;
  comments: ReviewComment[];
}

/** Busca no GitHub o estado do PR e os comentários ainda não atendidos. */
export async function fetchReviewFeedback(
  repoPath: string,
  prUrl: string
): Promise<ReviewFeedback> {
  const ref = parsePrUrl(prUrl);
  if (!ref) throw new Error(`URL de PR não reconhecida: ${prUrl}`);

  const view = await runGh(
    [
      "pr",
      "view",
      prUrl,
      "--json",
      "state,headRefName,baseRefName,comments,reviews,commits",
    ],
    repoPath
  );
  if (view.code !== 0) {
    throw new Error(humanizeDeliveryError(`gh pr view: ${(view.stderr || view.stdout).trim()}`));
  }
  const pr = JSON.parse(view.stdout) as PrViewJson;
  if (pr.state !== "OPEN") {
    throw new Error(`o PR não está aberto (estado: ${pr.state ?? "desconhecido"})`);
  }
  if (!pr.headRefName) throw new Error("não foi possível identificar a branch do PR");

  const inlineRes = await runGh(
    ["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`],
    repoPath
  );
  const inline =
    inlineRes.code === 0 ? (JSON.parse(inlineRes.stdout) as InlineCommentJson[]) : [];

  const lastCommit =
    (pr.commits ?? [])
      .map((c) => c.committedDate ?? "")
      .sort()
      .at(-1) ?? null;

  const comments = extractReviewComments(pr, inline, lastCommit);
  if (comments.length === 0) {
    throw new Error(
      "nenhum comentário de review novo desde o último push — nada para atender"
    );
  }
  return { branch: pr.headRefName, baseBranch: pr.baseRefName ?? "main", comments };
}

/**
 * Worktree na branch existente do PR, resetada para o estado atual do remote
 * (pode conter commits de outras pessoas desde o nosso push).
 */
export async function prepareReviewWorktree(opts: {
  repoPath: string;
  branch: string;
  baseBranch: string;
  worktreesDir: string;
  taskId: number;
}): Promise<PreparedWorktree> {
  const { repoPath, branch } = opts;
  await gitOk(["rev-parse", "--is-inside-work-tree"], repoPath);
  await gitOk(["fetch", "origin", branch], repoPath);

  mkdirSync(opts.worktreesDir, { recursive: true });
  const worktreePath = join(opts.worktreesDir, `tarefa-${opts.taskId}`);
  if (existsSync(worktreePath)) {
    await git(["worktree", "remove", "--force", worktreePath], repoPath);
    rmSync(worktreePath, { recursive: true, force: true });
    await git(["worktree", "prune"], repoPath);
  }
  // -B: (re)aponta a branch local para o topo do remote
  await gitOk(["worktree", "add", "-B", branch, worktreePath, `origin/${branch}`], repoPath);
  return { repoPath, worktreePath, branch, baseBranch: opts.baseBranch };
}

// ---------- operações sobre o repositório ----------

export interface PreparedWorktree {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

/**
 * Valida o repositório, busca a base no remote e cria uma worktree temporária
 * com a branch nova — o checkout do usuário no repo fica intocado.
 */
export async function prepareWorktree(opts: {
  repoPath: string;
  /** null = detectar a branch padrão do remote */
  baseBranch: string | null;
  desiredBranch: string;
  worktreesDir: string;
  taskId: number;
}): Promise<PreparedWorktree> {
  const { repoPath } = opts;
  if (!existsSync(repoPath)) throw new Error(`diretório não existe: ${repoPath}`);
  await gitOk(["rev-parse", "--is-inside-work-tree"], repoPath);
  const originUrl = (await gitOk(["remote", "get-url", "origin"], repoPath)).trim();
  if (!/github\.com/i.test(originUrl)) {
    throw new Error(`remote origin não aponta para o GitHub: ${originUrl}`);
  }

  let base = opts.baseBranch;
  if (!base) {
    base = parseDefaultBranch(await gitOk(["ls-remote", "--symref", "origin", "HEAD"], repoPath));
    if (!base) throw new Error("não foi possível detectar a branch padrão do remote");
  }
  // parte sempre do estado atual do remote, não da cópia local possivelmente velha
  await gitOk(["fetch", "origin", base], repoPath);

  const refs = await gitOk(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
    repoPath
  );
  const taken = new Set<string>();
  for (const line of refs.split("\n")) {
    const name = line.trim().replace(/^origin\//, "");
    if (name) taken.add(name);
  }
  const branch = uniqueBranchName(opts.desiredBranch, taken);

  mkdirSync(opts.worktreesDir, { recursive: true });
  const worktreePath = join(opts.worktreesDir, `tarefa-${opts.taskId}`);
  if (existsSync(worktreePath)) {
    // sobra de uma tentativa anterior — recomeça limpo
    await git(["worktree", "remove", "--force", worktreePath], repoPath);
    rmSync(worktreePath, { recursive: true, force: true });
    await git(["worktree", "prune"], repoPath);
  }
  await gitOk(["worktree", "add", worktreePath, "-b", branch, `origin/${base}`], repoPath);
  return { repoPath, worktreePath, branch, baseBranch: base };
}

export interface DeliverOutcome {
  prUrl: string | null;
  notes: string[];
  /** desfecho explícito — vai para tasks.deliver_status e para a UI */
  status: "created" | "no_changes" | "failed";
}

/**
 * commit → push → gh pr create, a partir da worktree preparada.
 * Nunca lança: falhas viram notas no log e a worktree é preservada para inspeção.
 */
export async function deliverPullRequest(
  wt: PreparedWorktree,
  opts: { title: string; body: string }
): Promise<DeliverOutcome> {
  const notes: string[] = [];
  try {
    await gitOk(["add", "-A"], wt.worktreePath);
    const status = await gitOk(["status", "--porcelain"], wt.worktreePath);
    if (status.trim() === "") {
      notes.push("[entrega] nenhuma alteração de arquivo — PR não criado");
      await removeWorktree(wt);
      return { prUrl: null, notes, status: "no_changes" };
    }

    await gitOk(
      ["commit", "-m", `${opts.title}\n\nTarefa executada automaticamente pelo PapaToken.`],
      wt.worktreePath
    );
    notes.push(`[entrega] commit criado na branch ${wt.branch}`);

    await gitOk(["push", "-u", "origin", wt.branch], wt.worktreePath);
    notes.push(`[entrega] branch ${wt.branch} enviada para origin`);

    const pr = await runGh(
      [
        "pr",
        "create",
        "--base",
        wt.baseBranch,
        "--head",
        wt.branch,
        "--title",
        opts.title,
        "--body",
        opts.body,
      ],
      wt.worktreePath
    );
    if (pr.code !== 0) {
      // re-execução da tarefa: o push já atualizou o PR aberto — é sucesso
      const combined = pr.stderr + pr.stdout;
      const existing = combined.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
      if (existing && /already exists/i.test(combined)) {
        notes.push(`[entrega] PR já existia e foi atualizado pelo push: ${existing}`);
        await removeWorktree(wt);
        return { prUrl: existing, notes, status: "created" };
      }
      throw new Error(`gh pr create: ${(pr.stderr || pr.stdout).trim()}`);
    }

    const url = pr.stdout.match(/https:\/\/github\.com\/\S+/)?.[0] ?? null;
    notes.push(`[entrega] PR aberto: ${url ?? "(URL não identificada na saída do gh)"}`);
    await removeWorktree(wt);
    return { prUrl: url, notes, status: "created" };
  } catch (err) {
    notes.push(`[entrega] FALHOU: ${humanizeDeliveryError((err as Error).message)}`);
    notes.push(
      `[entrega] trabalho preservado na worktree ${wt.worktreePath} (branch ${wt.branch})`
    );
    return { prUrl: null, notes, status: "failed" };
  }
}

export async function removeWorktree(wt: PreparedWorktree): Promise<void> {
  await git(["worktree", "remove", "--force", wt.worktreePath], wt.repoPath);
  await git(["worktree", "prune"], wt.repoPath);
}

/** branches conhecidas do remote (refs locais — rápido, sem rede) para a UI sugerir */
export async function listRemoteBranches(repoPath: string): Promise<string[] | null> {
  if (!existsSync(repoPath)) return null;
  const inside = await git(["rev-parse", "--is-inside-work-tree"], repoPath);
  if (inside.code !== 0) return null;
  const r = await git(
    ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
    repoPath
  );
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("origin/"))
    .map((l) => l.slice("origin/".length))
    .filter((l) => l && l !== "HEAD");
}
