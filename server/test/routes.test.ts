import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

// O banco é :memory: (ver setup.ts) — cada arquivo de teste começa zerado.
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

describe("rotas de tarefas", () => {
  it("exige title e prompt", async () => {
    const res = await app.inject({ method: "POST", url: "/api/tasks", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejeita effort inválido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "t", prompt: "p", effort: "turbo" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cria tarefa sem cwd e recebe pasta gerenciada própria", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Organizar downloads", prompt: "faça x", provider: "claude" },
    });
    expect(res.statusCode).toBe(200);
    const task = res.json();
    expect(task.id).toBeTypeOf("number");
    expect(task.status).toBe("pending");
    expect(task.provider).toBe("claude");
    expect(task.cwd).toContain(`tarefa-${task.id}`);

    const list = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(list.json().some((t: { id: number }) => t.id === task.id)).toBe(true);
  });

  it("provider desconhecido vira 'any'; cwd informado é respeitado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "t", prompt: "p", provider: "gemini", cwd: "C:\\tmp\\projeto" },
    });
    const task = res.json();
    expect(task.provider).toBe("any");
    expect(task.cwd).toBe("C:\\tmp\\projeto");
  });

  it("edita uma tarefa pendente e valida o status", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "original", prompt: "p" },
      })
    ).json();

    const bad = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { status: "running" },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { title: "renomeada", status: "done" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ title: "renomeada", status: "done" });
  });

  it("exclui tarefa e responde 404 depois", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "descartável", prompt: "p" },
      })
    ).json();

    const del = await app.inject({ method: "DELETE", url: `/api/tasks/${created.id}` });
    expect(del.json()).toEqual({ ok: true });

    const gone = await app.inject({ method: "GET", url: `/api/tasks/${created.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it("responde 404 para tarefa inexistente", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tasks/99999" });
    expect(res.statusCode).toBe(404);
  });

  it("recusa atender review de tarefa sem PR", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "sem pr", prompt: "p" },
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/review`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("não tem PR");
  });

  it("valida tarefas de review de PR (URL válida + clone local; prompt opcional)", async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/tasks", payload });

    const semUrl = await post({ title: "r", kind: "pr_review", cwd: "C:\\repo" });
    expect(semUrl.statusCode).toBe(400);

    const urlRuim = await post({
      title: "r",
      kind: "pr_review",
      cwd: "C:\\repo",
      pr_url: "https://github.com/a/b",
    });
    expect(urlRuim.statusCode).toBe(400);

    const semClone = await post({
      title: "r",
      kind: "pr_review",
      pr_url: "https://github.com/a/b/pull/7",
    });
    expect(semClone.statusCode).toBe(400);

    const ok = await post({
      title: "Review do PR 7",
      kind: "pr_review",
      cwd: "C:\\repo",
      pr_url: "https://github.com/a/b/pull/7",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      kind: "pr_review",
      pr_url: "https://github.com/a/b/pull/7",
      prompt: "",
    });
  });

  it("valida os campos de entrega por PR", async () => {
    const semCwd = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "t", prompt: "p", deliver_mode: "pr" },
    });
    expect(semCwd.statusCode).toBe(400);

    const branchRuim = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "t", prompt: "p", deliver_mode: "pr", cwd: "C:\\repo", work_branch: "a..b" },
    });
    expect(branchRuim.statusCode).toBe(400);

    const modoRuim = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "t", prompt: "p", deliver_mode: "zip" },
    });
    expect(modoRuim.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "t",
        prompt: "p",
        deliver_mode: "pr",
        cwd: "C:\\repo",
        base_branch: "stage",
        work_branch: "feat/minha-branch",
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      deliver_mode: "pr",
      base_branch: "stage",
      work_branch: "feat/minha-branch",
      pr_url: null,
    });
  });

  it("lista a fila na ordem real de despacho: prioridade e, no empate, a mais antiga", async () => {
    const create = async (title: string, priority: number) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { title, prompt: "p", priority },
        })
      ).json();
    const a = await create("fila-a", 0);
    const b = await create("fila-b", 2);
    const c = await create("fila-c", 0); // empata com a — criada depois, roda depois

    const list = (await app.inject({ method: "GET", url: "/api/tasks" })).json() as {
      id: number;
      status: string;
    }[];

    const queue = list.map((t) => t.id).filter((id) => [a.id, b.id, c.id].includes(id));
    expect(queue).toEqual([b.id, a.id, c.id]);

    // concluídas/falhas aparecem depois de todas as pendentes
    const statuses = list.map((t) => t.status);
    expect(statuses.lastIndexOf("pending")).toBeLessThan(statuses.indexOf("done"));
  });
});

