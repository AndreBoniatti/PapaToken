import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // roda antes de cada arquivo de teste, antes dos imports dele
    setupFiles: ["./test/setup.ts"],
  },
});
