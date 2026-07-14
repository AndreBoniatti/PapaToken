import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// PAPATOKEN_DB aceita outro caminho ou ":memory:" (usado pelos testes)
const dbPath = process.env.PAPATOKEN_DB ?? join(here, "..", "data", "papatoken.db");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (provider IN ('claude','codex')),
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS usage_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
    window TEXT NOT NULL CHECK (window IN ('session','weekly')),
    used_percent REAL NOT NULL,
    resets_at TEXT,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_sub_time
    ON usage_snapshots (subscription_id, captured_at);

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'any' CHECK (provider IN ('claude','codex','any')),
    cwd TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','running','done','failed','blocked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    executed_by TEXT,
    exit_code INTEGER,
    output_log TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 2,
    model TEXT,
    effort TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    deliver_mode TEXT NOT NULL DEFAULT 'none' CHECK (deliver_mode IN ('none','pr')),
    base_branch TEXT,
    work_branch TEXT,
    pr_url TEXT,
    deliver_status TEXT CHECK (deliver_status IN ('created','no_changes','failed')),
    verify_cmd TEXT,
    cost_usd REAL,
    tokens_in INTEGER,
    tokens_out INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- memória por repositório: comando de verificação usado da última vez
  CREATE TABLE IF NOT EXISTS repo_prefs (
    cwd TEXT PRIMARY KEY,
    verify_cmd TEXT NOT NULL
  );
`);

// migração para bancos criados antes de colunas adicionadas depois do schema inicial
const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
const addColumn = (name: string, ddl: string) => {
  if (!taskCols.some((c) => c.name === name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
};
addColumn("model", "model TEXT");
addColumn("effort", "effort TEXT");
addColumn("attachments", "attachments TEXT NOT NULL DEFAULT '[]'");
addColumn("deliver_mode", "deliver_mode TEXT NOT NULL DEFAULT 'none' CHECK (deliver_mode IN ('none','pr'))");
addColumn("base_branch", "base_branch TEXT");
addColumn("work_branch", "work_branch TEXT");
addColumn("pr_url", "pr_url TEXT");
addColumn("verify_cmd", "verify_cmd TEXT");
addColumn("cost_usd", "cost_usd REAL");
addColumn("tokens_in", "tokens_in INTEGER");
addColumn("tokens_out", "tokens_out INTEGER");
const hadDeliverStatus = taskCols.some((c) => c.name === "deliver_status");
addColumn(
  "deliver_status",
  "deliver_status TEXT CHECK (deliver_status IN ('created','no_changes','failed'))"
);
if (!hadDeliverStatus) {
  // backfill único: tarefas entregues antes da coluna existir têm o desfecho
  // registrado apenas nas notas [entrega] do log
  db.exec(`
    UPDATE tasks SET deliver_status = 'created'
      WHERE deliver_mode = 'pr' AND pr_url IS NOT NULL;
    UPDATE tasks SET deliver_status = 'no_changes'
      WHERE deliver_mode = 'pr' AND deliver_status IS NULL
        AND output_log LIKE '%nenhuma alteração de arquivo%';
    UPDATE tasks SET deliver_status = 'failed'
      WHERE deliver_mode = 'pr' AND deliver_status IS NULL
        AND output_log LIKE '%[entrega] FALHOU%';
  `);
}

const defaultSettings: Record<string, string> = {
  safety_ceiling_pct: "90",
  dispatch_window_min: "60",
  min_free_pct: "15",
  poll_interval_sec: "180",
  task_timeout_min: "30",
  mode: "window", // window | aggressive | paused
  default_workspace_dir: join(homedir(), "Documents", "PapaTasks"),
  // acceptEdits: só edita arquivos; bypassPermissions: usa qualquer ferramenta
  // (web, comandos) sem aprovação — necessário para tarefas autônomas
  claude_permission_mode: "acceptEdits",
  // sandbox do Codex: workspace-write edita o cwd + rede; danger-full-access
  // roda qualquer comando sem sandbox (equivalente ao bypassPermissions).
  // No Windows o workspace-write degrada para read-only (o Codex não tem
  // sandbox nativo lá) — então o padrão sensato no Windows é danger-full-access,
  // senão nenhuma tarefa do Codex consegue escrever arquivo.
  codex_sandbox_mode: process.platform === "win32" ? "danger-full-access" : "workspace-write",
  // nome da branch criada em entregas por PR; variáveis: {id} {slug} {date}
  branch_template: "feat/{slug}",
};

const insertSetting = db.prepare(
  "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
);
for (const [k, v] of Object.entries(defaultSettings)) insertSetting.run(k, v);

// Seed the two default subscriptions once
const subCount = db.prepare("SELECT COUNT(*) AS n FROM subscriptions").get() as {
  n: number;
};
if (subCount.n === 0) {
  const ins = db.prepare(
    "INSERT INTO subscriptions (provider, label) VALUES (?, ?)"
  );
  ins.run("claude", "Claude Code");
  ins.run("codex", "Codex");
}

export function getSettings(): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setSetting(key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
