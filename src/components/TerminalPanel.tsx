import { createEffect, onMount, onCleanup } from "solid-js";
import {
  store,
  closeTerminal,
  updateTerminalName,
  setActiveTask,
  reorderTask,
  getFontScale,
  registerFocusFn,
  unregisterFocusFn,
  triggerFocus,
  setTaskFocusedPanel,
} from "../store/store";
import { EditableText, type EditableTextHandle } from "./EditableText";
import { IconButton } from "./IconButton";
import { TerminalView } from "./TerminalView";
import { ScalablePanel } from "./ScalablePanel";
import { theme } from "../lib/theme";
import type { Terminal } from "../store/types";

interface TerminalPanelProps {
  terminal: Terminal;
  isActive: boolean;
}

export function TerminalPanel(props: TerminalPanelProps) {
  let panelRef!: HTMLDivElement;
  let titleEditHandle: EditableTextHandle | undefined;

  // Focus registration
  onMount(() => {
    const id = props.terminal.id;
    registerFocusFn(`${id}:title`, () => titleEditHandle?.startEdit());

    onCleanup(() => {
      unregisterFocusFn(`${id}:title`);
      unregisterFocusFn(`${id}:terminal`);
    });
  });

  // Respond to focus panel changes
  createEffect(() => {
    if (!props.isActive) return;
    const panel = store.focusedPanel[props.terminal.id] ?? "terminal";
    triggerFocus(`${props.terminal.id}:${panel}`);
  });

  const DRAG_THRESHOLD = 5;

  function handleTitleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.tagName === "INPUT") return;

    e.preventDefault();
    const startX = e.clientX;
    const titleBarEl = e.currentTarget as HTMLElement;
    const draggedCol = titleBarEl.closest("[data-task-id]") as HTMLElement;
    const sizeWrapper = draggedCol.parentElement;
    const columnsContainer = sizeWrapper?.parentElement as HTMLElement;
    if (!columnsContainer) return;

    let dragging = false;
    let lastDropIdx = -1;
    let indicator: HTMLElement | null = null;

    function getColumns(): HTMLElement[] {
      return Array.from(columnsContainer.querySelectorAll<HTMLElement>("[data-task-id]"));
    }

    function computeDropIndex(clientX: number): number {
      const columns = getColumns();
      for (let i = 0; i < columns.length; i++) {
        const rect = columns[i].getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) return i;
      }
      return columns.length;
    }

    function positionIndicator(dropIdx: number) {
      if (!indicator) return;
      const columns = getColumns();
      const containerRect = columnsContainer.getBoundingClientRect();
      let x: number;
      if (dropIdx < columns.length) {
        x = columns[dropIdx].parentElement!.getBoundingClientRect().left;
      } else if (columns.length > 0) {
        const rect = columns[columns.length - 1].parentElement!.getBoundingClientRect();
        x = rect.right;
      } else {
        x = containerRect.left;
      }
      indicator.style.left = `${x - 1}px`;
      indicator.style.top = `${containerRect.top}px`;
      indicator.style.height = `${containerRect.height}px`;
    }

    function onMove(ev: MouseEvent) {
      if (!dragging && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        document.body.classList.add("dragging-task");
        draggedCol.style.opacity = "0.4";
        indicator = document.createElement("div");
        indicator.className = "drag-drop-indicator";
        document.body.appendChild(indicator);
      }
      const dropIdx = computeDropIndex(ev.clientX);
      if (dropIdx !== lastDropIdx) {
        lastDropIdx = dropIdx;
        positionIndicator(dropIdx);
      }
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragging) {
        document.body.classList.remove("dragging-task");
        draggedCol.style.opacity = "";
        indicator?.remove();
        const fromIdx = store.taskOrder.indexOf(props.terminal.id);
        if (fromIdx !== -1 && lastDropIdx !== -1 && fromIdx !== lastDropIdx) {
          const adjustedTo = lastDropIdx > fromIdx ? lastDropIdx - 1 : lastDropIdx;
          reorderTask(fromIdx, adjustedTo);
        }
      } else {
        setActiveTask(props.terminal.id);
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? "active" : ""}`}
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        background: theme.taskContainerBg,
        "border-radius": "0",
        border: `1px solid ${theme.border}`,
        overflow: "clip",
        position: "relative",
      }}
      onClick={() => setActiveTask(props.terminal.id)}
    >
      {/* Title bar */}
      <div
        class={props.isActive ? "island-header-active" : ""}
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          padding: "0 10px",
          height: "36px",
          "min-height": "36px",
          background: "transparent",
          "border-bottom": `1px solid ${theme.border}`,
          "user-select": "none",
          cursor: "grab",
          "flex-shrink": "0",
        }}
        onMouseDown={handleTitleMouseDown}
      >
        <div style={{
          overflow: "hidden",
          flex: "1",
          "min-width": "0",
          display: "flex",
          "align-items": "center",
          gap: "8px",
        }}>
          <span style={{
            "font-family": "monospace",
            "font-size": "13px",
            color: theme.fgMuted,
            "flex-shrink": "0",
          }}>&gt;_</span>
          <EditableText
            value={props.terminal.name}
            onCommit={(v) => updateTerminalName(props.terminal.id, v)}
            class="editable-text"
            ref={(h) => titleEditHandle = h}
          />
        </div>
        <div style={{ display: "flex", gap: "4px", "margin-left": "8px", "flex-shrink": "0" }}>
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            }
            onClick={() => closeTerminal(props.terminal.id)}
            title="Close terminal"
          />
        </div>
      </div>

      {/* Terminal */}
      <ScalablePanel panelId={`${props.terminal.id}:terminal`}>
        <div
          class="focusable-panel"
          style={{
            height: "100%",
            position: "relative",
          }}
          onClick={() => setTaskFocusedPanel(props.terminal.id, "terminal")}
        >
          <TerminalView
            taskId={props.terminal.id}
            agentId={props.terminal.agentId}
            isFocused={props.isActive && store.focusedPanel[props.terminal.id] === "terminal"}
            command=""
            args={["-l"]}
            cwd=""
            onReady={(focusFn) => registerFocusFn(`${props.terminal.id}:terminal`, focusFn)}
            fontSize={Math.round(13 * getFontScale(`${props.terminal.id}:terminal`))}
            autoFocus
          />
        </div>
      </ScalablePanel>
    </div>
  );
}
