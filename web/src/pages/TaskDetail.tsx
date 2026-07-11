import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, onServerEvent, taskAttachments, type Task } from "../api";

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
    if (/^\[(executor|recovery)\]/.test(line.trim())) notes.push(line.trim());
    else contentLines.push(line);
  }
  // notes appended to stderr section also count
  if (stderr) {
    const kept: string[] = [];
    for (const line of stderr.split("\n")) {
      if (/^\[(executor|recovery)\]/.test(line.trim())) notes.push(line.trim());
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

function LogView({ log }: { log: string }) {
  const parsed = parseLog(log);

  return (
    <div>
      {parsed.notes.length > 0 && (
        <div className="notices">
          {parsed.notes.map((n, i) => (
            <div key={i} className="notice">
              ⚠ {n.replace(/^\[(executor|recovery)\]\s*/, "")}
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

      {parsed.plain && <div className="log">{parsed.plain}</div>}

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
  const [error, setError] = useState<string | null>(null);
  const [runProvider, setRunProvider] = useState<string>("");
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api.task(id).then(setTask).catch((e) => setError(e.message));
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
          <Meta label="Prioridade">{task.priority}</Meta>
          <Meta label="Tentativas">
            {task.attempts}/{task.max_attempts}
          </Meta>
          <Meta label="Criada">{fmtDate(task.created_at)}</Meta>
          <Meta label="Iniciada">{fmtDate(task.started_at)}</Meta>
          <Meta label="Finalizada">{fmtDate(task.finished_at)}</Meta>
          <Meta label="Exit code">{task.exit_code ?? "—"}</Meta>
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
        <h2>Execução</h2>
        {task.output_log ? (
          <LogView log={task.output_log} />
        ) : (
          <p className="muted">Sem log ainda — a tarefa não foi executada.</p>
        )}
      </div>
    </div>
  );
}
