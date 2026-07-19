import type { ReactNode } from "react";

interface Props {
  title: string;
  /** corpo do diálogo (a pergunta e eventuais avisos) */
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** Confirmação no padrão visual do app, no lugar do confirm() nativo do navegador. */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel = "Confirmar",
  onConfirm,
  onClose,
}: Props) {
  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button onClick={onClose}>✕</button>
        </div>
        <div style={{ marginBottom: 14 }}>{children}</div>
        <div className="toolbar modal-foot">
          <span style={{ flex: 1 }} />
          {/* foco inicial no caminho seguro: Enter cancela, confirmar exige clique consciente */}
          <button autoFocus onClick={onClose}>
            Cancelar
          </button>
          <button className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
