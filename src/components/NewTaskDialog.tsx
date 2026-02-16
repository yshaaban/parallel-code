import { createSignal, For, Show, onMount } from "solid-js";
import { store, createTask, toggleNewTaskDialog, loadAgents } from "../store/store";
import { toBranchName } from "../lib/branch-name";
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
    if (!agent) {
      setError("Select an agent");
      return;
    }

    if (!store.projectRoot) {
      setError("Set a project root first");
      return;
    }

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
      style={{
        position: "fixed",
        inset: "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "rgba(0,0,0,0.6)",
        "z-index": "1000",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) toggleNewTaskDialog(false);
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: "#1e1e2e",
          border: "1px solid #313244",
          "border-radius": "12px",
          padding: "24px",
          width: "420px",
          display: "flex",
          "flex-direction": "column",
          gap: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          style={{
            margin: "0",
            "font-size": "16px",
            color: "#cdd6f4",
            "font-weight": "600",
          }}
        >
          New Task
        </h2>

        <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <label
            style={{ "font-size": "12px", color: "#a6adc8" }}
          >
            Task name
          </label>
          <input
            ref={inputRef}
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="Add user authentication"
            style={{
              background: "#313244",
              border: "1px solid #45475a",
              "border-radius": "6px",
              padding: "8px 12px",
              color: "#cdd6f4",
              "font-size": "14px",
              outline: "none",
            }}
          />
          <Show when={branchPreview()}>
            <span
              style={{
                "font-size": "11px",
                color: "#6c7086",
                "font-family": "monospace",
              }}
            >
              branch: {branchPreview()}
            </span>
          </Show>
        </div>

        <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <label style={{ "font-size": "12px", color: "#a6adc8" }}>
            Agent
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <For each={store.availableAgents}>
              {(agent) => (
                <button
                  type="button"
                  onClick={() => setSelectedAgent(agent)}
                  style={{
                    flex: "1",
                    padding: "8px",
                    background:
                      selectedAgent()?.id === agent.id
                        ? "#89b4fa22"
                        : "#313244",
                    border:
                      selectedAgent()?.id === agent.id
                        ? "1px solid #89b4fa"
                        : "1px solid #45475a",
                    "border-radius": "6px",
                    color: "#cdd6f4",
                    cursor: "pointer",
                    "font-size": "12px",
                    "text-align": "center",
                  }}
                >
                  {agent.name}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={error()}>
          <span style={{ "font-size": "12px", color: "#f38ba8" }}>
            {error()}
          </span>
        </Show>

        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
          <button
            type="button"
            onClick={() => toggleNewTaskDialog(false)}
            style={{
              padding: "8px 16px",
              background: "#313244",
              border: "1px solid #45475a",
              "border-radius": "6px",
              color: "#a6adc8",
              cursor: "pointer",
              "font-size": "13px",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading() || !name().trim()}
            style={{
              padding: "8px 16px",
              background: "#89b4fa",
              border: "none",
              "border-radius": "6px",
              color: "#1e1e2e",
              cursor: "pointer",
              "font-size": "13px",
              "font-weight": "600",
              opacity: loading() || !name().trim() ? "0.5" : "1",
            }}
          >
            {loading() ? "Creating..." : "Create Task"}
          </button>
        </div>
      </form>
    </div>
  );
}
