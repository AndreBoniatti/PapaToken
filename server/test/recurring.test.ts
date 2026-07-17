import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { reactivateRecurring } from "../src/scheduler.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

/** insere uma tarefa direto no banco com o desfecho e a idade desejados */
function seedTask(opts: {
  status: string;
  recurMinutes: number | null;
  finishedAgoMinutes: number | null;
  attempts?: number;
}): number {
  const r = db
    .prepare(
      `INSERT INTO tasks (title, prompt, cwd, status, recur_minutes, attempts, finished_at)
       VALUES ('t', 'p', '', ?, ?, ?,
               CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '-' || ? || ' minutes') END)`
    )
    .run(
      opts.status,
      opts.recurMinutes,
      opts.attempts ?? 2,
      opts.finishedAgoMinutes,
      opts.finishedAgoMinutes
    );
  return Number(r.lastInsertRowid);
}

function statusOf(id: number): { status: string; attempts: number } {
  return db.prepare("SELECT status, attempts FROM tasks WHERE id = ?").get(id) as {
    status: string;
    attempts: number;
  };
}

describe("reactivateRecurring", () => {
  it("re-arma done e failed vencidas, zerando as tentativas", () => {
    const done = seedTask({ status: "done", recurMinutes: 1440, finishedAgoMinutes: 1500 });
    const failed = seedTask({ status: "failed", recurMinutes: 60, finishedAgoMinutes: 61 });
    const n = reactivateRecurring();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(statusOf(done)).toEqual({ status: "pending", attempts: 0 });
    expect(statusOf(failed)).toEqual({ status: "pending", attempts: 0 });
  });

  it("não re-arma antes do intervalo vencer", () => {
    const id = seedTask({ status: "done", recurMinutes: 1440, finishedAgoMinutes: 100 });
    reactivateRecurring();
    expect(statusOf(id).status).toBe("done");
  });

  it("não mexe em tarefas sem recorrência, bloqueadas ou sem finished_at", () => {
    const plain = seedTask({ status: "done", recurMinutes: null, finishedAgoMinutes: 99999 });
    const blocked = seedTask({ status: "blocked", recurMinutes: 60, finishedAgoMinutes: 99999 });
    const unfinished = seedTask({ status: "failed", recurMinutes: 60, finishedAgoMinutes: null });
    reactivateRecurring();
    expect(statusOf(plain).status).toBe("done");
    expect(statusOf(blocked).status).toBe("blocked");
    expect(statusOf(unfinished).status).toBe("failed");
  });
});

describe("rotas com recur_minutes", () => {
  it("cria tarefa recorrente; 0/vazio viram NULL (não repete)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "semanal", prompt: "p", recur_minutes: 10080 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().recur_minutes).toBe(10080);

    const none = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "única", prompt: "p", recur_minutes: 0 },
    });
    expect(none.json().recur_minutes).toBeNull();
  });

  it("rejeita valores inválidos (mínimo 60 min, inteiro)", async () => {
    for (const recur_minutes of [30, -5, 1.5, "abc"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "t", prompt: "p", recur_minutes },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("PATCH liga e desliga a recorrência de uma tarefa existente", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "t", prompt: "p" },
    });
    const id = created.json().id;

    const on = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      payload: { recur_minutes: 1440 },
    });
    expect(on.json().recur_minutes).toBe(1440);

    const off = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      payload: { recur_minutes: "" },
    });
    expect(off.json().recur_minutes).toBeNull();
  });
});
