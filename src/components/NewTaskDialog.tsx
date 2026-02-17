import { createSignal, For, Show, onMount } from "solid-js";
import { store, createTask, toggleNewTaskDialog, loadAgents } from "../store/store";
import { toBranchName } from "../lib/branch-name";
import { theme } from "../lib/theme";
import type { AgentDef } from "../ipc/types";

export function NewTaskDialog() {
  const [name, setName] = createSignal("");
  const [selectedAgent, setSelectedAgent] = createSignal<AgentDef | null>(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  let inputRef!: HTMLInputElement;

  onMount(async () => {
    if (store.availableAgents.length === 0) {
      await loadAgents();
    }
    setSelectedAgent(store.availableAgents[0] ?? null);
    inputRef?.focus();
  });

  const branchPreview = () => {
    const n = name().trim();
    return n ? `task/${toBranchName(n)}` : "";
  };

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const n = name().trim();
    if (!n) return;

    const agent = selectedAgent();
    if (!agent) { setError("Select an agent"); return; }
    if (!store.projectRoot) { setError("Set a project root first"); return; }

    setLoading(true);
    setError("");

    try {
      await createTask(n, agent);
      toggleNewTaskDialog(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
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
      onClick={(e) => { if (e.target === e.currentTarget) toggleNewTaskDialog(false); }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: theme.islandBg,
          border: `1px solid ${theme.border}`,
          "border-radius": "14px",
          padding: "28px",
          width: "460px",
          display: "flex",
          "flex-direction": "column",
          gap: "20px",
          "box-shadow": "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0", "font-size": "16px", color: theme.fg, "font-weight": "600" }}>
          New Task
        </h2>

        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            Task name
          </label>
          <input
            ref={inputRef}
            class="input-field"
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="Add user authentication"
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
          <Show when={branchPreview()}>
            <span style={{
              "font-size": "11px",
              color: theme.fgSubtle,
              "font-family": "'JetBrains Mono', monospace",
              padding: "0 2px",
            }}>
              {branchPreview()}
            </span>
          </Show>
        </div>

        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            Agent
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <For each={store.availableAgents}>
              {(agent) => {
                const isSelected = () => selectedAgent()?.id === agent.id;
                return (
                  <button
                    type="button"
                    class={`agent-btn ${isSelected() ? "selected" : ""}`}
                    onClick={() => setSelectedAgent(agent)}
                    style={{
                      flex: "1",
                      padding: "10px 8px",
                      background: isSelected() ? theme.bgSelected : theme.bgInput,
                      border: isSelected() ? `1px solid ${theme.accent}` : `1px solid ${theme.border}`,
                      "border-radius": "8px",
                      color: isSelected() ? theme.accentText : theme.fg,
                      cursor: "pointer",
                      "font-size": "12px",
                      "font-weight": isSelected() ? "500" : "400",
                      "text-align": "center",
                    }}
                  >
                    {agent.name}
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        <Show when={error()}>
          <div style={{
            "font-size": "12px",
            color: theme.error,
            background: "#f7546414",
            padding: "8px 12px",
            "border-radius": "8px",
            border: "1px solid #f7546433",
          }}>
            {error()}
          </div>
        </Show>

        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end", "padding-top": "4px" }}>
          <button
            type="button"
            class="btn-secondary"
            onClick={() => toggleNewTaskDialog(false)}
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
            type="submit"
            class="btn-primary"
            disabled={loading() || !name().trim()}
            style={{
              padding: "9px 20px",
              background: theme.accent,
              border: "none",
              "border-radius": "8px",
              color: theme.accentText,
              cursor: "pointer",
              "font-size": "13px",
              "font-weight": "500",
              opacity: loading() || !name().trim() ? "0.4" : "1",
            }}
          >
            {loading() ? "Creating..." : "Create Task"}
          </button>
        </div>
      </form>
    </div>
  );
}
