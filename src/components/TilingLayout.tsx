import { Show, createMemo } from "solid-js";
import { store } from "../store/store";
import { ResizablePanel, type PanelChild } from "./ResizablePanel";
import { TaskPanel } from "./TaskPanel";
import { NewTaskPlaceholder } from "./NewTaskPlaceholder";
import { theme } from "../lib/theme";

export function TilingLayout() {
  const panelChildren = createMemo((): PanelChild[] => {
    const panels: PanelChild[] = store.taskOrder.map((taskId) => ({
      id: taskId,
      minSize: 320,
      content: () => {
        const task = store.tasks[taskId];
        if (!task) return <div />;
        return (
          <div style={{ height: "100%", padding: "6px 3px" }}>
            <TaskPanel task={task} isActive={store.activeTaskId === taskId} />
          </div>
        );
      },
    }));

    // Always add a fixed-width placeholder at the right edge
    panels.push({
      id: "__placeholder",
      initialSize: 54,
      fixed: true,
      content: () => <NewTaskPlaceholder />,
    });

    return panels;
  });

  return (
    <div
      style={{
        display: "flex",
        flex: "1",
        overflow: "hidden",
        height: "100%",
        padding: "2px 4px",
      }}
    >
      <Show
        when={store.taskOrder.length > 0}
        fallback={
          <div
            class="empty-state"
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              width: "100%",
              height: "100%",
              "flex-direction": "column",
              gap: "16px",
            }}
          >
            <div
              style={{
                width: "56px",
                height: "56px",
                "border-radius": "16px",
                background: theme.islandBg,
                border: `1px solid ${theme.border}`,
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                "font-size": "24px",
                color: theme.fgSubtle,
              }}
            >
              +
            </div>
            <div style={{ "text-align": "center" }}>
              <div
                style={{
                  "font-size": "15px",
                  color: theme.fgMuted,
                  "font-weight": "500",
                  "margin-bottom": "6px",
                }}
              >
                No tasks yet
              </div>
              <div style={{ "font-size": "12px", color: theme.fgSubtle }}>
                Press{" "}
                <kbd
                  style={{
                    background: theme.bgElevated,
                    border: `1px solid ${theme.border}`,
                    "border-radius": "4px",
                    padding: "2px 6px",
                    "font-family": "'JetBrains Mono', monospace",
                    "font-size": "11px",
                  }}
                >
                  Ctrl+N
                </kbd>{" "}
                to create a new task
              </div>
            </div>
          </div>
        }
      >
        <ResizablePanel direction="horizontal" children={panelChildren()} />
      </Show>
    </div>
  );
}
