export type ProviderId = "claude" | "codex";

export interface UsageWindow {
  id: "session" | "weekly";
  usedPercent: number;
  /** ISO string; null when unknown */
  resetsAt: string | null;
  /** true when derived from local estimation rather than an authoritative source */
  estimated?: boolean;
}

export interface UsageResult {
  ok: boolean;
  windows: UsageWindow[];
  /** human-readable problem when ok=false (e.g. "não logado", "sem dados") */
  error?: string;
}

export interface TaskRow {
  id: number;
  title: string;
  prompt: string;
  provider: ProviderId | "any";
  cwd: string;
  priority: number;
  status: string;
  attempts: number;
  max_attempts: number;
  /** modelo específico (ex.: "haiku", "gpt-5.5-codex"); null = padrão do CLI */
  model: string | null;
  /** nível de raciocínio; null = padrão do CLI */
  effort: string | null;
  /** JSON array de nomes de arquivo salvos em <cwd>/anexos */
  attachments: string;
}

export function parseAttachments(task: Pick<TaskRow, "attachments">): string[] {
  try {
    const arr = JSON.parse(task.attachments ?? "[]");
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface Provider {
  id: ProviderId;
  /** CLI installed and authenticated */
  isAvailable(): Promise<boolean>;
  /** current usage, internally cached */
  getUsage(): Promise<UsageResult>;
  /** command line to execute a task headless */
  buildCommand(task: TaskRow): { cmd: string; args: string[] };
}
