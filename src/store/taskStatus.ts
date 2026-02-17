import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { store, setStore } from "./core";
import type { WorktreeStatus } from "../ipc/types";

export type TaskDotStatus = "busy" | "waiting" | "ready";

// --- Agent activity tracking ---
// Plain map for raw timestamps (no reactive cost per PTY byte).
const lastDataAt = new Map<string, number>();
// Reactive set of agent IDs considered "active" (updated on coarser schedule).
const [activeAgents, setActiveAgents] = createSignal<Set<string>>(new Set());

// How long after the last data event before transitioning back to idle.
const INACTIVE_TIMEOUT_MS = 10_000;
// Delay before confirming an agent is truly working (filters out single
// bursts like terminal redraws on focus change).
const ACTIVATION_DELAY_MS = 1_500;
// Throttle reactive updates while already active.
const THROTTLE_MS = 1_000;

const inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function addToActive(agentId: string): void {
  setActiveAgents((s) => {
    const next = new Set(s);
    next.add(agentId);
    return next;
  });
}

function removeFromActive(agentId: string): void {
  setActiveAgents((s) => {
    if (!s.has(agentId)) return s;
    const next = new Set(s);
    next.delete(agentId);
    return next;
  });
}

function resetInactivityTimer(agentId: string): void {
  const existing = inactivityTimers.get(agentId);
  if (existing) clearTimeout(existing);
  inactivityTimers.set(
    agentId,
    setTimeout(() => {
      removeFromActive(agentId);
      inactivityTimers.delete(agentId);
    }, INACTIVE_TIMEOUT_MS)
  );
}

/** Call this from the TerminalView Data handler. */
export function markAgentActive(agentId: string): void {
  const now = Date.now();
  const prev = lastDataAt.get(agentId) ?? 0;
  lastDataAt.set(agentId, now);

  if (activeAgents().has(agentId)) {
    // Already active — just reset the inactivity timer (throttled).
    if (now - prev < THROTTLE_MS) return;
    resetInactivityTimer(agentId);
    return;
  }

  // Not yet active — schedule a confirmation check.
  // If data is still flowing when the timer fires, the agent is truly working.
  // Single bursts (e.g. terminal redraw on focus) will have stopped by then.
  if (!activationTimers.has(agentId)) {
    activationTimers.set(
      agentId,
      setTimeout(() => {
        activationTimers.delete(agentId);
        const last = lastDataAt.get(agentId) ?? 0;
        if (Date.now() - last < 1_000) {
          addToActive(agentId);
          resetInactivityTimer(agentId);
        }
      }, ACTIVATION_DELAY_MS)
    );
  }
}

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  lastDataAt.delete(agentId);
  const inactivity = inactivityTimers.get(agentId);
  if (inactivity) {
    clearTimeout(inactivity);
    inactivityTimers.delete(agentId);
  }
  const activation = activationTimers.get(agentId);
  if (activation) {
    clearTimeout(activation);
    activationTimers.delete(agentId);
  }
  removeFromActive(agentId);
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
