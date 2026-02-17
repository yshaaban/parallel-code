import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { theme } from "../lib/theme";

interface PlanEditorDialogProps {
  open: boolean;
  fileName: string;
  content: string;
  onConfirm: (editedContent: string) => void;
  onDismiss: () => void;
}

export function PlanEditorDialog(props: PlanEditorDialogProps) {
  const [editedContent, setEditedContent] = createSignal("");

  createEffect(() => {
    if (props.open) {
      setEditedContent(props.content);
    }
  });

  // Escape key to close
  createEffect(() => {
    if (!props.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onDismiss();
      }
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  return (
    <Portal>
      <Show when={props.open}>
        <div
          style={{
            position: "fixed",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            background: "rgba(0,0,0,0.55)",
            "z-index": "1000",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onDismiss();
          }}
        >
          <div
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              "border-radius": "14px",
              width: "80vw",
              height: "80vh",
              "max-width": "1000px",
              display: "flex",
              "flex-direction": "column",
              overflow: "hidden",
              "box-shadow": "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "10px",
                padding: "16px 20px",
                "border-bottom": `1px solid ${theme.border}`,
                "flex-shrink": "0",
              }}
            >
              <span
                style={{
                  flex: "1",
                  "font-size": "13px",
                  "font-weight": "600",
                  color: theme.fg,
                }}
              >
                Review Plan: {props.fileName}
              </span>
              <button
                onClick={() => props.onDismiss()}
                style={{
                  background: "transparent",
                  border: "none",
                  color: theme.fgMuted,
                  cursor: "pointer",
                  padding: "4px",
                  display: "flex",
                  "align-items": "center",
                  "border-radius": "4px",
                }}
                title="Close"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
              </button>
            </div>

            {/* Body: textarea */}
            <div style={{ flex: "1", overflow: "hidden", padding: "0" }}>
              <textarea
                value={editedContent()}
                onInput={(e) => setEditedContent(e.currentTarget.value)}
                style={{
                  width: "100%",
                  height: "100%",
                  background: theme.bgElevated,
                  border: "none",
                  padding: "16px 20px",
                  color: theme.fg,
                  "font-size": "13px",
                  "font-family": "'JetBrains Mono', 'Fira Code', monospace",
                  "line-height": "1.6",
                  resize: "none",
                  outline: "none",
                  "box-sizing": "border-box",
                }}
              />
            </div>

            {/* Footer */}
            <div
              style={{
                display: "flex",
                "justify-content": "flex-end",
                gap: "8px",
                padding: "12px 20px",
                "border-top": `1px solid ${theme.border}`,
                "flex-shrink": "0",
              }}
            >
              <button
                onClick={() => props.onDismiss()}
                style={{
                  background: "transparent",
                  border: `1px solid ${theme.border}`,
                  color: theme.fgMuted,
                  padding: "6px 16px",
                  "border-radius": "6px",
                  cursor: "pointer",
                  "font-size": "12px",
                  "font-family": "inherit",
                }}
              >
                Dismiss
              </button>
              <button
                onClick={() => props.onConfirm(editedContent())}
                style={{
                  background: theme.accent,
                  border: "none",
                  color: theme.accentText,
                  padding: "6px 16px",
                  "border-radius": "6px",
                  cursor: "pointer",
                  "font-size": "12px",
                  "font-weight": "600",
                  "font-family": "inherit",
                }}
              >
                Execute Plan
              </button>
            </div>
          </div>
        </div>
      </Show>
    </Portal>
  );
}
