import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { updateProject, PASTEL_HUES } from "../store/store";
import { toBranchName } from "../lib/branch-name";
import { theme } from "../lib/theme";
import type { Project } from "../store/types";

interface EditProjectDialogProps {
  project: Project | null;
  onClose: () => void;
}

function hueFromColor(color: string): number {
  const match = color.match(/hsl\((\d+)/);
  return match ? Number(match[1]) : 0;
}

export function EditProjectDialog(props: EditProjectDialogProps) {
  const [name, setName] = createSignal("");
  const [selectedHue, setSelectedHue] = createSignal(0);
  const [branchPrefix, setBranchPrefix] = createSignal("task");
  let nameRef!: HTMLInputElement;

  // Sync signals when project prop changes
  createEffect(() => {
    const p = props.project;
    if (!p) return;
    setName(p.name);
    setSelectedHue(hueFromColor(p.color));
    setBranchPrefix(p.branchPrefix ?? "task");
    requestAnimationFrame(() => nameRef?.focus());
  });

  // Escape key
  createEffect(() => {
    if (!props.project) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  const canSave = () => name().trim().length > 0;

  function handleSave() {
    if (!canSave() || !props.project) return;
    updateProject(props.project.id, {
      name: name().trim(),
      color: `hsl(${selectedHue()}, 70%, 75%)`,
      branchPrefix: branchPrefix().trim() || "task",
    });
    props.onClose();
  }

  return (
    <Portal>
      <Show when={props.project}>
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
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              "border-radius": "14px",
              padding: "28px",
              width: "420px",
              display: "flex",
              "flex-direction": "column",
              gap: "20px",
              "box-shadow":
                "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              style={{
                margin: "0",
                "font-size": "16px",
                color: theme.fg,
                "font-weight": "600",
              }}
            >
              Edit Project
            </h2>

            {/* Path (read-only) */}
            <div style={{ "font-size": "12px", color: theme.fgSubtle, "font-family": "'JetBrains Mono', monospace" }}>
              {props.project!.path}
            </div>

            {/* Name */}
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
              <label
                style={{
                  "font-size": "11px",
                  color: theme.fgMuted,
                  "text-transform": "uppercase",
                  "letter-spacing": "0.05em",
                }}
              >
                Name
              </label>
              <input
                ref={nameRef}
                class="input-field"
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSave()) handleSave();
                }}
                style={{
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  "border-radius": "8px",
                  padding: "10px 14px",
                  color: theme.fg,
                  "font-size": "13px",
                  outline: "none",
                }}
              />
            </div>

            {/* Branch prefix */}
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
              <label
                style={{
                  "font-size": "11px",
                  color: theme.fgMuted,
                  "text-transform": "uppercase",
                  "letter-spacing": "0.05em",
                }}
              >
                Branch prefix
              </label>
              <input
                class="input-field"
                type="text"
                value={branchPrefix()}
                onInput={(e) => setBranchPrefix(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSave()) handleSave();
                }}
                placeholder="task"
                style={{
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  "border-radius": "8px",
                  padding: "10px 14px",
                  color: theme.fg,
                  "font-size": "13px",
                  "font-family": "'JetBrains Mono', monospace",
                  outline: "none",
                }}
              />
              <Show when={branchPrefix().trim()}>
                <div
                  style={{
                    "font-size": "11px",
                    "font-family": "'JetBrains Mono', monospace",
                    color: theme.fgSubtle,
                    padding: "2px 2px 0",
                    display: "flex",
                    "align-items": "center",
                    gap: "6px",
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
                    <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
                  </svg>
                  {branchPrefix().trim()}/{toBranchName("example-branch-name")}
                </div>
              </Show>
            </div>

            {/* Color palette */}
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
              <label
                style={{
                  "font-size": "11px",
                  color: theme.fgMuted,
                  "text-transform": "uppercase",
                  "letter-spacing": "0.05em",
                }}
              >
                Color
              </label>
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                <For each={PASTEL_HUES}>
                  {(hue) => {
                    const color = `hsl(${hue}, 70%, 75%)`;
                    const isSelected = () => selectedHue() === hue;
                    return (
                      <button
                        type="button"
                        onClick={() => setSelectedHue(hue)}
                        style={{
                          width: "28px",
                          height: "28px",
                          "border-radius": "50%",
                          background: color,
                          border: isSelected() ? `2px solid ${theme.fg}` : "2px solid transparent",
                          outline: isSelected() ? `2px solid ${theme.accent}` : "none",
                          "outline-offset": "1px",
                          cursor: "pointer",
                          padding: "0",
                          "flex-shrink": "0",
                        }}
                        title={`Hue ${hue}`}
                      />
                    );
                  }}
                </For>
              </div>
            </div>

            {/* Buttons */}
            <div
              style={{
                display: "flex",
                gap: "8px",
                "justify-content": "flex-end",
                "padding-top": "4px",
              }}
            >
              <button
                type="button"
                class="btn-secondary"
                onClick={() => props.onClose()}
                style={{
                  padding: "9px 18px",
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  "border-radius": "8px",
                  color: theme.fgMuted,
                  cursor: "pointer",
                  "font-size": "13px",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn-primary"
                disabled={!canSave()}
                onClick={handleSave}
                style={{
                  padding: "9px 20px",
                  background: theme.accent,
                  border: "none",
                  "border-radius": "8px",
                  color: theme.accentText,
                  cursor: canSave() ? "pointer" : "not-allowed",
                  "font-size": "13px",
                  "font-weight": "500",
                  opacity: canSave() ? "1" : "0.4",
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </Show>
    </Portal>
  );
}
