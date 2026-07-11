import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "papatoken.db"));

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
    attachments TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// migração para bancos criados antes das colunas model/effort/attachments
const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
if (!taskCols.some((c) => c.name === "model")) db.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
if (!taskCols.some((c) => c.name === "effort")) db.exec("ALTER TABLE tasks ADD COLUMN effort TEXT");
if (!taskCols.some((c) => c.name === "attachments")) {
  db.exec("ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
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
