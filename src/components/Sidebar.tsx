import { createSignal } from "solid-js";
import { store, setProjectRoot, toggleNewTaskDialog, setActiveTask } from "../store/store";

export function Sidebar() {
  const [folderInput, setFolderInput] = createSignal(store.projectRoot ?? "");

  async function handleSetRoot() {
    const path = folderInput().trim();
    if (!path) return;
    await setProjectRoot(path);
  }

  return (
    <div
      style={{
        width: "220px",
        "min-width": "220px",
        background: "#11111b",
        "border-right": "1px solid #313244",
        display: "flex",
        "flex-direction": "column",
        padding: "12px",
        gap: "12px",
        "user-select": "none",
      }}
    >
      <div style={{ "font-size": "14px", "font-weight": "700", color: "#cdd6f4" }}>
        AI Mush
      </div>

      {/* Project root */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
        <label style={{ "font-size": "11px", color: "#6c7086" }}>
          Project root
        </label>
        <input
          type="text"
          value={folderInput()}
          onInput={(e) => setFolderInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSetRoot();
          }}
          placeholder="/path/to/repo"
          style={{
            background: "#1e1e2e",
            border: "1px solid #313244",
            "border-radius": "4px",
            padding: "6px 8px",
            color: "#cdd6f4",
            "font-size": "12px",
            "font-family": "monospace",
            outline: "none",
            width: "100%",
          }}
        />
        <button
          onClick={handleSetRoot}
          style={{
            background: "#313244",
            border: "1px solid #45475a",
            "border-radius": "4px",
            padding: "4px 8px",
            color: "#a6adc8",
            cursor: "pointer",
            "font-size": "11px",
          }}
        >
          Set root
        </button>
      </div>

      <div style={{ "border-top": "1px solid #313244", "padding-top": "8px" }}>
        <span style={{ "font-size": "11px", color: "#6c7086" }}>
          {store.projectRoot ? `Active: ${store.projectRoot}` : "No project set"}
        </span>
      </div>

      <button
        onClick={() => toggleNewTaskDialog(true)}
        style={{
          background: "#89b4fa",
          border: "none",
          "border-radius": "6px",
          padding: "8px 12px",
          color: "#1e1e2e",
          cursor: "pointer",
          "font-size": "13px",
          "font-weight": "600",
        }}
      >
        + New Task
      </button>

      {/* Task list */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "4px", flex: "1", overflow: "auto" }}>
        <span style={{ "font-size": "11px", color: "#6c7086", "margin-bottom": "4px" }}>
          Tasks ({store.taskOrder.length})
        </span>
        {store.taskOrder.map((taskId) => {
          const task = store.tasks[taskId];
          if (!task) return null;
          return (
            <div
              style={{
                padding: "4px 8px",
                "border-radius": "4px",
                background: store.activeTaskId === taskId ? "#313244" : "transparent",
                color: "#cdd6f4",
                "font-size": "12px",
                cursor: "pointer",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}
              onClick={() => setActiveTask(taskId)}
            >
              {task.name}
            </div>
          );
        })}
      </div>
    </div>
  );
}
