import { db, getSettings } from "./db.js";
import { emit } from "./events.js";
import { providers } from "./providers/index.js";
import type { ProviderId, UsageResult } from "./providers/types.js";
import { isBlocked, isRunning, runTask } from "./executor.js";

const TICK_MS = 60_000;

interface SubscriptionRow {
  id: number;
  provider: ProviderId;
  label: string;
  enabled: number;
}

/** last persisted snapshot per subscription (epoch ms) */
const lastPersist = new Map<number, number>();
/** latest usage per provider, for the API/dashboard */
export const latestUsage = new Map<ProviderId, UsageResult>();

let timer: NodeJS.Timeout | null = null;

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => void tick().catch(console.error), TICK_MS);
  void tick().catch(console.error);
}

export async function refreshUsage(): Promise<Map<ProviderId, UsageResult>> {
  const subs = db
    .prepare("SELECT * FROM subscriptions WHERE enabled = 1")
    .all() as unknown as SubscriptionRow[];
  for (const sub of subs) {
    const provider = providers[sub.provider];
    if (!provider) continue;
    const usage = await provider.getUsage();
    latestUsage.set(sub.provider, usage);
    persistSnapshot(sub, usage);
  }
  emit({ type: "usage" });
  return latestUsage;
}

function persistSnapshot(sub: SubscriptionRow, usage: UsageResult) {
  if (!usage.ok) return;
  const settings = getSettings();
  const intervalMs = Number(settings.poll_interval_sec ?? "180") * 1000;
  const last = lastPersist.get(sub.id) ?? 0;
  if (Date.now() - last < intervalMs) return;
  lastPersist.set(sub.id, Date.now());
  const ins = db.prepare(
    "INSERT INTO usage_snapshots (subscription_id, window, used_percent, resets_at) VALUES (?, ?, ?, ?)"
  );
  for (const w of usage.windows) {
    ins.run(sub.id, w.id, w.usedPercent, w.resetsAt);
  }
}

async function tick() {
  const settings = getSettings();
  await refreshUsage();

  if (settings.mode === "paused") return;

  const subs = db
    .prepare("SELECT * FROM subscriptions WHERE enabled = 1")
    .all() as unknown as SubscriptionRow[];

  for (const sub of subs) {
    const decision = evaluate(sub.provider, settings);
    if (!decision.dispatch) continue;

    const task = nextTask(sub.provider);
    if (!task) continue;

    emit({
      type: "scheduler",
      message: `Despachando tarefa #${task.id} (“${task.title}”) para ${sub.provider}: ${decision.reason}`,
    });
    // fire and forget — executor serializes per provider
    void runTask(task.id, sub.provider).catch((err) =>
      emit({ type: "scheduler", message: `Erro ao executar #${task.id}: ${err.message}` })
    );
  }
}

export function evaluate(
  provider: ProviderId,
  settings: Record<string, string>
): { dispatch: boolean; reason: string } {
  const usage = latestUsage.get(provider);
  if (!usage || !usage.ok) return { dispatch: false, reason: "sem dados de uso" };
  if (isRunning(provider)) return { dispatch: false, reason: "já executando" };
  if (isBlocked(provider)) return { dispatch: false, reason: "bloqueado por rate limit" };

  const ceiling = Number(settings.safety_ceiling_pct ?? "90");
  const minFree = Number(settings.min_free_pct ?? "15");
  const windowMin = Number(settings.dispatch_window_min ?? "60");

  const session = usage.windows.find((w) => w.id === "session");
  const weekly = usage.windows.find((w) => w.id === "weekly");

  if (weekly && weekly.usedPercent >= ceiling) {
    return { dispatch: false, reason: `janela semanal em ${weekly.usedPercent}% (teto ${ceiling}%)` };
  }
  if (!session) return { dispatch: false, reason: "sem janela de sessão" };
  if (session.usedPercent >= ceiling) {
    return { dispatch: false, reason: `janela 5h em ${session.usedPercent}% (teto ${ceiling}%)` };
  }
  const free = ceiling - session.usedPercent;
  if (free < minFree) {
    return { dispatch: false, reason: `sobra de ${free.toFixed(0)}% < mínimo de ${minFree}%` };
  }

  if (settings.mode === "aggressive") {
    return { dispatch: true, reason: `modo agressivo, ${free.toFixed(0)}% livres` };
  }

  // mode = window: only dispatch near the session-window reset
  if (!session.resetsAt) return { dispatch: false, reason: "reset da janela desconhecido" };
  const minutesToReset = (new Date(session.resetsAt).getTime() - Date.now()) / 60_000;
  if (minutesToReset <= windowMin) {
    return {
      dispatch: true,
      reason: `faltam ${minutesToReset.toFixed(0)} min para o reset e ${free.toFixed(0)}% livres`,
    };
  }
  return {
    dispatch: false,
    reason: `fora da janela de despacho (${minutesToReset.toFixed(0)} min para o reset > ${windowMin} min)`,
  };
}

function nextTask(provider: ProviderId) {
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'pending' AND (provider = ? OR provider = 'any')
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`
    )
    .get(provider) as { id: number; title: string } | undefined;
}
