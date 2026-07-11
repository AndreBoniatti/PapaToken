import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, onServerEvent, type Task } from "../api";
import DirectoryPicker from "../components/DirectoryPicker";

const emptyForm = {
  title: "",
  prompt: "",
  provider: "any",
  cwd: "",
  priority: 0,
  model: "",
  effort: "",
};

const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: "", label: "Padrão do CLI" },
    { value: "fable", label: "Fable (mais capaz)" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku (mais rápido/barato)" },
  ],
};

const CODEX_MODEL_SUGGESTIONS = ["gpt-5.5-codex", "gpt-5.5"];

const EFFORT_OPTIONS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [files, setFiles] = useState<File[]>([]);
  const [filePreview, setFilePreview] = useState<{ name: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openFilePreview = (f: File) => {
    if (!f.type.startsWith("image/")) return;
    setFilePreview({ name: f.name, url: URL.createObjectURL(f) });
  };
  const closeFilePreview = () => {
    if (filePreview) URL.revokeObjectURL(filePreview.url);
    setFilePreview(null);
  };

  const load = useCallback(() => {
    api.tasks().then(setTasks).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const off = onServerEvent((ev) => {
      if (ev.type === "task") load();
    });
    return off;
  }, [load]);

  const visible = filter === "all" ? tasks : tasks.filter((t) => t.status === filter);

  const pasteImages = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items).filter((i) =>
      i.type.startsWith("image/")
    );
    if (items.length === 0) return; // colagem de texto segue normal
    e.preventDefault();
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const pasted = items
      .map((item, idx) => {
        const f = item.getAsFile();
        if (!f) return null;
        const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
        return new File([f], `print-${stamp}${idx > 0 ? `-${idx}` : ""}.${ext}`, {
          type: f.type,
        });
      })
      .filter((f): f is File => f !== null);
    setFiles((prev) => [...prev, ...pasted]);
  };

  const submit = async () => {
    try {
      const created = await api.createTask({
        ...form,
        priority: Number(form.priority),
      } as Partial<Task>);
      if (files.length > 0) await api.uploadAttachments(created.id, files);
      setForm({ ...emptyForm });
      setFiles([]);
      setShowForm(false);
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <h1>Tarefas</h1>
      <div className="toolbar">
        <button className="primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancelar" : "+ Nova tarefa"}
        </button>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">Todas</option>
          <option value="pending">Pendentes</option>
          <option value="running">Executando</option>
          <option value="done">Concluídas</option>
          <option value="failed">Falharam</option>
          <option value="blocked">Bloqueadas</option>
        </select>
      </div>

      {error && <p className="error-box">{error}</p>}

      {showForm && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2>Nova tarefa</h2>
          <div className="form-grid">
            <div className="field">
              <label>Título</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Ex.: Escrever testes do módulo X"
              />
            </div>
            <div className="field">
              <label>Diretório de trabalho (opcional)</label>
              <div className="input-with-button">
                <input
                  value={form.cwd}
                  onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                  placeholder="vazio = pasta automática da tarefa"
                />
                <button type="button" onClick={() => setShowPicker(true)}>
                  📁 Procurar…
                </button>
              </div>
            </div>
            <div className="field">
              <label>IA designada</label>
              <select
                value={form.provider}
                onChange={(e) =>
                  setForm({ ...form, provider: e.target.value, model: "", effort: "" })
                }
              >
                <option value="any">Qualquer</option>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div className="field">
              <label>Prioridade (maior = primeiro)</label>
              <input
                type="number"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>Modelo</label>
              {form.provider === "claude" ? (
                <select
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                >
                  {MODEL_OPTIONS.claude.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : form.provider === "codex" ? (
                <>
                  <input
                    list="codex-models"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="vazio = padrão do CLI"
                  />
                  <datalist id="codex-models">
                    {CODEX_MODEL_SUGGESTIONS.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </>
              ) : (
                <select disabled>
                  <option>Padrão de cada IA</option>
                </select>
              )}
            </div>
            <div className="field">
              <label>Effort (nível de raciocínio)</label>
              {form.provider === "any" ? (
                <select disabled>
                  <option>Padrão de cada IA</option>
                </select>
              ) : (
                <select
                  value={form.effort}
                  onChange={(e) => setForm({ ...form, effort: e.target.value })}
                >
                  <option value="">Padrão do CLI</option>
                  {EFFORT_OPTIONS[form.provider].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="field full">
              <label>Prompt (instrução completa para a IA)</label>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                onPaste={pasteImages}
                placeholder="Descreva a tarefa com contexto suficiente para execução autônoma… (Ctrl+V cola prints como anexo)"
              />
            </div>
            <div className="field full">
              <label>Anexos (prints, documentos — opcional; prints podem ser colados com Ctrl+V no prompt)</label>
              <input
                type="file"
                multiple
                onChange={(e) => {
                  // snapshot antes de limpar: a FileList é um objeto vivo e
                  // zerar o input a esvaziaria antes do estado atualizar
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  setFiles((prev) => [...prev, ...picked]);
                }}
              />
              {files.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {files.map((f, i) => (
                    <span key={`${f.name}-${i}`} className="attachment-chip">
                      <button
                        type="button"
                        className="attachment-name"
                        title={f.type.startsWith("image/") ? "visualizar" : f.name}
                        onClick={() => openFilePreview(f)}
                      >
                        📎 {f.name}
                      </button>
                      <button
                        type="button"
                        title="remover"
                        onClick={() => setFiles(files.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="toolbar mt">
            <button className="primary" onClick={() => void submit()}>
              Criar tarefa
            </button>
          </div>
        </div>
      )}

      {filePreview && (
        <div className="modal-overlay" onClick={closeFilePreview}>
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>{filePreview.name}</strong>
              <button onClick={closeFilePreview}>✕</button>
            </div>
            <img src={filePreview.url} alt={filePreview.name} />
          </div>
        </div>
      )}

      {showPicker && (
        <DirectoryPicker
          initial={form.cwd}
          onSelect={(path) => {
            setForm({ ...form, cwd: path });
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Título</th>
            <th>IA</th>
            <th>Prioridade</th>
            <th>Status</th>
            <th>Criada</th>
            <th>Executada por</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>
                <Link to={`/tasks/${t.id}`} style={{ color: "var(--accent)" }}>
                  {t.title}
                </Link>
              </td>
              <td>{t.provider}</td>
              <td>{t.priority}</td>
              <td>
                <span className={`status ${t.status}`}>{t.status}</span>
              </td>
              <td className="muted">{new Date(t.created_at + "Z").toLocaleString("pt-BR")}</td>
              <td>{t.executed_by ?? "—"}</td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Nenhuma tarefa {filter !== "all" ? `com status “${filter}”` : "cadastrada"}.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
