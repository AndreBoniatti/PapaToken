import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { registerRoutes } from "./routes.js";

/**
 * Monta o app HTTP com todas as rotas, sem efeitos colaterais de deploy
 * (não escuta porta, não inicia o scheduler, não serve o web/dist) —
 * é o que os testes usam com app.inject().
 */
export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ? { level: "info" } : false });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  });
  await registerRoutes(app);
  return app;
}
