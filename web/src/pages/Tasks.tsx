import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  onServerEvent,
  PRIORITY_OPTIONS,
  priorityLabel,
  RECUR_OPTIONS,
  recurLabel,
  type Folder,
  type GitDoctor,
  type Task,
} from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import DirectoryPicker from "../components/DirectoryPicker";
import FolderPicker from "../components/FolderPicker";

const emptyForm = {
  kind: "exec",
  title: "",
  prompt: "",
  provider: "any",
  cwd: "",
  pr_url: "",
  priority: 0,
  recur_minutes: 0,
  model: "",
  effort: "",
  deliver_mode: "none",
  base_branch: "",
  work_branch: "",
  verify_cmd: "",
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

// fallback quando a config codex_model_suggestions ainda não carregou/está vazia
const CODEX_MODEL_FALLBACK = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];

/** "gpt-5.5-codex, gpt-5.5" → ["gpt-5.5-codex", "gpt-5.5"] */
function parseCodexModels(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : CODEX_MODEL_FALLBACK;
}

const EFFORT_OPTIONS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

function ghInstallCmd(os: string): string {
  if (os === "win32") return "winget install GitHub.cli";
  if (os === "darwin") return "brew install gh";
  return "sudo apt install gh"; // demais Linux/distros: o gerenciador equivalente
}

/** Passo do checklist de preparação de PR: ✓ feito, ● falta agora, ○ aguardando pré-requisito. */
function SetupStep({
  state,
  label,
  command,
}: {
  state: "done" | "todo" | "pending";
  label: string;
  command?: string;
}) {
  const icon = state === "done" ? "✓" : state === "todo" ? "●" : "○";
  const cls = state === "done" ? "step-done" : state === "todo" ? "step-todo" : "step-pending";
  return (
    <li className={`setup-step ${cls}`}>
      <span className="setup-icon">{icon}</span>
      <span>
        {label}
        {command && state !== "done" && (
          <>
            {" — "}
            <code>{command}</code>
          </>
        )}
      </span>
    </li>
  );
}

