import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  fmtCost,
  fmtTokens,
  onServerEvent,
  priorityLabel,
  RECUR_OPTIONS,
  recurLabel,
  taskAttachments,
  type Task,
  type TaskRun,
} from "../api";

const RUN_TYPE_LABEL: Record<TaskRun["run_type"], string> = {
  exec: "execução",
  review_attend: "atendimento de review",
  pr_review: "code review",
};

const RUN_STATUS_LABEL: Record<TaskRun["status"], string> = {
  running: "executando",
  done: "concluída",
  failed: "falhou",
  pending: "devolvida à fila",
};

/** <pre> do markdown com botão de copiar */
function CodeBlock(props: React.ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = (preRef.current?.innerText ?? "").replace(/\n$/, "");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback para contextos sem clipboard API
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block">
      <button type="button" className={`copy-btn ${copied ? "copied" : ""}`} onClick={() => void copy()}>
        {copied ? "✓ copiado" : "copiar"}
      </button>
      <pre ref={preRef} {...props} />
    </div>
  );
}

interface ClaudeEnvelope {
  type: string;
  is_error: boolean;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface ParsedLog {
  envelope: ClaudeEnvelope | null;
  /** [executor]/[recovery] annotations appended after the output */
  notes: string[];
  /** stderr section, when present */
  stderr: string | null;
  /** output text without envelope/notes (codex or plain runs) */
  plain: string | null;
  raw: string;
}

function parseLog(log: string): ParsedLog {
  let body = log;
  let stderr: string | null = null;
  const stderrIdx = log.indexOf("\n[stderr]\n");
  if (stderrIdx !== -1) {
    body = log.slice(0, stderrIdx);
    stderr = log.slice(stderrIdx + "\n[stderr]\n".length);
  }

  const notes: string[] = [];
  const contentLines: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\[(executor|recovery|setup)\]/.test(line.trim())) notes.push(line.trim());
    else contentLines.push(line);
  }
  // notes appended to stderr section also count
  if (stderr) {
    const kept: string[] = [];
    for (const line of stderr.split("\n")) {
      if (/^\[(executor|recovery|setup)\]/.test(line.trim())) notes.push(line.trim());
      else kept.push(line);
    }
    stderr = kept.join("\n").trim() || null;
  }

  const content = contentLines.join("\n").trim();
  let envelope: ClaudeEnvelope | null = null;
  for (const candidate of [content, ...content.split("\n")]) {
    const c = candidate.trim();
    if (!c.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(c);
      if (parsed && parsed.type === "result" && typeof parsed.is_error === "boolean") {
        envelope = parsed;
        break;
      }
    } catch {
      /* not JSON — fall through to plain text */
    }
  }

  return {
    envelope,
    notes,
    stderr,
    plain: envelope ? null : content || null,
    raw: log,
  };
}

function fmtDate(s: string | null): string {
  return s ? new Date(s + "Z").toLocaleString("pt-BR") : "—";
}

function fmtDuration(ms?: number): string | null {
  if (!ms) return null;
  const sec = ms / 1000;
  if (sec < 90) return `${sec.toFixed(0)}s`;
  return `${Math.floor(sec / 60)}min ${Math.round(sec % 60)}s`;
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="meta-item">
      <span className="meta-label">{label}</span>
      <span className="meta-value">{children}</span>
    </div>
  );
}

function LogView({ log, done }: { log: string; done: boolean }) {
  const parsed = parseLog(log);

  return (
    <div>
      {parsed.notes.length > 0 && (
        <div className="notices">
          {parsed.notes.map((n, i) => (
            <div key={i} className="notice">
              ⚠ {n.replace(/^\[(executor|recovery|setup)\]\s*/, "")}
            </div>
          ))}
        </div>
      )}

      {parsed.envelope && (
        <>
          <div className="chips">
            <span className={`chip ${parsed.envelope.is_error ? "chip-bad" : "chip-ok"}`}>
              {parsed.envelope.is_error ? "erro" : "sucesso"}
            </span>
            {fmtDuration(parsed.envelope.duration_ms) && (
              <span className="chip">⏱ {fmtDuration(parsed.envelope.duration_ms)}</span>
            )}
            {parsed.envelope.num_turns !== undefined && (
              <span className="chip">{parsed.envelope.num_turns} turnos</span>
            )}
            {parsed.envelope.usage?.output_tokens !== undefined && (
              <span className="chip">
                tokens: {parsed.envelope.usage.input_tokens ?? 0} in /{" "}
                {parsed.envelope.usage.output_tokens} out
              </span>
            )}
            {parsed.envelope.total_cost_usd !== undefined && (
              <span className="chip">
                ~US$ {parsed.envelope.total_cost_usd.toFixed(2)} (valor de API equivalente)
              </span>
            )}
          </div>
          <div className="result-box">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
              {parsed.envelope.result ?? "*(sem texto de resultado)*"}
            </ReactMarkdown>
          </div>
        </>
      )}

      {/* Saída sem envelope (ex.: Codex). Em tarefas concluídas é markdown —
          renderiza como o resultado do Claude; em falhas, mantém o texto cru
          (onde ver o literal do erro é o que importa). */}
      {parsed.plain &&
        (done ? (
          <div className="result-box">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
              {parsed.plain}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="log">{parsed.plain}</div>
        ))}

      {parsed.stderr && (
        <details className="raw-details">
          <summary>stderr</summary>
          <div className="log">{parsed.stderr}</div>
        </details>
      )}

      {parsed.envelope && (
        <details className="raw-details">
          <summary>Ver saída bruta (JSON)</summary>
          <div className="log">{parsed.raw}</div>
        </details>
      )}
    </div>
  );
}

