import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "./core";
import type { WorktreeStatus } from "../ipc/types";

export type TaskDotStatus = "busy" | "waiting" | "ready";

// --- Agent activity tracking ---
// Plain map for raw timestamps (no reactive cost per PTY byte).
const lastActivityAt = new Map<string, number>();
// Reactive set of agent IDs considered "active" (updated on coarser schedule).
const [activeAgents, setActiveAgents] = createSignal<Set<string>>(new Set());

const ACTIVE_THRESHOLD_MS = 3_000;
const THROTTLE_MS = 1_000;
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Call this from the TerminalView Data handler. Throttled to once per second. */
export function markAgentActive(agentId: string): void {
  const now = Date.now();
  const prev = lastActivityAt.get(agentId) ?? 0;
  lastActivityAt.set(agentId, now);

  // Skip reactive updates if called within throttle window and already marked active
  if (now - prev < THROTTLE_MS && activeAgents().has(agentId)) return;

  if (!activeAgents().has(agentId)) {
    setActiveAgents((s) => {
      const next = new Set(s);
      next.add(agentId);
      return next;
    });
  }

  // Reset the inactivity timer
  const existing = activeTimers.get(agentId);
  if (existing) clearTimeout(existing);
  activeTimers.set(
    agentId,
    setTimeout(() => {
      setActiveAgents((s) => {
        const next = new Set(s);
        next.delete(agentId);
        return next;
      });
      activeTimers.delete(agentId);
    }, ACTIVE_THRESHOLD_MS)
  );
}

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  lastActivityAt.delete(agentId);
  const timer = activeTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(agentId);
  }
  setActiveAgents((prev) => {
    if (!prev.has(agentId)) return prev;
    const next = new Set(prev);
    next.delete(agentId);
    return next;
  });
}

// --- Derived status ---

export function getTaskDotStatus(taskId: string): TaskDotStatus {
  const agents = Object.values(store.agents).filter(
    (a) => a.taskId === taskId
  );
  const active = activeAgents(); // reactive read
  const hasActive = agents.some(
    (a) => a.status === "running" && active.has(a.id)
  );
  if (hasActive) return "busy";

  const git = store.taskGitStatus[taskId];
  if (git?.has_committed_changes && !git?.has_uncommitted_changes)
    return "ready";
  return "waiting";
}

// --- Git status polling ---

async function refreshTaskGitStatus(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  try {
    const status = await invoke<WorktreeStatus>("get_worktree_status", {
      worktreePath: task.worktreePath,
    });
    setStore("taskGitStatus", taskId, status);
  } catch {
    // Worktree may not exist yet or was removed — ignore
  }
}

/** Refresh git status for all tasks that don't have an active agent. */
export async function refreshAllTaskGitStatus(): Promise<void> {
  const taskIds = store.taskOrder;
  const active = activeAgents();
  for (const taskId of taskIds) {
    const agents = Object.values(store.agents).filter(
      (a) => a.taskId === taskId
    );
    const hasActive = agents.some(
      (a) => a.status === "running" && active.has(a.id)
    );
    if (!hasActive) {
      await refreshTaskGitStatus(taskId);
    }
  }
}

/** Refresh git status for a single task (e.g. after agent exits). */
export function refreshTaskStatus(taskId: string): void {
  refreshTaskGitStatus(taskId);
}

let pollingTimer: ReturnType<typeof setInterval> | null = null;

export function startTaskStatusPolling(): void {
  if (pollingTimer) return;
  pollingTimer = setInterval(refreshAllTaskGitStatus, 5000);
  // Run once immediately
  refreshAllTaskGitStatus();
}

export function stopTaskStatusPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