describe("verificação (portão de qualidade)", () => {
  it("persiste o verify_cmd e o memoriza por repositório", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          title: "t",
          prompt: "p",
          cwd: "C:\\repos\\meu-projeto",
          verify_cmd: "npm test",
        },
      })
    ).json();
    expect(created.verify_cmd).toBe("npm test");

    const info = (
      await app.inject({
        method: "GET",
        url: "/api/verify/info?path=" + encodeURIComponent("C:\\repos\\meu-projeto"),
      })
    ).json();
    expect(info.remembered).toBe("npm test");
  });

  it("rejeita comando com quebra de linha ou longo demais", async () => {
    const multiline = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "t", prompt: "p", verify_cmd: "npm test\nrm -rf /" },
    });
    expect(multiline.statusCode).toBe(400);

    const longo = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "t", prompt: "p", verify_cmd: "x".repeat(201) },
    });
    expect(longo.statusCode).toBe(400);
  });
});

describe("diretórios recentes", () => {
  it("lista cwds distintos de tarefas, excluindo pastas inexistentes", async () => {
    const fixture = (name: string) =>
      new URL(`./fixtures/suggest/${name}`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
    const nodeRepo = fixture("node-repo");
    const rustRepo = fixture("rust-repo");
    const create = (cwd: string) =>
      app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "recente", prompt: "p", cwd },
      });
    await create(nodeRepo);
    await create(nodeRepo); // repetido — deve aparecer uma vez só
    await create(rustRepo);
    await create("C:\\caminho\\que\\nao\\existe");

    const res = await app.inject({ method: "GET", url: "/api/fs/recent-dirs" });
    const dirs = res.json().dirs as string[];
    expect(dirs.filter((d) => d === nodeRepo)).toHaveLength(1);
    expect(dirs).toContain(rustRepo);
    expect(dirs).not.toContain("C:\\caminho\\que\\nao\\existe");
  });
});

describe("diagnóstico de entrega", () => {
  it("GET /api/git/doctor responde o formato esperado", async () => {
    const res = await app.inject({ method: "GET", url: "/api/git/doctor" });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    // valores dependem da máquina — o contrato de formato é o que se trava aqui
    expect(typeof d.os).toBe("string"); // a UI escolhe o comando de instalação por aqui
    expect(typeof d.git.installed).toBe("boolean");
    expect(typeof d.gh.installed).toBe("boolean");
    expect(typeof d.gh.authenticated).toBe("boolean");
  });

  it("GET /api/git/doctor?force=1 também responde o formato", async () => {
    const res = await app.inject({ method: "GET", url: "/api/git/doctor?force=1" });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().os).toBe("string");
  });
});

describe("rotas de configurações", () => {
  it("entrega os padrões", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.json()).toMatchObject({ mode: "window", safety_ceiling_pct: "90" });
  });

  it("altera o modo e rejeita valores/chaves inválidos", async () => {
    const ok = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { mode: "aggressive" },
    });
    expect(ok.json().mode).toBe("aggressive");

    const badValue = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { mode: "yolo" },
    });
    expect(badValue.statusCode).toBe(400);

    const badKey = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { hacker: "1" },
    });
    expect(badKey.statusCode).toBe(400);
  });
});
