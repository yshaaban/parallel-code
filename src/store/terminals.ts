import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { isTerminalCloseInProgress } from '../domain/task-closing';
import { invoke } from '../lib/ipc';
import { warn as logWarn } from '../lib/log';
import { createRandomId } from '../lib/random-id';
import { setStore, store, updateWindowTitle } from './core';
import { getTaskFocusedPanel, triggerFocus } from './focus';
import { saveCurrentRuntimeState } from './persistence-save';
import { getSelectedTaskAgentId } from './task-agent-selection';
import { removeAgentScopedStoreState, removeTerminalStoreState } from './task-state-cleanup';
import { clearAgentActivity } from './taskStatus';
import type { Task, Terminal } from './types';

let terminalCounter = 0;
let lastCreateTime = 0;

function getTaskActiveAgentId(
  task: Pick<Task, 'agentIds' | 'selectedAgentId'> | null | undefined,
): string | null {
  return task ? getSelectedTaskAgentId(task) : null;
}

function scrollPanelIntoView(panelId: string): void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;

  requestAnimationFrame(() => {
    const escapedId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(panelId)
        : panelId.replace(/["\\]/g, '\\$&');

    document
      .querySelector<HTMLElement>(`[data-task-id="${escapedId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'end', behavior: 'instant' });
  });
}

function focusPanel(panelId: string): void {
  const panel = getTaskFocusedPanel(panelId);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => triggerFocus(`${panelId}:${panel}`));
    return;
  }
  triggerFocus(`${panelId}:${panel}`);
}

function getPanelTitle(panelId: string): string | undefined {
  return store.tasks[panelId]?.name ?? store.terminals[panelId]?.name;
}

async function persistTerminalRemovalBestEffort(terminalId: string): Promise<void> {
  try {
    await saveCurrentRuntimeState();
  } catch (error) {
    logWarn('terminals.close', 'Failed to persist terminal removal', { terminalId, error });
  }
}

export function createTerminal(): void {
  const now = Date.now();
  if (now - lastCreateTime < 300) return;
  lastCreateTime = now;

  terminalCounter++;
  const id = createRandomId();
  const agentId = createRandomId();
  const name = `Terminal ${terminalCounter}`;

  const terminal: Terminal = { id, name, agentId };

  setStore('terminals', id, terminal);
  setStore('taskOrder', store.taskOrder.length, id);
  setStore('focusedPanel', id, 'terminal');
  setStore('activeTaskId', id);
  setStore('activeAgentId', null);
  setStore('sidebarFocused', false);

  updateWindowTitle(name);
  scrollPanelIntoView(id);
}

export async function closeTerminal(terminalId: string): Promise<void> {
  const terminal = store.terminals[terminalId];
  if (!terminal || isTerminalCloseInProgress(terminal)) return;

  // Set closing status synchronously to prevent concurrent close calls
  setStore('terminals', terminalId, 'closingStatus', 'closing');

  await invoke(IPC.KillAgent, { agentId: terminal.agentId }).catch((error) => {
    logWarn('terminals.close', 'KillAgent failed while closing terminal', { error });
  });
  clearAgentActivity(terminal.agentId);

  setStore(
    produce((state) => {
      let neighbor: string | null = null;
      if (state.activeTaskId === terminalId) {
        const index = state.taskOrder.indexOf(terminalId);
        const filteredOrder = state.taskOrder.filter((id) => id !== terminalId);
        const neighborIndex = index <= 0 ? 0 : index - 1;
        neighbor = filteredOrder[neighborIndex] ?? null;
      }

      removeTerminalStoreState(state, terminalId);
      removeAgentScopedStoreState(state, [terminal.agentId]);

      if (state.activeTaskId === terminalId) {
        state.activeTaskId = neighbor;
        const neighborTask = neighbor ? state.tasks[neighbor] : null;
        state.activeAgentId = getTaskActiveAgentId(neighborTask);
      }
    }),
  );

  const activeId = store.activeTaskId;
  if (activeId) {
    updateWindowTitle(getPanelTitle(activeId));
    focusPanel(activeId);
  } else {
    updateWindowTitle(undefined);
  }
  await persistTerminalRemovalBestEffort(terminalId);
}

export function updateTerminalName(terminalId: string, name: string): void {
  setStore('terminals', terminalId, 'name', name);
  if (store.activeTaskId === terminalId) {
    updateWindowTitle(name);
  }
}

/** Restore the auto-increment counter from persisted state. */
export function syncTerminalCounter(): void {
  let max = 0;
  for (const id of store.taskOrder) {
    const t = store.terminals[id];
    if (!t) continue;
    const match = t.name.match(/^Terminal (\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  terminalCounter = max;
}
