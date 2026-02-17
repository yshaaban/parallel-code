import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { theme } from "../lib/theme";
import { parseDiff, isBinaryDiff, type DiffHunk } from "../lib/diff-parser";
import type { ChangedFile } from "../ipc/types";

interface DiffViewerDialogProps {
  file: ChangedFile | null;
  worktreePath: string;
  onClose: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  "?": "Untracked",
};

const STATUS_COLORS: Record<string, string> = {
  M: theme.warning,
  A: theme.success,
  D: theme.error,
  "?": theme.fgMuted,
};

export function DiffViewerDialog(props: DiffViewerDialogProps) {
  const [hunks, setHunks] = createSignal<DiffHunk[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [binary, setBinary] = createSignal(false);

  createEffect(() => {
    const file = props.file;
    if (!file) return;

    setLoading(true);
    setError("");
    setBinary(false);
    setHunks([]);

    invoke<string>("get_file_diff", {
      worktreePath: props.worktreePath,
      filePath: file.path,
    })
      .then((raw) => {
        if (isBinaryDiff(raw)) {
          setBinary(true);
        } else {
          setHunks(parseDiff(raw));
        }
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  });

  // Escape key to close
  createEffect(() => {
    if (!props.file) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  const lineNoPad = 4;

  return (
    <Portal>
      <Show when={props.file}>
        {(file) => (
          <div
            class="dialog-overlay"
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
              if (e.target === e.currentTarget) props.onClose();
            }}
          >
            <div
              class="dialog-content"
              style={{
                background: theme.islandBg,
                border: `1px solid ${theme.border}`,
                "border-radius": "14px",
                width: "90vw",
                height: "85vh",
                "max-width": "1400px",
                display: "flex",
                "flex-direction": "column",
                overflow: "hidden",
                "box-shadow":
                  "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
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
                    "font-size": "11px",
                    "font-weight": "600",
                    padding: "2px 8px",
                    "border-radius": "4px",
                    color: STATUS_COLORS[file().status] ?? theme.fgMuted,
                    background: "rgba(255,255,255,0.06)",
                  }}
                >
                  {STATUS_LABELS[file().status] ?? file().status}
                </span>
                <span
                  style={{
                    flex: "1",
                    "font-size": "13px",
                    "font-family": "'JetBrains Mono', monospace",
                    color: theme.fg,
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}
                >
                  {file().path}
                </span>
                <button
                  onClick={() => props.onClose()}
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

              {/* Body */}
              <div
                style={{
                  flex: "1",
                  overflow: "auto",
                  "font-family": "'JetBrains Mono', monospace",
                  "font-size": "12px",
                  "line-height": "1.5",
                }}
              >
                <Show when={loading()}>
                  <div style={{ padding: "40px", "text-align": "center", color: theme.fgMuted }}>
                    Loading diff...
                  </div>
                </Show>

                <Show when={error()}>
                  <div style={{ padding: "40px", "text-align": "center", color: theme.error }}>
                    {error()}
                  </div>
                </Show>

                <Show when={binary()}>
                  <div style={{ padding: "40px", "text-align": "center", color: theme.fgMuted }}>
                    Binary file — cannot display diff
                  </div>
                </Show>

                <Show when={!loading() && !error() && !binary() && hunks().length === 0}>
                  <div style={{ padding: "40px", "text-align": "center", color: theme.fgMuted }}>
                    No changes
                  </div>
                </Show>

                <Show when={!loading() && !error() && !binary() && hunks().length > 0}>
                  <table
                    style={{
                      width: "100%",
                      "border-collapse": "collapse",
                      "table-layout": "fixed",
                    }}
                  >
                    <For each={hunks()}>
                      {(hunk) => (
                        <>
                          <tr>
                            <td
                              colspan="3"
                              style={{
                                padding: "4px 12px",
                                background: "rgba(56, 132, 244, 0.08)",
                                color: "rgba(120, 170, 255, 0.8)",
                                "font-size": "11px",
                                "border-top": `1px solid ${theme.border}`,
                                "border-bottom": `1px solid ${theme.border}`,
                              }}
                            >
                              {hunk.header}
                            </td>
                          </tr>
                          <For each={hunk.lines}>
                            {(line) => (
                              <tr
                                style={{
                                  background:
                                    line.type === "add"
                                      ? "rgba(35, 209, 139, 0.08)"
                                      : line.type === "remove"
                                        ? "rgba(241, 76, 76, 0.08)"
                                        : "transparent",
                                }}
                              >
                                <td
                                  style={{
                                    width: `${lineNoPad}ch`,
                                    "min-width": `${lineNoPad}ch`,
                                    "text-align": "right",
                                    padding: "0 6px 0 8px",
                                    color: theme.fgSubtle,
                                    "user-select": "none",
                                    "border-right": `1px solid ${theme.border}`,
                                  }}
                                >
                                  {line.oldLineNo ?? ""}
                                </td>
                                <td
                                  style={{
                                    width: `${lineNoPad}ch`,
                                    "min-width": `${lineNoPad}ch`,
                                    "text-align": "right",
                                    padding: "0 6px",
                                    color: theme.fgSubtle,
                                    "user-select": "none",
                                    "border-right": `1px solid ${theme.border}`,
                                  }}
                                >
                                  {line.newLineNo ?? ""}
                                </td>
                                <td
                                  style={{
                                    padding: "0 12px",
                                    "white-space": "pre",
                                    overflow: "hidden",
                                    color:
                                      line.type === "add"
                                        ? theme.success
                                        : line.type === "remove"
                                          ? theme.error
                                          : theme.fg,
                                  }}
                                >
                                  <span
                                    style={{
                                      display: "inline-block",
                                      width: "1ch",
                                      "user-select": "none",
                                      color:
                                        line.type === "add"
                                          ? theme.success
                                          : line.type === "remove"
                                            ? theme.error
                                            : theme.fgSubtle,
                                    }}
                                  >
                                    {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                                  </span>
                                  {line.content}
                                </td>
                              </tr>
                            )}
                          </For>
                        </>
                      )}
                    </For>
                  </table>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </Portal>
  );
}
