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
