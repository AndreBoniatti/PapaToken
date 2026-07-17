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
  /** "pr": ao concluir, commit + push + PR no GitHub a partir de uma worktree */
  deliver_mode: "none" | "pr";
  /** branch de origem e alvo do PR; null = branch padrão do remote */
  base_branch: string | null;
  /** nome da branch de trabalho; null = template das configurações */
  work_branch: string | null;
  /** URL do PR aberto, quando houver */
  pr_url: string | null;
  /** comando de verificação rodado após a IA (portão de qualidade); null = sem verificação */
  verify_cmd: string | null;
  /** custo acumulado em valor de API equivalente (só Claude expõe); null = sem dado */
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  /** exec: executa o prompt; pr_review: revisa o PR em pr_url e comenta nele */
  kind: "exec" | "pr_review";
  /** recorrência: minutos entre o fim de um ciclo e a volta à fila; null = não repete */
  recur_minutes: number | null;
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
