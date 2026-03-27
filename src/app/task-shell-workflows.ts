import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { setPendingShellCommand } from '../lib/bookmarks';
import { invoke, isElectronRuntime } from '../lib/ipc';
import { hasShellPromptReadyInTail } from '../lib/prompt-detection';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { saveBrowserWorkspaceState } from '../store/persistence';
import { setTaskFocusedPanel } from '../store/focus';
import { setStore, store } from '../store/state';
import {
  clearAgentActivity,
  clearAgentBusyState,
  getAgentOutputTail,
  isAgentIdle,
  markAgentBusy,
  markAgentSpawned,
} from '../store/taskStatus';
import { runWithTaskCommandLease } from './task-command-lease';
import { clearAgentSupervisionSnapshots } from './task-attention';
import { returnFallbackWhenTaskControlled } from './task-command-dispatch';

function persistBrowserWorkspaceShellLayout(): void {
  if (isElectronRuntime()) {
    return;
  }

  void saveBrowserWorkspaceState().catch((error) => {
    console.warn('Failed to persist browser shell layout:', error);
  });
}

export function spawnShellForTask(taskId: string, initialCommand?: string): string {
  const shellId = crypto.randomUUID();
  const task = store.tasks[taskId];
  if (!task) {
    return shellId;
  }

  let nextShellIndex: number | null = null;
  if (initialCommand) {
    setPendingShellCommand(shellId, initialCommand);
  }
  markAgentSpawned(shellId);
  setStore(
    produce((state) => {
      const nextTask = state.tasks[taskId];
      if (!nextTask) {
        return;
      }

      nextShellIndex = nextTask.shellAgentIds.length;
      nextTask.shellAgentIds.push(shellId);
    }),
  );
  if (nextShellIndex !== null) {
    setTaskFocusedPanel(taskId, `shell:${nextShellIndex}`);
  }
  persistBrowserWorkspaceShellLayout();
  return shellId;
}

export async function runBookmarkInTask(taskId: string, command: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) {
    return;
  }

  await runWithTaskCommandLease(taskId, 'run a shell command', async () => {
    const controllerId = getRuntimeClientId();
    for (let index = task.shellAgentIds.length - 1; index >= 0; index -= 1) {
      const shellId = task.shellAgentIds[index];
      if (!shellId || !isAgentIdle(shellId)) {
        continue;
      }

      if (!hasShellPromptReadyInTail(getAgentOutputTail(shellId))) {
        continue;
      }

      markAgentBusy(shellId);
      setTaskFocusedPanel(taskId, `shell:${index}`);
      try {
        const wroteToShell = await returnFallbackWhenTaskControlled(async () => {
          await invoke(IPC.WriteToAgent, {
            agentId: shellId,
            controllerId,
            data: command + '\r',
            taskId,
          });
          return true;
        }, false);
        if (!wroteToShell) {
          clearAgentBusyState(shellId);
          return;
        }
      } catch {
        clearAgentBusyState(shellId);
        spawnShellForTask(taskId, command);
      }
      return;
    }

    spawnShellForTask(taskId, command);
  });
}

export async function closeShell(taskId: string, shellId: string): Promise<void> {
  const closedIndex = store.tasks[taskId]?.shellAgentIds.indexOf(shellId) ?? -1;

  await invoke(IPC.KillAgent, { agentId: shellId });
  clearAgentActivity(shellId);
  clearAgentSupervisionSnapshots([shellId]);
  setStore(
    produce((state) => {
      const task = state.tasks[taskId];
      if (task) {
        task.shellAgentIds = task.shellAgentIds.filter((id) => id !== shellId);
      }
    }),
  );
  persistBrowserWorkspaceShellLayout();

  if (closedIndex < 0) {
    return;
  }

  const remaining = store.tasks[taskId]?.shellAgentIds.length ?? 0;
  if (remaining === 0) {
    setTaskFocusedPanel(taskId, 'shell-toolbar:0');
    return;
  }

  const focusIndex = Math.min(closedIndex, remaining - 1);
  setTaskFocusedPanel(taskId, `shell:${focusIndex}`);
}
