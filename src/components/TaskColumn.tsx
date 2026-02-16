import { For, Show } from "solid-js";
import { store, closeTask, setActiveTask, markAgentExited, addAgentToTask } from "../store/store";
import { TerminalView } from "./TerminalView";
import type { Task } from "../store/types";

interface TaskColumnProps {
  task: Task;
  isActive: boolean;
}

export function TaskColumn(props: TaskColumnProps) {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "flex": "1 1 0",
        "min-width": "300px",
        height: "100%",
        "border-right": "1px solid #313244",
        outline: props.isActive ? "2px solid #89b4fa" : "none",
        "outline-offset": "-2px",
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          padding: "6px 12px",
          background: "#181825",
          "border-bottom": "1px solid #313244",
          "min-height": "36px",
          "user-select": "none",
        }}
      >
        <div style={{ display: "flex", "flex-direction": "column", gap: "2px", overflow: "hidden" }}>
          <span
            style={{
              "font-size": "13px",
              "font-weight": "600",
              color: "#cdd6f4",
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
            }}
          >
            {props.task.name}
          </span>
          <span
            style={{
              "font-size": "11px",
              color: "#6c7086",
              "font-family": "monospace",
            }}
          >
            {props.task.branchName}
          </span>
        </div>
        <div style={{ display: "flex", gap: "4px", "flex-shrink": "0" }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const firstAgent = store.availableAgents[0];
              if (firstAgent) addAgentToTask(props.task.id, firstAgent);
            }}
            style={{
              background: "none",
              border: "1px solid #45475a",
              color: "#a6adc8",
              cursor: "pointer",
              "border-radius": "4px",
              padding: "2px 6px",
              "font-size": "12px",
            }}
            title="Add agent"
          >
            +
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              closeTask(props.task.id);
            }}
            style={{
              background: "none",
              border: "1px solid #45475a",
              color: "#a6adc8",
              cursor: "pointer",
              "border-radius": "4px",
              padding: "2px 6px",
              "font-size": "12px",
            }}
            title="Close task"
          >
            x
          </button>
        </div>
      </div>

      {/* Agent terminals */}
      <div style={{ flex: "1", display: "flex", "flex-direction": "column", overflow: "hidden" }}>
        <For each={props.task.agentIds}>
          {(agentId) => {
            const agent = () => store.agents[agentId];
            return (
              <Show when={agent()}>
                {(a) => (
                  <div
                    style={{
                      flex: "1",
                      position: "relative",
                      "border-top": "1px solid #313244",
                      overflow: "hidden",
                    }}
                  >
                    <Show when={a().status === "exited"}>
                      <div
                        style={{
                          position: "absolute",
                          top: "4px",
                          right: "8px",
                          "z-index": "10",
                          "font-size": "11px",
                          color: a().exitCode === 0 ? "#a6e3a1" : "#f38ba8",
                          background: "#1e1e2ecc",
                          padding: "2px 8px",
                          "border-radius": "4px",
                        }}
                      >
                        exited ({a().exitCode ?? "?"})
                      </div>
                    </Show>
                    <TerminalView
                      agentId={a().id}
                      command={a().def.command}
                      args={a().def.args}
                      cwd={props.task.worktreePath}
                      onExit={(code) => markAgentExited(a().id, code)}
                    />
                  </div>
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
}
