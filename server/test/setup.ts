import { fileURLToPath } from "node:url";

// Banco em memória — nenhum teste toca o server/data/papatoken.db real.
process.env.PAPATOKEN_DB = ":memory:";

// Sessões do Codex vêm das fixtures, não do ~/.codex da máquina.
process.env.CODEX_HOME = fileURLToPath(new URL("./fixtures/codex-home", import.meta.url));