function PrReadiness({
  doctor,
  checking,
  onRecheck,
}: {
  doctor: GitDoctor;
  checking: boolean;
  onRecheck: () => void;
}) {
  const ready = doctor.git.installed && doctor.gh.installed && doctor.gh.authenticated;
  if (ready) {
    return (
      <p className="setup-ready">
        ✓ pronto para abrir PRs{doctor.gh.account ? ` — logado como ${doctor.gh.account}` : ""}
      </p>
    );
  }
  return (
    <div className="setup-checklist">
      <div className="setup-head">
        <span>Para abrir PRs, complete o que falta:</span>
        <button type="button" onClick={onRecheck} disabled={checking}>
          {checking ? "verificando…" : "↻ Verificar de novo"}
        </button>
      </div>
      <ul>
        <SetupStep
          state={doctor.git.installed ? "done" : "todo"}
          label="git instalado"
          command="instale o git"
        />
        <SetupStep
          state={doctor.gh.installed ? "done" : "todo"}
          label="GitHub CLI (gh) instalado"
          command={ghInstallCmd(doctor.os)}
        />
        <SetupStep
          state={
            doctor.gh.authenticated ? "done" : doctor.gh.installed ? "todo" : "pending"
          }
          label="login no GitHub feito"
          command="gh auth login"
        />
      </ul>
      <p className="setup-foot muted">
        Já rodou os comandos? Ao voltar para esta janela o checklist se atualiza sozinho — ou clique
        em “Verificar de novo”. Se instalou o gh agora, reinicie o servidor do PapaToken.
      </p>
    </div>
  );
}

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  /** pasta aberta na navegação; null = raiz */
  const [currentFolder, setCurrentFolder] = useState<number | null>(null);
  /** visão global: todas as tarefas de todas as pastas (a fila como o scheduler vê) */
  const [showAll, setShowAll] = useState(false);
  /** null = input de nova pasta fechado */
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  /** pasta em edição inline de nome; null = nenhuma */
  const [renamingFolder, setRenamingFolder] = useState<{ id: number; name: string } | null>(null);
  /** pasta aguardando confirmação de exclusão; null = nenhuma */
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  const [movingTask, setMovingTask] = useState<Task | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [files, setFiles] = useState<File[]>([]);
  const [filePreview, setFilePreview] = useState<{ name: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gitInfo, setGitInfo] = useState<{ repo: boolean; branches: string[] } | null>(null);
  const [doctor, setDoctor] = useState<GitDoctor | null>(null);
  const [doctorChecking, setDoctorChecking] = useState(false);
  const [verifySuggestions, setVerifySuggestions] = useState<string[]>([]);
  const [codexModels, setCodexModels] = useState<string[]>(CODEX_MODEL_FALLBACK);

  const loadDoctor = useCallback((force?: boolean) => {
    setDoctorChecking(true);
    api
      .gitDoctor(force)
      .then(setDoctor)
      .catch(() => setDoctor(null))
      .finally(() => setDoctorChecking(false));
  }, []);

  // lista de modelos sugeridos do Codex vem das configs (mantida pelo usuário)
  useEffect(() => {
    api
      .settings()
      .then((s) => setCodexModels(parseCodexModels(s.codex_model_suggestions)))
      .catch(() => setCodexModels(CODEX_MODEL_FALLBACK));
  }, []);

  // diagnóstico do ambiente de PR quando o usuário liga a entrega; e de novo,
  // sem cache, sempre que a janela recebe foco — cobre o fluxo "li o comando,
  // fui ao terminal instalar/logar e voltei": o checklist se atualiza sozinho
  useEffect(() => {
    if (form.deliver_mode !== "pr") return;
    loadDoctor();
    const onFocus = () => loadDoctor(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [form.deliver_mode, loadDoctor]);

  // sugestões + memória do comando de verificação para o diretório escolhido
  useEffect(() => {
    if (!form.cwd.trim()) {
      setVerifySuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .verifyInfo(form.cwd.trim())
        .then((info) => {
          const all = [info.remembered, ...info.suggestions].filter(
            (s): s is string => !!s
          );
          setVerifySuggestions([...new Set(all)]);
          // pré-preenche com o comando lembrado deste repositório, sem
          // sobrescrever algo que o usuário já digitou
          if (info.remembered) {
            setForm((prev) =>
              prev.verify_cmd === "" ? { ...prev, verify_cmd: info.remembered! } : prev
            );
          }
        })
        .catch(() => setVerifySuggestions([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [form.cwd]);

  // sugestões de branch quando a entrega por PR está ligada e há cwd
  useEffect(() => {
    if (form.deliver_mode !== "pr" || !form.cwd.trim()) {
      setGitInfo(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .gitBranches(form.cwd.trim())
        .then(setGitInfo)
        .catch(() => setGitInfo(null));
    }, 400); // debounce da digitação do caminho
    return () => clearTimeout(timer);
  }, [form.deliver_mode, form.cwd]);

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
    api.folders().then(setFolders).catch(() => setFolders([]));
  }, []);

  useEffect(() => {
    load();
    const off = onServerEvent((ev) => {
      if (ev.type === "task") load();
    });
    return off;
  }, [load]);

  // pasta aberta foi excluída (ou nunca existiu) → volta para a raiz
  useEffect(() => {
    if (currentFolder !== null && !folders.some((f) => f.id === currentFolder)) {
      setCurrentFolder(null);
    }
  }, [folders, currentFolder]);

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  /** caminho legível ("Pasta A / Sub B"); null para tarefas na raiz */
  const folderPath = useCallback(
    (id: number | null | undefined): string | null => {
      if (id == null) return null;
      const parts: string[] = [];
      let cur: number | null = id;
      while (cur !== null) {
        const f = folderById.get(cur);
        if (!f) break;
        parts.unshift(f.name);
        cur = f.parent_id;
      }
      return parts.join(" / ") || null;
    },
    [folderById]
  );

  // caminho da raiz até a pasta aberta (breadcrumb)
  const trail = useMemo(() => {
    const list: Folder[] = [];
    let cur = currentFolder;
    while (cur !== null) {
      const f = folderById.get(cur);
      if (!f) break;
      list.unshift(f);
      cur = f.parent_id;
    }
    return list;
  }, [currentFolder, folderById]);

  const childFolders = useMemo(
    () => folders.filter((f) => f.parent_id === currentFolder),
    [folders, currentFolder]
  );

  // contagens por pasta somando a subárvore — dá para ver de fora se algo roda dentro
  const folderStats = useMemo(() => {
    const collect = (id: number): number[] => [
      id,
      ...folders.filter((f) => f.parent_id === id).flatMap((f) => collect(f.id)),
    ];
    const stats = new Map<number, { total: number; pending: number; running: number }>();
    for (const f of folders) {
      const ids = new Set(collect(f.id));
      const inside = tasks.filter((t) => t.folder_id != null && ids.has(t.folder_id));
      stats.set(f.id, {
        total: inside.length,
        pending: inside.filter((t) => t.status === "pending").length,
        running: inside.filter((t) => t.status === "running").length,
      });
    }
    return stats;
  }, [folders, tasks]);

  const inScope = showAll
    ? tasks
    : tasks.filter((t) => (t.folder_id ?? null) === currentFolder);
  const visible = filter === "all" ? inScope : inScope.filter((t) => t.status === filter);

  const createFolder = async () => {
    const name = (newFolderName ?? "").trim();
    if (!name) return;
    try {
      await api.createFolder(name, currentFolder);
      setNewFolderName(null);
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveRename = async () => {
    if (!renamingFolder) return;
    const name = renamingFolder.name.trim();
    if (!name) return;
    try {
      await api.updateFolder(renamingFolder.id, { name });
      setRenamingFolder(null);
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // exclusão efetiva — a confirmação acontece antes, no ConfirmDialog
  const removeFolder = async (f: Folder) => {
    try {
      await api.deleteFolder(f.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingFolder(null);
    }
  };

  // resumos exibidos nas seções recolhidas do formulário
  const providerLabel: Record<string, string> = {
    any: "Qualquer IA",
    claude: "Claude Code",
    codex: "Codex",
  };
  const execSummary = [
    providerLabel[form.provider],
    form.model || "modelo padrão",
    form.effort ? `effort ${form.effort}` : "effort padrão",
    priorityLabel(form.priority),
    ...(form.recur_minutes > 0 ? [`🔁 ${recurLabel(form.recur_minutes)}`] : []),
  ].join(" · ");
  const deliverySummary = [
    form.verify_cmd ? `verificação: ${form.verify_cmd}` : "sem verificação",
    form.deliver_mode === "pr"
      ? `Pull Request${form.base_branch ? ` → ${form.base_branch}` : ""}`
      : "só executar",
  ].join(" · ");

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
        // a tarefa nasce na pasta aberta na navegação
        folder_id: currentFolder,
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
        {!showAll && (
          <button onClick={() => setNewFolderName(newFolderName === null ? "" : null)}>
            📁 Nova pasta
          </button>
        )}
        <span style={{ flex: 1 }} />
        {folders.length > 0 && (
          <div className="seg-toggle">
            <button
              type="button"
              className={showAll ? "" : "active"}
              title="navegar pelas pastas"
              onClick={() => setShowAll(false)}
            >
              📁 Pastas
            </button>
            <button
              type="button"
              className={showAll ? "active" : ""}
              title="todas as tarefas numa lista só — a fila como o scheduler vê"
              onClick={() => {
                setShowAll(true);
                setNewFolderName(null);
              }}
            >
              ☰ Tudo
            </button>
          </div>
        )}
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
              <label>Tipo de tarefa</label>
              <select
                value={form.kind}
                onChange={(e) =>
                  setForm({ ...form, kind: e.target.value, deliver_mode: "none" })
                }
              >
                <option value="exec">Executar instrução</option>
                <option value="pr_review">Revisar Pull Request</option>
              </select>
            </div>
            <div className="field">
              <label>Título</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder={
                  form.kind === "pr_review" ? "Ex.: Review do PR #42" : "Ex.: Escrever testes do módulo X"
                }
              />
            </div>
            {form.kind === "pr_review" && (
              <div className="field full">
                <label>URL do Pull Request</label>
                <input
                  value={form.pr_url}
                  onChange={(e) => setForm({ ...form, pr_url: e.target.value })}
                  placeholder="https://github.com/dono/repo/pull/42"
                />
              </div>
            )}
            <div className="field">
              <label>
                {form.kind === "pr_review"
                  ? "Clone local do repositório (obrigatório)"
                  : "Diretório de trabalho (opcional)"}
              </label>
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
            <div className="field full">
              <label>
                {form.kind === "pr_review"
                  ? "Instruções ao revisor (opcional)"
                  : "Prompt (instrução completa para a IA)"}
              </label>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                onPaste={pasteImages}
                placeholder={
                  form.kind === "pr_review"
                    ? "Ex.: foque em segurança e concorrência; o padrão do time é X…"
                    : "Descreva a tarefa com contexto suficiente para execução autônoma… (Ctrl+V cola prints como anexo)"
                }
              />
            </div>
            {form.kind !== "pr_review" && (
            <div className="field full">
              <label>Anexos (opcional — prints podem ser colados com Ctrl+V no prompt)</label>
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
                        title={`${f.name}${f.type.startsWith("image/") ? " — visualizar" : ""}`}
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
            )}
          </div>

          <details className="form-section">
            <summary>
              <strong>Execução</strong>
              <span className="summary-hint">{execSummary}</span>
            </summary>
            <div className="form-grid">
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
              <label>Prioridade (empate: mais antiga primeiro)</label>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              >
                {PRIORITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Repetir (volta à fila após concluir)</label>
              <select
                value={form.recur_minutes}
                onChange={(e) => setForm({ ...form, recur_minutes: Number(e.target.value) })}
              >
                {RECUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {form.recur_minutes > 0 && (
                <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.78rem" }}>
                  O intervalo conta a partir do fim de cada execução; o horário exato de rodar
                  continua sendo decisão do scheduler (sobra de tokens/janela). Falha também
                  repete no próximo ciclo.
                </p>
              )}
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
                    {codexModels.map((m) => (
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
            </div>
          </details>

          {form.kind !== "pr_review" && (
          <details className="form-section">
            <summary>
              <strong>Qualidade e entrega</strong>
              <span className="summary-hint">{deliverySummary}</span>
            </summary>
            <div className="form-grid">
            <div className="field">
              <label>Comando de verificação (opcional)</label>
              <input
                list="verify-suggestions"
                value={form.verify_cmd}
                onChange={(e) => setForm({ ...form, verify_cmd: e.target.value })}
                placeholder="ex.: npm test — roda após a IA; se falhar, ela corrige"
              />
              <datalist id="verify-suggestions">
                {verifySuggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label>Entrega</label>
              <select
                value={form.deliver_mode}
                onChange={(e) => setForm({ ...form, deliver_mode: e.target.value })}
              >
                <option value="none">Só executar</option>
                <option value="pr">Abrir Pull Request no GitHub</option>
              </select>
              {form.deliver_mode === "pr" && doctor && (
                <PrReadiness doctor={doctor} checking={doctorChecking} onRecheck={() => loadDoctor(true)} />
              )}
            </div>
            {form.deliver_mode === "pr" && (
              <>
                <div className="field">
                  <label>Branch base (origem e alvo do PR)</label>
                  <input
                    list="git-branches"
                    value={form.base_branch}
                    onChange={(e) => setForm({ ...form, base_branch: e.target.value })}
                    placeholder="vazio = branch padrão do repositório"
                  />
                  <datalist id="git-branches">
                    {(gitInfo?.branches ?? []).map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                  {gitInfo && !gitInfo.repo && (
                    <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.78rem" }}>
                      ⚠ o diretório informado não parece ser um repositório git
                    </p>
                  )}
                </div>
                <div className="field">
                  <label>Nome da branch nova</label>
                  <input
                    value={form.work_branch}
                    onChange={(e) => setForm({ ...form, work_branch: e.target.value })}
                    placeholder="vazio = template das Configurações"
                  />
                </div>
              </>
            )}
            </div>
          </details>
          )}

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

      {deletingFolder && (
        <ConfirmDialog
          title="Excluir pasta"
          confirmLabel="Excluir"
          onConfirm={() => void removeFolder(deletingFolder)}
          onClose={() => setDeletingFolder(null)}
        >
          <p style={{ margin: "0 0 8px" }}>
            Excluir a pasta <strong>“{deletingFolder.name}”</strong>?
          </p>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            Nada é apagado junto: tarefas e subpastas sobem para o nível acima.
          </p>
        </ConfirmDialog>
      )}

      {movingTask && (
        <FolderPicker
          folders={folders}
          current={movingTask.folder_id ?? null}
          onSelect={(fid) => {
            void api
              .updateTask(movingTask.id, { folder_id: fid } as Partial<Task>)
              .then(() => {
                setMovingTask(null);
                load();
              })
              .catch((e) => setError((e as Error).message));
          }}
          onClose={() => setMovingTask(null)}
        />
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

      {!showAll && (folders.length > 0 || currentFolder !== null) && (
        <div className="breadcrumb">
          {currentFolder === null ? (
            <span className="crumb-current" title="raiz">
              🏠
            </span>
          ) : (
            <span className="crumb" title="voltar à raiz" onClick={() => setCurrentFolder(null)}>
              🏠
            </span>
          )}
          {trail.map((f, i) => (
            <span
              key={f.id}
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <span className="crumb-sep">›</span>
              {i === trail.length - 1 ? (
                <span className="crumb-current">📁 {f.name}</span>
              ) : (
                <span className="crumb" onClick={() => setCurrentFolder(f.id)}>
                  {f.name}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {!showAll && (childFolders.length > 0 || newFolderName !== null) && (
        <div className="folder-grid">
          {newFolderName !== null && (
            <div className="folder-card" style={{ cursor: "default" }}>
              <span aria-hidden="true">📁</span>
              <input
                autoFocus
                value={newFolderName}
                placeholder="nome da nova pasta"
                style={{ padding: "4px 8px", width: 180 }}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createFolder();
                  if (e.key === "Escape") setNewFolderName(null);
                }}
              />
              <button
                style={{ padding: "4px 10px", fontSize: "0.8rem" }}
                onClick={() => void createFolder()}
              >
                Criar
              </button>
              <button
                style={{ padding: "4px 8px", fontSize: "0.8rem" }}
                title="cancelar"
                onClick={() => setNewFolderName(null)}
              >
                ✕
              </button>
            </div>
          )}
          {childFolders.map((f) => {
            const s = folderStats.get(f.id);
            const parts = [
              s && s.running > 0 ? `${s.running} executando` : null,
              s && s.pending > 0 ? `${s.pending} pendente(s)` : null,
            ].filter(Boolean);
            return (
              <div
                key={f.id}
                className="folder-card"
                title={renamingFolder?.id === f.id ? undefined : `abrir “${f.name}”`}
                style={renamingFolder?.id === f.id ? { cursor: "default" } : undefined}
                onClick={() => renamingFolder?.id !== f.id && setCurrentFolder(f.id)}
              >
                <span aria-hidden="true">📁</span>
                {renamingFolder?.id === f.id ? (
                  <span
                    style={{ display: "inline-flex", gap: 4 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      autoFocus
                      value={renamingFolder.name}
                      style={{ padding: "4px 8px", width: 180 }}
                      onChange={(e) => setRenamingFolder({ id: f.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename();
                        if (e.key === "Escape") setRenamingFolder(null);
                      }}
                    />
                    <button
                      style={{ padding: "4px 10px", fontSize: "0.8rem" }}
                      onClick={() => void saveRename()}
                    >
                      Salvar
                    </button>
                    <button
                      style={{ padding: "4px 8px", fontSize: "0.8rem" }}
                      title="cancelar"
                      onClick={() => setRenamingFolder(null)}
                    >
                      ✕
                    </button>
                  </span>
                ) : (
                  <>
                    <strong>{f.name}</strong>
                    <span className="muted" style={{ fontSize: "0.78rem" }}>
                      {parts.length > 0 ? parts.join(" · ") : `${s?.total ?? 0} tarefa(s)`}
                    </span>
                    <span
                      className="folder-card-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        title="renomear pasta"
                        onClick={() => setRenamingFolder({ id: f.id, name: f.name })}
                      >
                        {/* ︎ força o glifo de texto (herda a cor do tema) em vez do emoji */}
                        {"✎︎"}
                      </button>
                      <button
                        type="button"
                        title="excluir pasta (o conteúdo sobe para o nível acima)"
                        onClick={() => setDeletingFolder(f)}
                      >
                        ✕
                      </button>
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
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
            <th>PR</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Link to={`/tasks/${t.id}`} style={{ color: "var(--accent)" }}>
                    {t.title}
                  </Link>
                  {(t.recur_minutes ?? 0) > 0 && (
                    <span title={`recorrente: ${recurLabel(t.recur_minutes)}`}>🔁</span>
                  )}
                  {showAll && t.folder_id != null && (
                    <span
                      className="folder-link"
                      style={{ fontSize: "0.78rem" }}
                      title="abrir esta pasta"
                      onClick={() => {
                        setShowAll(false);
                        setCurrentFolder(t.folder_id!);
                      }}
                    >
                      📁 {folderPath(t.folder_id)}
                    </span>
                  )}
                  {t.status !== "running" && folders.length > 0 && (
                    <button
                      type="button"
                      className="row-move"
                      title="mover para outra pasta"
                      onClick={() => setMovingTask(t)}
                    >
                      📂
                    </button>
                  )}
                </div>
              </td>
              {/* quem executou; senão, quem está designada ("any" = qualquer) */}
              <td
                title={
                  t.executed_by && t.executed_by !== t.provider
                    ? `designada: ${t.provider === "any" ? "qualquer" : t.provider} · executada por ${t.executed_by}`
                    : undefined
                }
              >
                {t.executed_by ?? (t.provider === "any" ? "qualquer" : t.provider)}
              </td>
              <td>{priorityLabel(t.priority)}</td>
              <td>
                <span className={`status ${t.status}`}>{t.status}</span>
              </td>
              <td className="muted">{new Date(t.created_at + "Z").toLocaleString("pt-BR")}</td>
              <td>
                {t.pr_url ? (
                  <a href={t.pr_url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                    ↗
                  </a>
                ) : t.deliver_mode !== "pr" ? (
                  <span className="muted">—</span>
                ) : t.deliver_status === "no_changes" ? (
                  <span className="muted" title="sem alterações — PR não criado">∅</span>
                ) : t.deliver_status === "failed" ? (
                  <span title="entrega falhou — veja o log da tarefa">⚠</span>
                ) : (
                  <span className="muted" title="entrega por PR configurada">git</span>
                )}
              </td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Nenhuma tarefa{" "}
                {filter !== "all"
                  ? `com status “${filter}”`
                  : !showAll && currentFolder !== null
                    ? "nesta pasta"
                    : "cadastrada"}
                .
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
