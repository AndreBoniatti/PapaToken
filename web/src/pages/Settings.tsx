import { useEffect, useState } from "react";
import { api, type Settings as SettingsMap } from "../api";

interface Field {
  key: string;
  label: string;
  hint: string;
  type: "number" | "select" | "text";
  options?: { value: string; label: string }[];
}

const MODE: Field = {
  key: "mode",
  label: "Modo do scheduler",
  hint: "window: executa perto do reset da janela; aggressive: executa sempre que houver sobra; paused: não executa nada automaticamente.",
  type: "select",
  options: [
    { value: "window", label: "window — perto do reset" },
    { value: "aggressive", label: "aggressive — sempre que sobrar" },
    { value: "paused", label: "paused — pausado" },
  ],
};

const CLAUDE_PERMISSION: Field = {
  key: "claude_permission_mode",
  label: "Autonomia do Claude",
  hint: "acceptEdits: só cria/edita arquivos — pedidos de web ou comandos ficam sem resposta; bypassPermissions: usa qualquer ferramenta (busca na web, comandos) sem aprovação. Para tarefas autônomas completas, use bypassPermissions — e prefira diretórios com git.",
  type: "select",
  options: [
    { value: "bypassPermissions", label: "bypassPermissions — autonomia total" },
    { value: "acceptEdits", label: "acceptEdits — só editar arquivos" },
  ],
};

const CODEX_SANDBOX: Field = {
  key: "codex_sandbox_mode",
  label: "Autonomia do Codex",
  hint: "workspace-write: edita arquivos do diretório + acesso à rede. danger-full-access: sem sandbox, roda qualquer comando (equivalente ao bypassPermissions do Claude). ATENÇÃO Windows: o workspace-write do Codex vira somente-leitura (ele não tem sandbox nativo no Windows) — para tarefas do Codex conseguirem escrever arquivos, use danger-full-access.",
  type: "select",
  options: [
    { value: "danger-full-access", label: "danger-full-access — autonomia total (necessário no Windows)" },
    { value: "workspace-write", label: "workspace-write — edita arquivos + rede (Linux/Mac)" },
  ],
};

const SAFETY_CEILING: Field = {
  key: "safety_ceiling_pct",
  label: "Teto de segurança (%)",
  hint: "Nunca despachar quando o uso (5h ou semanal) estiver acima disto — preserva tokens para seu uso manual.",
  type: "number",
};

const DISPATCH_WINDOW: Field = {
  key: "dispatch_window_min",
  label: "Janela de despacho (min antes do reset)",
  hint: "No modo window, só despacha quando faltar menos que isto para o reset da janela de 5h.",
  type: "number",
};

const MIN_FREE: Field = {
  key: "min_free_pct",
  label: "Sobra mínima (%)",
  hint: "Só despacha se houver pelo menos esta folga entre o uso atual e o teto.",
  type: "number",
};

const POLL_INTERVAL: Field = {
  key: "poll_interval_sec",
  label: "Intervalo de consulta de uso (s)",
  hint: "Frequência de gravação do histórico e cache das consultas de uso (mínimo recomendado: 180s para o endpoint do Claude).",
  type: "number",
};

const TASK_TIMEOUT: Field = {
  key: "task_timeout_min",
  label: "Timeout de tarefa (min)",
  hint: "Tarefas em execução são encerradas à força após este tempo.",
  type: "number",
};

const WORKSPACE_DIR: Field = {
  key: "default_workspace_dir",
  label: "Pasta padrão de tarefas",
  hint: "Tarefas criadas sem diretório de trabalho ganham uma subpasta própria aqui (tarefa-<id>).",
  type: "text",
};

const BRANCH_TEMPLATE: Field = {
  key: "branch_template",
  label: "Template de branch (entrega por PR)",
  hint: "Nome da branch criada quando a tarefa não informa um. Variáveis: {id} (número da tarefa), {slug} (título normalizado), {date} (AAAA-MM-DD). Ex.: feat/{slug}",
  type: "text",
};

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Despacho — quando executar",
    fields: [MODE, SAFETY_CEILING, MIN_FREE, DISPATCH_WINDOW, POLL_INTERVAL],
  },
  {
    title: "Execução — como as IAs rodam",
    fields: [CLAUDE_PERMISSION, CODEX_SANDBOX, TASK_TIMEOUT],
  },
  {
    title: "Arquivos e entrega",
    fields: [WORKSPACE_DIR, BRANCH_TEMPLATE],
  },
];

export default function Settings() {
  const [values, setValues] = useState<SettingsMap>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setValues).catch((e) => setError(e.message));
  }, []);

  const save = async () => {
    try {
      const next = await api.saveSettings(values);
      setValues(next);
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const renderField = (f: Field) => (
    <div className="field" key={f.key} style={{ marginBottom: 16 }}>
      <label>{f.label}</label>
      {f.type === "select" ? (
        <select
          value={values[f.key] ?? ""}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
        >
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={f.type}
          value={values[f.key] ?? ""}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
        />
      )}
      <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.78rem" }}>
        {f.hint}
      </p>
    </div>
  );

  return (
    <div>
      <h1>Configurações</h1>
      <div className="settings-grid">
        {GROUPS.map((g) => (
          <div className="card" key={g.title}>
            <h2 className="settings-group-title">{g.title}</h2>
            {g.fields.map(renderField)}
          </div>
        ))}
      </div>
      <div className="toolbar" style={{ marginTop: 16 }}>
        <button className="primary" onClick={() => void save()}>
          Salvar
        </button>
        {saved && <span className="badge ok">salvo</span>}
      </div>
      {error && <p className="error-box">{error}</p>}
    </div>
  );
}
