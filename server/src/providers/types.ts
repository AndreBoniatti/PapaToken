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
