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
};

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [error, setError] = useState<string | null>(null);

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

  const submit = async () => {
    try {
      await api.createTask({ ...form, priority: Number(form.priority) } as Partial<Task>);
      setForm({ ...emptyForm });
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
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
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
            <div className="field full">
              <label>Prompt (instrução completa para a IA)</label>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder="Descreva a tarefa com contexto suficiente para execução autônoma…"
              />
            </div>
          </div>
          <div className="toolbar mt">
            <button className="primary" onClick={() => void submit()}>
              Criar tarefa
            </button>
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
