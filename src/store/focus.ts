import { batch } from "solid-js";
import { store, setStore } from "./core";
import { setActiveTask } from "./navigation";
import type { PanelId } from "./types";

// Imperative focus registry: components register focus callbacks on mount
const focusRegistry = new Map<string, () => void>();
const actionRegistry = new Map<string, () => void>();

export function registerFocusFn(key: string, fn: () => void): void {
  focusRegistry.set(key, fn);
}

export function unregisterFocusFn(key: string): void {
  focusRegistry.delete(key);
}

export function triggerFocus(key: string): void {
  focusRegistry.get(key)?.();
}

export function registerAction(key: string, fn: () => void): void {
  actionRegistry.set(key, fn);
}

export function unregisterAction(key: string): void {
  actionRegistry.delete(key);
}

export function triggerAction(key: string): void {
  actionRegistry.get(key)?.();
}

const PANEL_ORDER: PanelId[] = ["notes", "changed-files", "shell", "ai-terminal", "prompt"];

export function getTaskFocusedPanel(taskId: string): PanelId {
  return store.focusedPanel[taskId] ?? "prompt";
}

export function setTaskFocusedPanel(taskId: string, panel: PanelId): void {
  setStore("focusedPanel", taskId, panel);
  setStore("sidebarFocused", false);
  triggerFocus(`${taskId}:${panel}`);
}

export function focusSidebar(): void {
  setStore("sidebarFocused", true);
  triggerFocus("sidebar");
}

export function unfocusSidebar(): void {
  setStore("sidebarFocused", false);
}

function getAvailablePanels(taskId: string): PanelId[] {
  const task = store.tasks[taskId];
  if (!task) return PANEL_ORDER;
  return task.shellAgentIds.length > 0
    ? PANEL_ORDER
    : PANEL_ORDER.filter((p) => p !== "shell");
}

export function navigateRow(direction: "up" | "down"): void {
  if (store.sidebarFocused) {
    // In sidebar, up/down navigates tasks (handled by sidebar component)
    return;
  }

  const taskId = store.activeTaskId;
  if (!taskId) return;

  const panels = getAvailablePanels(taskId);
  const current = getTaskFocusedPanel(taskId);
  const idx = panels.indexOf(current);
  if (idx === -1) {
    setTaskFocusedPanel(taskId, panels[0]);
    return;
  }

  const next = direction === "up" ? idx - 1 : idx + 1;
  if (next < 0 || next >= panels.length) return; // Stop at edges
  setTaskFocusedPanel(taskId, panels[next]);
}

export function navigateColumn(direction: "left" | "right"): void {
  const taskId = store.activeTaskId;

  // Sidebar boundary
  if (store.sidebarFocused) {
    if (direction === "right" && taskId) {
      unfocusSidebar();
      const panel = getTaskFocusedPanel(taskId);
      setTaskFocusedPanel(taskId, panel);
    }
    return;
  }

  if (!taskId) return;

  const current = getTaskFocusedPanel(taskId);

  // Inner-column navigation for notes/changed-files row
  if (current === "notes" && direction === "right") {
    setTaskFocusedPanel(taskId, "changed-files");
    return;
  }
  if (current === "changed-files" && direction === "left") {
    setTaskFocusedPanel(taskId, "notes");
    return;
  }

  // Shell row: navigate between shell tabs
  if (current === "shell") {
    const task = store.tasks[taskId];
    if (task && task.shellAgentIds.length > 1) {
      // Shell tab navigation — for now, shells are all visible side-by-side
      // so just cross to adjacent task at edges
    }
  }

  // Cross-task or sidebar boundary
  const { taskOrder } = store;
  const taskIdx = taskOrder.indexOf(taskId);

  if (direction === "left") {
    // At leftmost cell of first task (or sidebar hidden): go to sidebar
    if (taskIdx === 0 && (current === "notes" || current === "shell" || current === "ai-terminal" || current === "prompt")) {
      if (store.sidebarVisible) {
        focusSidebar();
      }
      return;
    }
    // Cross to previous task, land on rightmost cell of same row
    const prevTaskId = taskOrder[taskIdx - 1];
    if (prevTaskId) {
      const prevPanel = mapToRowRightmost(current);
      batch(() => {
        setStore("focusedPanel", prevTaskId, prevPanel);
        setActiveTask(prevTaskId);
      });
      triggerFocus(`${prevTaskId}:${prevPanel}`);
    }
  } else {
    if (current === "changed-files" || current === "shell" || current === "ai-terminal" || current === "prompt") {
      // At rightmost cell: cross to next task
      const nextTaskId = taskOrder[taskIdx + 1];
      if (nextTaskId) {
        const nextPanel = mapToRowLeftmost(current);
        batch(() => {
          setStore("focusedPanel", nextTaskId, nextPanel);
          setActiveTask(nextTaskId);
        });
        triggerFocus(`${nextTaskId}:${nextPanel}`);
      }
    }
  }
}

/** Map a panel to its leftmost cell in the same row. */
function mapToRowLeftmost(panel: PanelId): PanelId {
  if (panel === "changed-files") return "notes";
  return panel;
}

/** Map a panel to its rightmost cell in the same row. */
function mapToRowRightmost(panel: PanelId): PanelId {
  if (panel === "notes") return "changed-files";
  return panel;
}

export function setPendingAction(action: { type: "close" | "merge" | "push"; taskId: string } | null): void {
  setStore("pendingAction", action);
}

export function clearPendingAction(): void {
  setStore("pendingAction", null);
}

export function toggleHelpDialog(show?: boolean): void {
  setStore("showHelpDialog", show ?? !store.showHelpDialog);
}

export function sendActivePrompt(): void {
  const taskId = store.activeTaskId;
  if (!taskId) return;
  triggerAction(`${taskId}:send-prompt`);
}
