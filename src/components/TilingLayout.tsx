import { For, Show } from "solid-js";
import { store } from "../store/store";
import { TaskColumn } from "./TaskColumn";

export function TilingLayout() {
  return (
    <div
      style={{
        display: "flex",
        flex: "1",
        overflow: "hidden",
        height: "100%",
      }}
    >
      <Show
        when={store.taskOrder.length > 0}
        fallback={
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              width: "100%",
              height: "100%",
              color: "#585b70",
              "font-family": "monospace",
              "flex-direction": "column",
              gap: "12px",
            }}
          >
            <span style={{ "font-size": "18px" }}>No tasks open</span>
            <span style={{ "font-size": "13px", color: "#45475a" }}>
              Press Ctrl+N to create a new task
            </span>
          </div>
        }
      >
        <For each={store.taskOrder}>
          {(taskId) => {
            const task = () => store.tasks[taskId];
            return (
              <Show when={task()}>
                {(t) => (
                  <TaskColumn
                    task={t()}
                    isActive={store.activeTaskId === taskId}
                  />
                )}
              </Show>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
