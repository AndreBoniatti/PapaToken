export interface UsageWindow {
  id: "session" | "weekly";
  usedPercent: number;
  resetsAt: string | null;
  estimated?: boolean;
}

export interface UsageResult {
  ok: boolean;
  windows: UsageWindow[];
  error?: string;
}

export interface SubscriptionUsage {
  id: number;
  provider: "claude" | "codex";
  label: string;
  enabled: number;
  usage: UsageResult | null;
  running: boolean;
  blockedUntil: string | null;
  decision: { dispatch: boolean; reason: string };
}

export interface UsageResponse {
  mode: string;
  subscriptions: SubscriptionUsage[];
}

export interface Task {
  id: number;
  title: string;
  prompt?: string;
  provider: "claude" | "codex" | "any";
  cwd: string;
  priority: number;
  status: "pending" | "running" | "done" | "failed" | "blocked";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  executed_by: string | null;
  exit_code: number | null;
  output_log?: string | null;
  attempts: number;
  max_attempts: number;
  model?: string | null;
  effort?: string | null;
  /** JSON array (string) com os nomes dos arquivos em <cwd>/anexos */
  attachments?: string;
  /** "pr": ao concluir, abre Pull Request no GitHub */
  deliver_mode?: "none" | "pr";
  base_branch?: string | null;
  work_branch?: string | null;
  pr_url?: string | null;
  /** desfecho da última entrega; null = ainda não entregou */
  deliver_status?: "created" | "no_changes" | "failed" | null;
  /** exec: executa o prompt; pr_review: revisa o PR em pr_url e comenta nele */
  kind?: "exec" | "pr_review";
  /** comando de verificação (portão de qualidade); null = sem verificação */
  verify_cmd?: string | null;
  /** custo acumulado em valor de API equivalente (só Claude expõe) */
  cost_usd?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
}

export interface StatsAgg {
  tasks_done: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

export interface Stats {
  month: StatsAgg;
  total: StatsAgg;
}

export function fmtCost(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v > 0 && v < 0.01) return "< US$ 0,01";
  return (
    "US$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "M";
  if (n >= 1_000) return Math.round(n / 1_000).toLocaleString("pt-BR") + "k";
  return String(n);
}

/** Níveis de prioridade da UI — o banco guarda o inteiro, então valores
 *  fora da lista (tarefas antigas) continuam válidos e aparecem como número. */
export const PRIORITY_OPTIONS = [
  { value: 2, label: "Urgente" },
  { value: 1, label: "Alta" },
  { value: 0, label: "Normal" },
  { value: -1, label: "Baixa" },
];

export function priorityLabel(p: number): string {
  return PRIORITY_OPTIONS.find((o) => o.value === p)?.label ?? String(p);
}

export function taskAttachments(task: Pick<Task, "attachments">): string[] {
  try {
    const arr = JSON.parse(task.attachments ?? "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export type Settings = Record<string, string>;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Content-Type só quando há corpo — Fastify responde 400 para JSON com corpo vazio
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface GitDoctor {
  /** plataforma do servidor: "win32" | "linux" | "darwin" | … */
  os: string;
  git: { installed: boolean; version: string | null };
  gh: { installed: boolean; authenticated: boolean; account: string | null };
}

export interface BrowseResult {
  path: string | null;
  parent: string | null;
  dirs: string[];
  home: string;
  /** separador de caminho do SO do servidor ("\\" ou "/") */
  sep: string;
}

export const api = {
  usage: () => request<UsageResponse>("/api/usage"),
  browse: (path?: string) =>
    request<BrowseResult>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  recentDirs: () => request<{ dirs: string[] }>("/api/fs/recent-dirs"),
  gitBranches: (path: string) =>
    request<{ repo: boolean; branches: string[] }>(
      `/api/git/branches?path=${encodeURIComponent(path)}`
    ),
  gitDoctor: (force?: boolean) =>
    request<GitDoctor>(`/api/git/doctor${force ? "?force=1" : ""}`),
  verifyInfo: (path: string) =>
    request<{ remembered: string | null; suggestions: string[] }>(
      `/api/verify/info?path=${encodeURIComponent(path)}`
    ),
  refreshUsage: () => request<{ ok: boolean }>("/api/usage/refresh", { method: "POST" }),
  tasks: () => request<Task[]>("/api/tasks"),
  task: (id: number | string) => request<Task>(`/api/tasks/${id}`),
  createTask: (t: Partial<Task>) =>
    request<Task>("/api/tasks", { method: "POST", body: JSON.stringify(t) }),
  updateTask: (id: number, t: Partial<Task>) =>
    request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(t) }),
  deleteTask: (id: number) =>
    request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
  runTask: (id: number, provider?: string) =>
    request<{ ok: boolean }>(`/api/tasks/${id}/run`, {
      method: "POST",
      body: JSON.stringify(provider ? { provider } : {}),
    }),
  reviewTask: (id: number) =>
    request<{ ok: boolean }>(`/api/tasks/${id}/review`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  // multipart: sem Content-Type manual — o browser define o boundary
  uploadAttachments: async (id: number, files: File[]): Promise<Task> => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    const res = await fetch(`/api/tasks/${id}/attachments`, { method: "POST", body: fd });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as { error?: string }).error ?? res.statusText);
    }
    return res.json() as Promise<Task>;
  },
  deleteAttachment: (id: number, name: string) =>
    request<Task>(`/api/tasks/${id}/attachments/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  stats: () => request<Stats>("/api/stats"),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (s: Settings) =>
    request<Settings>("/api/settings", { method: "PATCH", body: JSON.stringify(s) }),
};

/** Subscribe to server events; returns unsubscribe. */
export function onServerEvent(handler: (event: { type: string }) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (e) => {
    try {
      handler(JSON.parse(e.data));
    } catch {
      // ignore malformed events
    }
  };
  return () => source.close();
}
