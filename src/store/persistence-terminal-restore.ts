import { removeTerminalStoreState } from './task-state-cleanup';
import { resolvePersistedAgentId } from './persistence-agent-defaults';
import type { LegacyPersistedState } from './persistence-legacy-state';
import type { AppStore, PersistedTerminal } from './types';

function getPersistedCollapsedTaskOrder(raw: LegacyPersistedState): string[] {
  return raw.collapsedTaskOrder ?? [];
}

export function restorePersistedTerminals(
  storeState: AppStore,
  raw: LegacyPersistedState,
  options: {
    pruneMissing?: boolean;
    agentsToDelete?: Set<string>;
  } = {},
): void {
  const rawTerminals = (raw.terminals ?? {}) as Record<string, PersistedTerminal>;
  if (options.pruneMissing) {
    const activeTerminalIds = new Set(raw.taskOrder);
    for (const existingTerminalId of Object.keys(storeState.terminals)) {
      if (!activeTerminalIds.has(existingTerminalId)) {
        if (options.agentsToDelete) {
          removeTerminalStoreState(storeState, existingTerminalId, {
            agentIdsToDelete: options.agentsToDelete,
          });
        } else {
          removeTerminalStoreState(storeState, existingTerminalId);
        }
      }
    }
  }

  for (const terminalId of raw.taskOrder) {
    const persistedTerminal = rawTerminals[terminalId];
    if (!persistedTerminal) {
      continue;
    }

    const existingTerminal = storeState.terminals[terminalId];
    const resolvedAgentId = resolvePersistedAgentId(
      persistedTerminal.agentId ?? existingTerminal?.agentId,
    );
    storeState.terminals[terminalId] = {
      id: persistedTerminal.id,
      name: persistedTerminal.name,
      agentId: resolvedAgentId,
    };
  }
}

export function syncPersistedTaskVisibility(storeState: AppStore, raw: LegacyPersistedState): void {
  storeState.taskOrder = raw.taskOrder.filter(
    (taskId) => storeState.tasks[taskId] || storeState.terminals[taskId],
  );
  const activeTaskSet = new Set(storeState.taskOrder);
  storeState.collapsedTaskOrder = getPersistedCollapsedTaskOrder(raw).filter(
    (taskId) => storeState.tasks[taskId] && !activeTaskSet.has(taskId),
  );
}