export default function TaskDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runProvider, setRunProvider] = useState<string>("");
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api.task(id).then(setTask).catch((e) => setError(e.message));
    api.taskRuns(id).then(setRuns).catch(() => setRuns([]));
  }, [id]);

  useEffect(() => {
    load();
    const off = onServerEvent((ev) => {
      if (ev.type === "task") load();
    });
    return off;
  }, [load]);

  if (error && !task) return <p className="error-box">{error}</p>;
  if (!task) return <p className="muted">Carregando…</p>;

  const run = async () => {
    try {
      await api.runTask(task.id, runProvider || undefined);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const review = async () => {
    try {
      await api.reviewTask(task.id);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const reReview = async () => {
    try {
      await api.reReviewTask(task.id);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const requeue = async () => {
    try {
      await api.updateTask(task.id, { status: "pending" } as Partial<Task>);
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!confirm(`Excluir a tarefa #${task.id} “${task.title}”?`)) return;
    try {
      await api.deleteTask(task.id);
      navigate("/tasks");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const providerName: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    any: "Qualquer",
  };

  const isImage = (name: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
  const attachmentUrl = (name: string) =>
    `/api/tasks/${task.id}/attachments/${encodeURIComponent(name)}`;

  return (
    <div className="task-detail">
      <p>
        <Link to="/tasks" className="muted">
          ← voltar para tarefas
        </Link>
      </p>

      <div className="detail-header">
        <h1>
          <span className="muted">#{task.id}</span> {task.title}
        </h1>
        <span className={`status ${task.status}`}>{task.status}</span>
      </div>

      <div className="card">
        <div className="meta-grid">
          <Meta label="IA designada">{providerName[task.provider] ?? task.provider}</Meta>
          <Meta label="Executada por">{task.executed_by ?? "—"}</Meta>
          <Meta label="Modelo">{task.model ?? "padrão"}</Meta>
          <Meta label="Effort">{task.effort ?? "padrão"}</Meta>
          <Meta label="Prioridade">{priorityLabel(task.priority)}</Meta>
          <Meta label="Repetição">
            <select
              value={task.recur_minutes ?? 0}
              disabled={task.status === "running"}
              onChange={(e) => {
                const minutes = Number(e.target.value);
                void api
                  .updateTask(task.id, { recur_minutes: minutes || null } as Partial<Task>)
                  .then(() => load())
                  .catch((err) => setError((err as Error).message));
              }}
              title="recorrente: ao concluir (ou falhar), volta à fila depois deste intervalo"
            >
              {RECUR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {(task.recur_minutes ?? 0) > 0 &&
                !RECUR_OPTIONS.some((o) => o.value === task.recur_minutes) && (
                  <option value={task.recur_minutes!}>{recurLabel(task.recur_minutes)}</option>
                )}
            </select>
          </Meta>
          <Meta label="Tentativas">
            {task.attempts}/{task.max_attempts}
          </Meta>
          <Meta label="Criada">{fmtDate(task.created_at)}</Meta>
          <Meta label="Iniciada">{fmtDate(task.started_at)}</Meta>
          <Meta label="Finalizada">{fmtDate(task.finished_at)}</Meta>
          <Meta label="Exit code">{task.exit_code ?? "—"}</Meta>
          <Meta label="Custo (API equiv.)">{fmtCost(task.cost_usd)}</Meta>
          <Meta label="Tokens">
            {(() => {
              const ti = task.tokens_in ?? 0;
              const to = task.tokens_out ?? 0;
              const total = ti + to;
              if (total === 0) return "—";
              // Claude separa entrada/saída; Codex dá só o total
              return ti > 0 && to > 0
                ? `${fmtTokens(total)} (${fmtTokens(ti)} in / ${fmtTokens(to)} out)`
                : `${fmtTokens(total)} tokens`;
            })()}
          </Meta>
          <Meta label="Verificação">
            {task.verify_cmd ? <span className="mono">{task.verify_cmd}</span> : "—"}
          </Meta>
          <Meta label={task.kind === "pr_review" ? "PR revisado" : "Entrega"}>
            {task.kind === "pr_review" ? (
              task.pr_url ? (
                <a href={task.pr_url} target="_blank" rel="noreferrer">
                  Pull Request ↗
                </a>
              ) : (
                "—"
              )
            ) : task.deliver_mode !== "pr" ? (
              "só executar"
            ) : task.pr_url ? (
              <a href={task.pr_url} target="_blank" rel="noreferrer">
                Pull Request ↗
              </a>
            ) : task.deliver_status === "no_changes" ? (
              "sem alterações — PR não criado"
            ) : task.deliver_status === "failed" ? (
              "entrega falhou — veja o log da execução"
            ) : (
              `PR pendente${task.base_branch ? ` (base: ${task.base_branch})` : ""}`
            )}
          </Meta>
          <div className="meta-item meta-wide">
            <span className="meta-label">Diretório de trabalho</span>
            <span className="meta-value mono">{task.cwd}</span>
          </div>
          <div className="meta-item meta-wide">
            <span className="meta-label">Anexos</span>
            <span className="meta-value">
              {taskAttachments(task).length === 0 && <span className="muted">nenhum</span>}
              {taskAttachments(task).map((name) => (
                <span key={name} className="attachment-chip">
                  <button
                    type="button"
                    className="attachment-name"
                    title={isImage(name) ? "visualizar" : "abrir"}
                    onClick={() =>
                      isImage(name)
                        ? setPreview(name)
                        : window.open(attachmentUrl(name), "_blank")
                    }
                  >
                    📎 {name}
                  </button>
                  {task.status !== "running" && (
                    <button
                      type="button"
                      title="remover anexo"
                      onClick={() => {
                        void api
                          .deleteAttachment(task.id, name)
                          .then(() => load())
                          .catch((e) => setError((e as Error).message));
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
              {task.status !== "running" && (
                <label className="attachment-add">
                  + anexar
                  <input
                    type="file"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      if (picked.length === 0) return;
                      void api
                        .uploadAttachments(task.id, picked)
                        .then(() => load())
                        .catch((err) => setError((err as Error).message));
                    }}
                  />
                </label>
              )}
            </span>
          </div>
        </div>

        <div className="toolbar mt">
          {task.status !== "running" ? (
            <>
              <select value={runProvider} onChange={(e) => setRunProvider(e.target.value)}>
                <option value="">IA da tarefa</option>
                <option value="claude">Forçar Claude</option>
                <option value="codex">Forçar Codex</option>
              </select>
              <button className="primary" onClick={() => void run()}>
                ▶ Executar agora
              </button>
              {task.deliver_mode === "pr" && task.pr_url && (
                <button
                  onClick={() => void review()}
                  title="lê os comentários novos do PR e re-executa a IA na branch dele"
                >
                  ⟲ Atender review
                </button>
              )}
              {task.kind === "pr_review" && task.pr_url && (
                <button
                  onClick={() => void reReview()}
                  title="revisa o PR atualizado ciente da sua revisão anterior e da discussão desde então"
                >
                  ⟲ Revisar de novo
                </button>
              )}
              {task.status !== "pending" && (
                <button onClick={() => void requeue()}>↩ Devolver à fila</button>
              )}
              <button className="danger" onClick={() => void remove()}>
                Excluir
              </button>
            </>
          ) : (
            <span className="badge info">executando…</span>
          )}
        </div>
        {error && <p className="error-box mt">{error}</p>}
      </div>

      {preview && (
        <div className="modal-overlay" onClick={() => setPreview(null)}>
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>{preview}</strong>
              <button onClick={() => setPreview(null)}>✕</button>
            </div>
            <img src={attachmentUrl(preview)} alt={preview} />
          </div>
        </div>
      )}

      <div className="card mt">
        <h2>Prompt</h2>
        <div className="prompt-box">{task.prompt}</div>
      </div>

      <div className="card mt">
        <h2>{runs.length > 1 ? `Execuções (${runs.length})` : "Execução"}</h2>
        {runs.length === 0 && (
          <p className="muted">Sem execuções ainda — a tarefa não foi executada.</p>
        )}
        {runs.map((r, i) => {
          const num = runs.length - i;
          const meta = [
            RUN_TYPE_LABEL[r.run_type],
            r.provider ?? "?",
            fmtDate(r.started_at),
            r.cost_usd ? fmtCost(r.cost_usd) : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const body = r.output_log ? (
            <LogView log={r.output_log} done={r.status === "done"} />
          ) : (
            <p className="muted">
              {r.status === "running" ? "Em execução…" : "Sem log registrado."}
            </p>
          );
          // a execução mais recente fica aberta; as anteriores, recolhidas
          if (i === 0) {
            return (
              <div key={r.id}>
                {runs.length > 1 && (
                  <p className="muted" style={{ margin: "0 0 8px", fontSize: "0.8rem" }}>
                    #{num} · {meta} ·{" "}
                    <span className={`status ${r.status}`}>{RUN_STATUS_LABEL[r.status]}</span>
                  </p>
                )}
                {body}
              </div>
            );
          }
          return (
            <details className="form-section" key={r.id}>
              <summary>
                <strong>#{num}</strong>
                <span className="summary-hint">{meta}</span>
                <span className={`status ${r.status}`}>{RUN_STATUS_LABEL[r.status]}</span>
              </summary>
              <div style={{ padding: "0 14px 14px" }}>{body}</div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
