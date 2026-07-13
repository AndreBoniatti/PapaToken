import { useEffect, useState } from "react";
import { api, type BrowseResult } from "../api";

interface Props {
  initial?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export default function DirectoryPicker({ initial, onSelect, onClose }: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .recentDirs()
      .then((r) => setRecent(r.dirs))
      .catch(() => setRecent([]));
  }, []);

  const load = (path?: string) => {
    api
      .browse(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    load(initial || undefined);
    // volta para a raiz (drives) se o caminho inicial não existir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error && initial) load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Selecionar pasta</strong>
          <button onClick={onClose}>✕</button>
        </div>

        {recent.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <p className="muted" style={{ margin: "0 0 4px", fontSize: "0.75rem" }}>
              Recentes — clique para usar
            </p>
            {recent.map((d) => (
              <div key={d} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                <button
                  className="dir-item"
                  style={{
                    flex: 1,
                    textAlign: "left",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={d}
                  onClick={() => onSelect(d)}
                >
                  🕘 <span className="mono">{d}</span>
                </button>
                <button
                  className="dir-item"
                  title="navegar a partir desta pasta"
                  onClick={() => load(d)}
                >
                  📂
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="picker-path mono">{data?.path ?? "Unidades"}</div>

        <div className="dir-list">
          {data?.parent !== null && data?.path && (
            <button className="dir-item" onClick={() => load(data.parent ?? undefined)}>
              ⬆ ..
            </button>
          )}
          {data?.path === null &&
            data.dirs.map((d) => (
              <button key={d} className="dir-item" onClick={() => load(d)}>
                💾 {d}
              </button>
            ))}
          {data?.path !== null &&
            data?.dirs.map((d) => (
              <button
                key={d}
                className="dir-item"
                onClick={() => load(`${data.path}${data.sep}${d}`)}
              >
                📁 {d}
              </button>
            ))}
          {data && data.dirs.length === 0 && data.path && (
            <p className="muted" style={{ padding: 8 }}>
              Sem subpastas.
            </p>
          )}
        </div>

        {error && <p className="error-box">{error}</p>}

        <div className="toolbar modal-foot">
          <button onClick={() => data && load(data.home)}>🏠 Início</button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Cancelar</button>
          <button
            className="primary"
            disabled={!data?.path}
            onClick={() => data?.path && onSelect(data.path)}
          >
            Selecionar esta pasta
          </button>
        </div>
      </div>
    </div>
  );
}
