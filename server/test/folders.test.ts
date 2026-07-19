import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

interface FolderJson {
  id: number;
  name: string;
  parent_id: number | null;
}

describe("pastas lógicas de tarefas", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, payload });

  it("cria, aninha e lista pastas; valida nome e pai", async () => {
    const raiz = (await post("/api/folders", { name: "Projetos" })).json() as FolderJson;
    expect(raiz.parent_id).toBeNull();
    const sub = (
      await post("/api/folders", { name: "Reviews", parent_id: raiz.id })
    ).json() as FolderJson;
    expect(sub.parent_id).toBe(raiz.id);

    const list = (await app.inject({ method: "GET", url: "/api/folders" })).json() as FolderJson[];
    expect(list.map((f) => f.name)).toEqual(expect.arrayContaining(["Projetos", "Reviews"]));

    expect((await post("/api/folders", { name: "  " })).statusCode).toBe(400);
    expect((await post("/api/folders", { name: "x", parent_id: 9999 })).statusCode).toBe(400);
  });

  it("tarefa nasce na pasta indicada e pode ser movida (inclusive para a raiz)", async () => {
    const pasta = (await post("/api/folders", { name: "Recorrentes" })).json() as FolderJson;
    const t = (
      await post("/api/tasks", { title: "t", prompt: "p", folder_id: pasta.id })
    ).json() as { id: number; folder_id: number | null };
    expect(t.folder_id).toBe(pasta.id);

    expect(
      (await post("/api/tasks", { title: "t2", prompt: "p", folder_id: 9999 })).statusCode
    ).toBe(400);

    const moved = (
      await app.inject({
        method: "PATCH",
        url: `/api/tasks/${t.id}`,
        payload: { folder_id: null },
      })
    ).json() as { folder_id: number | null };
    expect(moved.folder_id).toBeNull();
  });

  it("renomeia e move pastas, recusando ciclo", async () => {
    const a = (await post("/api/folders", { name: "A" })).json() as FolderJson;
    const b = (await post("/api/folders", { name: "B", parent_id: a.id })).json() as FolderJson;

    const ren = (
      await app.inject({
        method: "PATCH",
        url: `/api/folders/${a.id}`,
        payload: { name: "A2" },
      })
    ).json() as FolderJson;
    expect(ren.name).toBe("A2");

    // mover A para dentro da própria descendente criaria ciclo
    const cyc = await app.inject({
      method: "PATCH",
      url: `/api/folders/${a.id}`,
      payload: { parent_id: b.id },
    });
    expect(cyc.statusCode).toBe(400);

    const mv = (
      await app.inject({
        method: "PATCH",
        url: `/api/folders/${b.id}`,
        payload: { parent_id: null },
      })
    ).json() as FolderJson;
    expect(mv.parent_id).toBeNull();
  });

  it("excluir pasta reparenta subpastas e tarefas para o pai", async () => {
    const pai = (await post("/api/folders", { name: "Pai" })).json() as FolderJson;
    const meio = (await post("/api/folders", { name: "Meio", parent_id: pai.id })).json() as FolderJson;
    const filho = (
      await post("/api/folders", { name: "Filho", parent_id: meio.id })
    ).json() as FolderJson;
    const t = (
      await post("/api/tasks", { title: "dentro", prompt: "p", folder_id: meio.id })
    ).json() as { id: number };

    const del = await app.inject({ method: "DELETE", url: `/api/folders/${meio.id}` });
    expect(del.statusCode).toBe(200);

    const list = (await app.inject({ method: "GET", url: "/api/folders" })).json() as FolderJson[];
    expect(list.some((f) => f.id === meio.id)).toBe(false);
    expect(list.find((f) => f.id === filho.id)?.parent_id).toBe(pai.id);

    const task = (
      await app.inject({ method: "GET", url: `/api/tasks/${t.id}` })
    ).json() as { folder_id: number | null };
    expect(task.folder_id).toBe(pai.id);
  });
});
