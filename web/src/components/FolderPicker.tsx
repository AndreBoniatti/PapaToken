import type { ReactElement } from "react";
import type { Folder } from "../api";

interface Props {
  folders: Folder[];
  /** pasta atual do item (aparece desabilitada como "atual"); null = raiz */
  current: number | null;
  onSelect: (folderId: number | null) => void;
  onClose: () => void;
}

/** Árvore de pastas para escolher o destino de uma tarefa ("mover para…"). */
export default function FolderPicker({ folders, current, onSelect, onClose }: Props) {
  const renderLevel = (parent: number | null, depth: number): ReactElement[] =>
    folders
      .filter((f) => f.parent_id === parent)
      .flatMap((f) => [
        <button
          key={f.id}
          className="dir-item"
          style={{ width: "100%", textAlign: "left", paddingLeft: 8 + depth * 18 }}
          disabled={f.id === current}
          onClick={() => onSelect(f.id)}
        >
          📁 {f.name}
          {f.id === current && <span className="muted"> (atual)</span>}
        </button>,
        ...renderLevel(f.id, depth + 1),
      ]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Mover para…</strong>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="dir-list">
          <button
            className="dir-item"
            style={{ width: "100%", textAlign: "left" }}
            disabled={current === null}
            onClick={() => onSelect(null)}
          >
            🏠 Raiz
            {current === null && <span className="muted"> (atual)</span>}
          </button>
          {renderLevel(null, 1)}
        </div>
      </div>
    </div>
  );
}
