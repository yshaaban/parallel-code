import { For, Show, createMemo } from "solid-js";
import { agents, status } from "./ws";
import type { RemoteAgent } from "../../electron/remote/protocol";

interface AgentListProps {
  onSelect: (agentId: string, taskName: string) => void;
}

export function AgentList(props: AgentListProps) {
  const running = createMemo(() => agents().filter((a) => a.status === "running").length);
  const total = createMemo(() => agents().length);

  return (
    <div style={{
      display: "flex",
      "flex-direction": "column",
      height: "100%",
      background: "#1e1e1e",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        padding: "16px 16px 12px",
        "border-bottom": "1px solid #333",
      }}>
        <span style={{ "font-size": "18px", "font-weight": "600", color: "#e0e0e0" }}>
          Parallel Code
        </span>
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <div style={{
            width: "8px",
            height: "8px",
            "border-radius": "50%",
            background: status() === "connected" ? "#4ade80" : status() === "connecting" ? "#facc15" : "#ef4444",
          }} />
          <span style={{ "font-size": "13px", color: "#999" }}>
            {running()}/{total()}
          </span>
        </div>
      </div>

      {/* Connection status banner */}
      <Show when={status() !== "connected"}>
        <div style={{
          padding: "8px 16px",
          background: status() === "connecting" ? "#78350f" : "#7f1d1d",
          color: status() === "connecting" ? "#fde68a" : "#fca5a5",
          "font-size": "13px",
          "text-align": "center",
          "flex-shrink": "0",
        }}>
          {status() === "connecting" ? "Reconnecting..." : "Disconnected — check your network"}
        </div>
      </Show>

      {/* Agent cards */}
      <div style={{
        flex: "1",
        overflow: "auto",
        padding: "12px",
        display: "flex",
        "flex-direction": "column",
        gap: "8px",
        "-webkit-overflow-scrolling": "touch",
        "padding-bottom": "max(12px, env(safe-area-inset-bottom))",
      }}>
        <Show when={agents().length === 0}>
          <div style={{
            "text-align": "center",
            color: "#666",
            "padding-top": "60px",
            "font-size": "14px",
          }}>
            <Show when={status() === "connected"} fallback={<span>Connecting...</span>}>
              <span>No active agents</span>
            </Show>
          </div>
        </Show>

        {/* Experimental notice */}
        <div style={{
          padding: "8px 12px",
          background: "#2a2a1e",
          border: "1px solid #444422",
          "border-radius": "8px",
          "font-size": "12px",
          color: "#ccc",
          "text-align": "center",
          "line-height": "1.5",
        }}>
          This is an experimental feature.{" "}
          <a
            href="https://github.com/johannesjo/parallel-code/issues"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#4ade80" }}
          >
            Report bugs
          </a>
        </div>

        <For each={agents()}>
          {(agent: RemoteAgent) => (
            <div
              onClick={() => props.onSelect(agent.agentId, agent.taskName)}
              style={{
                background: "#2a2a2a",
                border: "1px solid #333",
                "border-radius": "10px",
                padding: "14px 16px",
                cursor: "pointer",
                display: "flex",
                "flex-direction": "column",
                gap: "6px",
                "touch-action": "manipulation",
              }}
            >
              <div style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
              }}>
                <div style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  "min-width": "0",
                  flex: "1",
                }}>
                  <div style={{
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    background: agent.status === "running" ? "#4ade80" : "#666",
                    "flex-shrink": "0",
                  }} />
                  <span style={{
                    "font-size": "14px",
                    "font-weight": "500",
                    color: "#e0e0e0",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}>
                    {agent.taskName}
                  </span>
                </div>
                <span style={{
                  "font-size": "12px",
                  color: agent.status === "running" ? "#4ade80" : "#666",
                  "flex-shrink": "0",
                }}>
                  {agent.status}
                </span>
              </div>

              <div style={{
                "font-size": "11px",
                "font-family": "'JetBrains Mono', 'Courier New', monospace",
                color: "#666",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}>
                {agent.agentId}
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
