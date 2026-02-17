import { createSignal, For, Show, onMount } from "solid-js";
import { store, createTask, toggleNewTaskDialog, loadAgents, getProjectPath, getProject } from "../store/store";
import { toBranchName } from "../lib/branch-name";
import { theme } from "../lib/theme";
import type { AgentDef } from "../ipc/types";

export function NewTaskDialog() {
  const [name, setName] = createSignal("");
  const [selectedAgent, setSelectedAgent] = createSignal<AgentDef | null>(null);
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  let inputRef!: HTMLInputElement;

  onMount(async () => {
    if (store.availableAgents.length === 0) {
      await loadAgents();
    }
    setSelectedAgent(store.availableAgents[0] ?? null);
    setSelectedProjectId(store.lastProjectId ?? store.projects[0]?.id ?? null);
    inputRef?.focus();
  });

  const branchPreview = () => {
    const n = name().trim();
    return n ? `task/${toBranchName(n)}` : "";
  };

  const selectedProjectPath = () => {
    const pid = selectedProjectId();
    return pid ? getProjectPath(pid) : undefined;
  };

  const selectedProject = () => {
    const pid = selectedProjectId();
    return pid ? getProject(pid) : undefined;
  };

  const noProjects = () => store.projects.length === 0;

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const n = name().trim();
    if (!n) return;

    const agent = selectedAgent();
    if (!agent) { setError("Select an agent"); return; }

    const projectId = selectedProjectId();
    if (!projectId) { setError("Select a project"); return; }

    setLoading(true);
    setError("");

    try {
      await createTask(n, agent, projectId);
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
        <div>
          <h2 style={{ margin: "0 0 6px", "font-size": "16px", color: theme.fg, "font-weight": "600" }}>
            New Task
          </h2>
          <p style={{ margin: "0", "font-size": "12px", color: theme.fgMuted, "line-height": "1.5" }}>
            Creates a git branch and worktree so the AI agent can work in isolation without affecting your main branch.
          </p>
        </div>

        {/* Project selector */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            Project
          </label>
          <Show when={!noProjects()} fallback={
            <div style={{
              "font-size": "12px",
              color: theme.fgSubtle,
              background: theme.bgInput,
              padding: "10px 14px",
              "border-radius": "8px",
              border: `1px solid ${theme.border}`,
            }}>
              No projects configured. Add one in the sidebar first.
            </div>
          }>
            <select
              value={selectedProjectId() ?? ""}
              onChange={(e) => setSelectedProjectId(e.currentTarget.value || null)}
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                "border-radius": "8px",
                padding: "10px 14px",
                color: theme.fg,
                "font-size": "13px",
                outline: "none",
              }}
            >
              <For each={store.projects}>
                {(project) => (
                  <option value={project.id}>{project.name} — {project.path}</option>
                )}
              </For>
            </select>
          </Show>
        </div>

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
          <Show when={branchPreview() && selectedProjectPath()}>
            <div style={{
              "font-size": "11px",
              "font-family": "'JetBrains Mono', monospace",
              color: theme.fgSubtle,
              display: "flex",
              "flex-direction": "column",
              gap: "4px",
              padding: "8px 10px",
              background: theme.bgElevated,
              "border-radius": "6px",
              border: `1px solid ${theme.border}`,
            }}>
              <Show when={selectedProject()}>
                <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  <div style={{
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    background: selectedProject()!.color,
                    "flex-shrink": "0",
                  }} />
                  {selectedProject()!.name}
                </span>
              </Show>
              <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0", color: theme.fgMuted }}>
                  <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
                </svg>
                {branchPreview()}
              </span>
              <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0", color: theme.fgMuted }}>
                  <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                </svg>
                {selectedProjectPath()}/.worktrees/{branchPreview()}
              </span>
            </div>
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
            disabled={loading() || !name().trim() || noProjects() || !selectedProjectId()}
            style={{
              padding: "9px 20px",
              background: theme.accent,
              border: "none",
              "border-radius": "8px",
              color: theme.accentText,
              cursor: "pointer",
              "font-size": "13px",
              "font-weight": "500",
              opacity: loading() || !name().trim() || noProjects() || !selectedProjectId() ? "0.4" : "1",
            }}
          >
            {loading() ? "Creating..." : "Create Task"}
          </button>
        </div>
      </form>
    </div>
  );
}
