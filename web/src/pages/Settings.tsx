import { useEffect, useState } from "react";
import { api, type Settings as SettingsMap } from "../api";

const FIELDS: {
  key: string;
  label: string;
  hint: string;
  type: "number" | "select" | "text";
  options?: { value: string; label: string }[];
}[] = [
  {
    key: "mode",
    label: "Modo do scheduler",
    hint: "window: executa perto do reset da janela; aggressive: executa sempre que houver sobra; paused: não executa nada automaticamente.",
    type: "select",
    options: [
      { value: "window", label: "window — perto do reset" },
      { value: "aggressive", label: "aggressive — sempre que sobrar" },
      { value: "paused", label: "paused — pausado" },
    ],
  },
  {
    key: "claude_permission_mode",
    label: "Autonomia do Claude",
    hint: "acceptEdits: só cria/edita arquivos — pedidos de web ou comandos ficam sem resposta; bypassPermissions: usa qualquer ferramenta (busca na web, comandos) sem aprovação. Para tarefas autônomas completas, use bypassPermissions — e prefira diretórios com git.",
    type: "select",
    options: [
      { value: "bypassPermissions", label: "bypassPermissions — autonomia total" },
      { value: "acceptEdits", label: "acceptEdits — só editar arquivos" },
    ],
  },
  {
    key: "safety_ceiling_pct",
    label: "Teto de segurança (%)",
    hint: "Nunca despachar quando o uso (5h ou semanal) estiver acima disto — preserva tokens para seu uso manual.",
    type: "number",
  },
  {
    key: "dispatch_window_min",
    label: "Janela de despacho (min antes do reset)",
    hint: "No modo window, só despacha quando faltar menos que isto para o reset da janela de 5h.",
    type: "number",
  },
  {
    key: "min_free_pct",
    label: "Sobra mínima (%)",
    hint: "Só despacha se houver pelo menos esta folga entre o uso atual e o teto.",
    type: "number",
  },
  {
    key: "poll_interval_sec",
    label: "Intervalo de consulta de uso (s)",
    hint: "Frequência de gravação do histórico e cache das consultas de uso (mínimo recomendado: 180s para o endpoint do Claude).",
    type: "number",
  },
  {
    key: "task_timeout_min",
    label: "Timeout de tarefa (min)",
    hint: "Tarefas em execução são encerradas à força após este tempo.",
    type: "number",
  },
  {
    key: "default_workspace_dir",
    label: "Pasta padrão de tarefas",
    hint: "Tarefas criadas sem diretório de trabalho ganham uma subpasta própria aqui (tarefa-<id>).",
    type: "text",
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

  return (
    <div>
      <h1>Configurações</h1>
      <div className="card" style={{ maxWidth: 640 }}>
        {FIELDS.map((f) => (
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
        ))}
        <div className="toolbar">
          <button className="primary" onClick={() => void save()}>
            Salvar
          </button>
          {saved && <span className="badge ok">salvo</span>}
        </div>
        {error && <p className="error-box">{error}</p>}
      </div>
    </div>
  );
}
