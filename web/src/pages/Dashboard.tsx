import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtCost,
  fmtTokens,
  onServerEvent,
  type Stats,
  type StatsAgg,
  type SubscriptionUsage,
  type UsageResponse,
  type UsageWindow,
} from "../api";

const WINDOW_LABEL: Record<UsageWindow["id"], string> = {
  session: "Janela de 5 horas",
  weekly: "Janela semanal",
};

function fmtReset(resetsAt: string | null): string {
  if (!resetsAt) return "reset desconhecido";
  const diffMin = (new Date(resetsAt).getTime() - Date.now()) / 60_000;
  if (diffMin <= 0) return "resetada";
  const h = Math.floor(diffMin / 60);
  const m = Math.round(diffMin % 60);
  const when = new Date(resetsAt).toLocaleString("pt-BR", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return h > 0 ? `reset em ${h}h${m.toString().padStart(2, "0")} (${when})` : `reset em ${m} min (${when})`;
}

function Meter({ w }: { w: UsageWindow }) {
  const pct = Math.min(100, Math.max(0, w.usedPercent));
  const cls = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
  return (
    <div className="meter">
      <div className="meter-label">
        <span>
          {WINDOW_LABEL[w.id]}
          {w.estimated ? " (estimado)" : ""}
        </span>
        <span>
          {pct.toFixed(0)}% · {fmtReset(w.resetsAt)}
        </span>
      </div>
      <div className="meter-bar">
        <div className={`meter-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SubscriptionCard({ sub }: { sub: SubscriptionUsage }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{sub.label}</span>
        <span>
          {sub.running && <span className="badge info">executando</span>}
          {sub.blockedUntil && <span className="badge warn">bloqueado</span>}
          {sub.usage?.ok ? (
            <span className="badge ok">online</span>
          ) : (
            <span className="badge bad">sem dados</span>
          )}
        </span>
      </div>
      {sub.usage?.ok ? (
        sub.usage.windows.map((w) => <Meter key={w.id} w={w} />)
      ) : (
        <p className="error-box">{sub.usage?.error ?? "Uso indisponível."}</p>
      )}
      <div className="decision">
        {sub.decision.dispatch ? "🟢 Pronto para despachar: " : "⏸ Sem despacho: "}
        {sub.decision.reason}
      </div>
    </div>
  );
}

function HarvestStat({ label, agg }: { label: string; agg: StatsAgg }) {
  return (
    <div>
      <span className="muted">{label}</span>
      <div style={{ fontSize: "1.5rem", fontWeight: 700, margin: "2px 0" }}>
        {fmtCost(agg.cost_usd)}
      </div>
      <span className="muted" style={{ fontSize: "0.8rem" }}>
        {agg.tasks_done} tarefa(s) concluída(s) · {fmtTokens(agg.tokens_in)} in /{" "}
        {fmtTokens(agg.tokens_out)} out
      </span>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .usage()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
    api.stats().then(setStats).catch(() => setStats(null));
  }, []);

  useEffect(() => {
    load();
    const off = onServerEvent((ev) => {
      if (ev.type === "usage" || ev.type === "task") load();
    });
    const interval = setInterval(load, 60_000);
    return () => {
      off();
      clearInterval(interval);
    };
  }, [load]);

  const modeLabel: Record<string, string> = {
    window: "Janela (executa perto do reset)",
    aggressive: "Agressivo (executa sempre que sobrar)",
    paused: "Pausado",
  };

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="toolbar">
        <span className="muted">
          Modo do scheduler: <strong>{data ? modeLabel[data.mode] ?? data.mode : "…"}</strong>
        </span>
        <button
          onClick={() => {
            void api.refreshUsage().then(load);
          }}
        >
          Atualizar agora
        </button>
      </div>
      {error && <p className="error-box">{error}</p>}
      <div className="cards">
        {data?.subscriptions.map((s) => (
          <SubscriptionCard key={s.id} sub={s} />
        ))}
      </div>
      {stats && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head">
            <span className="card-title">🌾 Valor colhido</span>
            <span className="muted" style={{ fontSize: "0.78rem" }}>
              custo de API equivalente das tarefas executadas (Claude; Codex não expõe)
            </span>
          </div>
          <div style={{ display: "flex", gap: 48, flexWrap: "wrap" }}>
            <HarvestStat label="Este mês" agg={stats.month} />
            <HarvestStat label="Desde o início" agg={stats.total} />
          </div>
        </div>
      )}
    </div>
  );
}
