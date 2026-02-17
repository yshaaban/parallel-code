import { createSignal, onMount, For, Show } from "solid-js";
import { store, setProjectRoot, toggleNewTaskDialog, setActiveTask, toggleSidebar, reorderTask } from "../store/store";
import { theme } from "../lib/theme";

const DEFAULT_PROJECT_ROOT = "/home/johannes/www/git-test";

const DRAG_THRESHOLD = 5;

export function Sidebar() {
  const [folderInput, setFolderInput] = createSignal(store.projectRoot ?? DEFAULT_PROJECT_ROOT);
  const [dragFromIndex, setDragFromIndex] = createSignal<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = createSignal<number | null>(null);
  let taskListRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!store.projectRoot) {
      setProjectRoot(DEFAULT_PROJECT_ROOT);
    }
  });

  async function handleSetRoot() {
    const path = folderInput().trim();
    if (!path) return;
    await setProjectRoot(path);
  }

  function computeDropIndex(clientY: number, fromIdx: number): number {
    if (!taskListRef) return fromIdx;
    const items = taskListRef.querySelectorAll<HTMLElement>("[data-task-index]");
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) return i;
    }
    return items.length;
  }

  function handleTaskMouseDown(e: MouseEvent, taskId: string, index: number) {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;

      if (!dragging) {
        dragging = true;
        setDragFromIndex(index);
        document.body.classList.add("dragging-task");
      }

      const dropIdx = computeDropIndex(ev.clientY, index);
      setDropTargetIndex(dropIdx);
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);

      if (dragging) {
        document.body.classList.remove("dragging-task");
        const from = dragFromIndex();
        const to = dropTargetIndex();
        setDragFromIndex(null);
        setDropTargetIndex(null);

        if (from !== null && to !== null && from !== to) {
          const adjustedTo = to > from ? to - 1 : to;
          reorderTask(from, adjustedTo);
        }
      } else {
        setActiveTask(taskId);
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      style={{
        width: "240px",
        "min-width": "240px",
        background: theme.islandBg,
        "border-right": `1px solid ${theme.border}`,
        display: "flex",
        "flex-direction": "column",
        padding: "16px",
        gap: "16px",
        "user-select": "none",
      }}
    >
      {/* Logo + collapse */}
      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "0 2px" }}>
          <div style={{
            width: "24px",
            height: "24px",
            "border-radius": "6px",
            background: `linear-gradient(135deg, ${theme.accent}, #6366f1)`,
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "font-size": "12px",
            "font-weight": "600",
            color: "#fff",
            "flex-shrink": "0",
          }}>M</div>
          <span style={{ "font-size": "14px", "font-weight": "600", color: theme.fg }}>
            AI Mush
          </span>
        </div>
        <button
          class="icon-btn"
          onClick={() => toggleSidebar()}
          title="Collapse sidebar (Ctrl+B)"
          style={{
            background: "transparent",
            border: `1px solid ${theme.border}`,
            color: theme.fgMuted,
            cursor: "pointer",
            "border-radius": "6px",
            padding: "2px 6px",
            "font-size": "11px",
            "line-height": "1",
          }}
        >
          &lt;
        </button>
      </div>

      {/* Project root */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <label style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em", padding: "0 2px" }}>
          Project
        </label>
        <input
          class="input-field"
          type="text"
          value={folderInput()}
          onInput={(e) => setFolderInput(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSetRoot(); }}
          placeholder="/path/to/repo"
          style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "8px",
            padding: "7px 10px",
            color: theme.fg,
            "font-size": "11px",
            "font-family": "'JetBrains Mono', 'Fira Code', monospace",
            outline: "none",
            width: "100%",
          }}
        />
        <button
          class="btn-secondary"
          onClick={handleSetRoot}
          style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            "border-radius": "8px",
            padding: "6px 10px",
            color: theme.fgMuted,
            cursor: "pointer",
            "font-size": "11px",
          }}
        >
          Set root
        </button>
        <span style={{ "font-size": "10px", color: theme.fgSubtle, padding: "0 2px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
          {store.projectRoot ?? "No project set"}
        </span>
      </div>

      <div style={{ height: "1px", background: theme.border }} />

      {/* New task button */}
      <button
        class="btn-primary"
        onClick={() => toggleNewTaskDialog(true)}
        style={{
          background: theme.accent,
          border: "none",
          "border-radius": "8px",
          padding: "9px 14px",
          color: theme.accentText,
          cursor: "pointer",
          "font-size": "13px",
          "font-weight": "500",
        }}
      >
        + New Task
      </button>

      {/* Task list */}
      <div ref={taskListRef} style={{ display: "flex", "flex-direction": "column", gap: "1px", flex: "1", overflow: "auto" }}>
        <span style={{ "font-size": "11px", color: theme.fgMuted, "text-transform": "uppercase", "letter-spacing": "0.05em", "margin-bottom": "6px", padding: "0 2px" }}>
          Tasks ({store.taskOrder.length})
        </span>
        <For each={store.taskOrder}>{(taskId, index) => {
          const task = () => store.tasks[taskId];
          return (
            <Show when={task()}>
              <Show when={dropTargetIndex() === index()}>
                <div class="drop-indicator" />
              </Show>
              <div
                class="task-item"
                data-task-index={index()}
                style={{
                  padding: "7px 10px",
                  "border-radius": "6px",
                  background: "transparent",
                  color: store.activeTaskId === taskId ? theme.fg : theme.fgMuted,
                  "font-size": "12px",
                  "font-weight": store.activeTaskId === taskId ? "500" : "400",
                  cursor: dragFromIndex() !== null ? "grabbing" : "pointer",
                  "white-space": "nowrap",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  opacity: dragFromIndex() === index() ? "0.4" : "1",
                }}
                onMouseDown={(e) => handleTaskMouseDown(e, taskId, index())}
              >
                {task()!.name}
              </div>
            </Show>
          );
        }}</For>
        <Show when={dropTargetIndex() === store.taskOrder.length}>
          <div class="drop-indicator" />
        </Show>
      </div>
    </div>
  );
}
