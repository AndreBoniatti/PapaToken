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

/**
 * Tarefas recorrentes cujo intervalo venceu voltam para a fila. Re-arma a
 * PRÓPRIA tarefa (done/failed → pending, tentativas zeradas) em vez de clonar:
 * o histórico de cada ciclo já fica preservado em task_runs. Falha também
 * re-arma — recorrente significa "tente de novo no próximo ciclo".
 */
export function reactivateRecurring(): number {
  const due = db
    .prepare(
      `SELECT id FROM tasks
       WHERE recur_minutes IS NOT NULL AND recur_minutes > 0
         AND status IN ('done', 'failed')
         AND finished_at IS NOT NULL
         AND datetime(finished_at, '+' || recur_minutes || ' minutes') <= datetime('now')`
    )
    .all() as { id: number }[];
  const rearm = db.prepare("UPDATE tasks SET status = 'pending', attempts = 0 WHERE id = ?");
  for (const { id } of due) {
    rearm.run(id);
    emit({ type: "task", taskId: id, status: "pending" });
  }
  return due.length;
}

async function tick() {
  const settings = getSettings();
  await refreshUsage();

  // mesmo pausado a fila reflete a recorrência — só o despacho fica bloqueado
  const rearmed = reactivateRecurring();
  if (rearmed > 0) {
    emit({
      type: "scheduler",
      message: `${rearmed} tarefa(s) recorrente(s) voltaram para a fila`,
    });
  }

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
  return decide(
    {
      usage: latestUsage.get(provider),
      running: isRunning(provider),
      blocked: isBlocked(provider),
    },
    settings
  );
}

/** Estado que a decisão de despacho consome — injetável nos testes. */
export interface DecisionInput {
  usage: UsageResult | undefined;
  running: boolean;
  blocked: boolean;
  /** epoch ms; padrão Date.now() */
  now?: number;
}

export function decide(
  input: DecisionInput,
  settings: Record<string, string>
): { dispatch: boolean; reason: string } {
  const { usage } = input;
  const now = input.now ?? Date.now();
  if (!usage || !usage.ok) return { dispatch: false, reason: "sem dados de uso" };
  if (input.running) return { dispatch: false, reason: "já executando" };
  if (input.blocked) return { dispatch: false, reason: "bloqueado por rate limit" };

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
  const minutesToReset = (new Date(session.resetsAt).getTime() - now) / 60_000;
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
       ORDER BY priority DESC, created_at ASC, id ASC
       LIMIT 1`
    )
    .get(provider) as { id: number; title: string } | undefined;
}
