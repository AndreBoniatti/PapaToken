import type { Provider, ProviderId } from "./types.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";

export const providers: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

export function getProvider(id: string): Provider | undefined {
  return providers[id as ProviderId];
}
