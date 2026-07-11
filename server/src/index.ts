import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerRoutes } from "./routes.js";
import { startScheduler } from "./scheduler.js";
import { db } from "./db.js";

// A daemon must survive stray rejections (e.g. de spawns em background)
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

// Tarefas que ficaram 'running' porque o servidor caiu no meio da execução
const recovered = db
  .prepare(
    `UPDATE tasks
     SET status = 'pending',
         output_log = COALESCE(output_log, '') || char(10) ||
           '[recovery] servidor reiniciou durante a execução — tarefa devolvida à fila'
     WHERE status = 'running'`
  )
  .run();
if (Number(recovered.changes) > 0) {
  console.log(`[recovery] ${recovered.changes} tarefa(s) devolvida(s) à fila`);
}

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "..", "..", "web", "dist");

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});
await registerRoutes(app);

if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // SPA fallback for client-side routes
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api/")) {
      return reply.code(404).send({ error: "rota não encontrada" });
    }
    return reply.sendFile("index.html");
  });
}

const PORT = Number(process.env.PORT ?? 3333);
await app.listen({ port: PORT, host: "127.0.0.1" });
startScheduler();
console.log(`PapaToken server em http://127.0.0.1:${PORT}`);
