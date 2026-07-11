import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { db, getSettings, setSetting } from "./db.js";
import { bus } from "./events.js";
import { blockedInfo, isRunning, runTask } from "./executor.js";
import { evaluate, latestUsage, refreshUsage } from "./scheduler.js";
import type { ProviderId } from "./providers/types.js";

const SETTING_KEYS = new Set([
  "safety_ceiling_pct",
  "dispatch_window_min",
  "min_free_pct",
  "poll_interval_sec",
  "task_timeout_min",
  "mode",
  "default_workspace_dir",
  "claude_permission_mode",
]);

function listDrives(): string[] {
  const drives: string[] = [];
  for (let c = 67; c <= 90; c++) {
    // começa em C: — A:/B: (disquete) travam o existsSync em algumas máquinas
    const d = String.fromCharCode(c) + ":\\";
    if (existsSync(d)) drives.push(d);
  }
  return drives;
}

export async function registerRoutes(app: FastifyInstance) {
  // ---- usage / dashboard ----
  app.get("/api/usage", async () => {
    if (latestUsage.size === 0) await refreshUsage();
    const settings = getSettings();
    const subs = db.prepare("SELECT * FROM subscriptions").all() as {
      id: number;
      provider: ProviderId;
      label: string;
      enabled: number;
    }[];
    const blocked = blockedInfo();
    return {
      mode: settings.mode,
      subscriptions: subs.map((s) => ({
        ...s,
        usage: latestUsage.get(s.provider) ?? null,
        running: isRunning(s.provider),
        blockedUntil: blocked[s.provider] ?? null,
        decision: evaluate(s.provider, settings),
      })),
    };
  });

  app.post("/api/usage/refresh", async () => {
    await refreshUsage();
    return { ok: true };
  });

  app.get("/api/usage/history", async (req) => {
    const hours = Number((req.query as { hours?: string }).hours ?? "24");
    return db
      .prepare(
        `SELECT s.provider, u.window, u.used_percent, u.resets_at, u.captured_at
         FROM usage_snapshots u JOIN subscriptions s ON s.id = u.subscription_id
         WHERE u.captured_at >= datetime('now', ?)
         ORDER BY u.captured_at ASC`
      )
      .all(`-${hours} hours`);
  });

  // ---- tasks ----
  app.get("/api/tasks", async () => {
    return db
      .prepare(
        `SELECT id, title, provider, cwd, priority, status, created_at, started_at,
                finished_at, executed_by, exit_code, attempts, max_attempts
         FROM tasks ORDER BY
           CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
           priority DESC, created_at DESC`
      )
      .all();
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!task) return reply.code(404).send({ error: "não encontrada" });
    return task;
  });

  app.post("/api/tasks", async (req, reply) => {
    const body = req.body as {
      title?: string;
      prompt?: string;
      provider?: string;
      cwd?: string;
      priority?: number;
      max_attempts?: number;
    };
    if (!body.title || !body.prompt) {
      return reply.code(400).send({ error: "title e prompt são obrigatórios" });
    }
    const provider: string = ["claude", "codex", "any"].includes(body.provider ?? "")
      ? (body.provider as string)
      : "any";
    const cwd = (body.cwd ?? "").trim();
    const result = db
      .prepare(
        `INSERT INTO tasks (title, prompt, provider, cwd, priority, max_attempts)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.title,
        body.prompt,
        provider,
        cwd,
        body.priority ?? 0,
        body.max_attempts ?? 2
      );
    const id = result.lastInsertRowid as number;
    if (!cwd) {
      // sem diretório informado → pasta gerenciada própria da tarefa
      const base = getSettings().default_workspace_dir;
      db.prepare("UPDATE tasks SET cwd = ? WHERE id = ?").run(join(base, `tarefa-${id}`), id);
    }
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  });

  app.patch("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    if (!existing) return reply.code(404).send({ error: "não encontrada" });
    if (existing.status === "running") {
      return reply.code(409).send({ error: "tarefa em execução não pode ser editada" });
    }
    const body = req.body as Record<string, unknown>;
    const allowed = ["title", "prompt", "provider", "cwd", "priority", "status", "max_attempts"];
    const updates = allowed.filter((k) => body[k] !== undefined);
    if (updates.length === 0) return reply.code(400).send({ error: "nada para atualizar" });
    if (body.status !== undefined && !["pending", "blocked", "done", "failed"].includes(String(body.status))) {
      return reply.code(400).send({ error: "status inválido" });
    }
    const sql = `UPDATE tasks SET ${updates.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
    db.prepare(sql).run(...updates.map((k) => body[k] as string | number), id);
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  });

  app.delete("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    if (!existing) return reply.code(404).send({ error: "não encontrada" });
    if (existing.status === "running") {
      return reply.code(409).send({ error: "tarefa em execução não pode ser excluída" });
    }
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return { ok: true };
  });

  app.post("/api/tasks/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { provider?: ProviderId };

    const task = db.prepare("SELECT id, status, provider FROM tasks WHERE id = ?").get(id) as
      | { id: number; status: string; provider: string }
      | undefined;
    if (!task) return reply.code(404).send({ error: "não encontrada" });
    if (task.status === "running") {
      return reply.code(409).send({ error: "tarefa já está em execução" });
    }
    const providerId = body.provider ?? (task.provider === "any" ? "claude" : task.provider);
    if (isRunning(providerId as ProviderId)) {
      return reply.code(409).send({ error: `${providerId} já tem uma tarefa em execução` });
    }

    // fire and forget; status updates flow through SSE — the catch keeps a
    // rejected run from becoming an unhandled rejection (which kills o processo)
    runTask(task.id, body.provider).catch((err) => {
      app.log.error(err, `falha ao executar tarefa ${task.id}`);
    });
    return { ok: true };
  });

  // ---- navegador de diretórios (app local, single-user) ----
  app.get("/api/fs/browse", async (req, reply) => {
    const q = ((req.query as { path?: string }).path ?? "").trim();
    const isWindows = process.platform === "win32";

    // raiz: no Windows é a lista de unidades; no POSIX é "/"
    if (!q && isWindows) {
      return { path: null, parent: null, dirs: listDrives(), home: homedir(), sep };
    }
    const path = resolve(q || "/");
    try {
      const dirs = readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("$"))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, "pt-BR"));
      const parentDir = dirname(path);
      // na raiz de uma unidade Windows, "" leva de volta à lista de unidades
      const parent =
        parentDir === path ? (isWindows ? "" : null) : parentDir;
      return { path, parent, dirs, home: homedir(), sep };
    } catch {
      return reply.code(400).send({ error: `Não foi possível ler ${path}` });
    }
  });

  // ---- settings ----
  app.get("/api/settings", async () => getSettings());

  app.patch("/api/settings", async (req, reply) => {
    const body = req.body as Record<string, string>;
    for (const [k, v] of Object.entries(body)) {
      if (!SETTING_KEYS.has(k)) return reply.code(400).send({ error: `chave inválida: ${k}` });
      if (k === "mode" && !["window", "aggressive", "paused"].includes(v)) {
        return reply.code(400).send({ error: "mode deve ser window | aggressive | paused" });
      }
      if (
        k === "claude_permission_mode" &&
        !["acceptEdits", "bypassPermissions"].includes(v)
      ) {
        return reply
          .code(400)
          .send({ error: "claude_permission_mode deve ser acceptEdits | bypassPermissions" });
      }
      setSetting(k, String(v));
    }
    return getSettings();
  });

  // ---- SSE ----
  app.get("/api/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    reply.raw.write(": connected\n\n");

    const onEvent = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);

    bus.on("event", onEvent);
    req.raw.on("close", () => {
      bus.off("event", onEvent);
      clearInterval(heartbeat);
    });
  });
}
