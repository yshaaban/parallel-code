import { resolvePersistedTerminalAgentId } from './persistence-agent-defaults';
import type { LegacyPersistedState } from './persistence-legacy-state';
import { removeTerminalStoreState } from './task-state-cleanup';
import type { AppStore, ClientSessionTerminalPanels, PersistedTerminal } from './types';

function getPersistedCollapsedTaskOrder(raw: LegacyPersistedState): string[] {
  return raw.collapsedTaskOrder ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePersistedTerminal(value: unknown): PersistedTerminal | null {
  if (!isRecord(value)) {
    return null;
  }

  const terminal = value;
  if (
    typeof terminal.id !== 'string' ||
    typeof terminal.name !== 'string' ||
    (terminal.agentId !== undefined && typeof terminal.agentId !== 'string')
  ) {
    return null;
  }

  return {
    id: terminal.id,
    name: terminal.name,
    ...(terminal.agentId !== undefined ? { agentId: terminal.agentId } : {}),
  };
}

export function parsePersistedTerminalRecords(value: unknown): Record<string, PersistedTerminal> {
  if (!isRecord(value)) {
    return {};
  }

  const terminals: Record<string, PersistedTerminal> = {};
  for (const [terminalId, rawTerminal] of Object.entries(value)) {
    const terminal = parsePersistedTerminal(rawTerminal);
    if (!terminal || terminal.id !== terminalId) {
      continue;
    }

    terminals[terminalId] = terminal;
  }

  return terminals;
}

function parsePersistedPanelOrder(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter((panelId): panelId is string => typeof panelId === 'string');
}

function parsePersistedCollapsedPanelOrder(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }

  return parsePersistedPanelOrder(value);
}

export function parsePersistedTerminalPanels(value: unknown): ClientSessionTerminalPanels | null {
  if (!isRecord(value)) {
    return null;
  }

  const terminalPanels = value;
  const taskOrder = parsePersistedPanelOrder(terminalPanels.taskOrder);
  if (!taskOrder) {
    return null;
  }

  if (!isRecord(terminalPanels.terminals)) {
    return null;
  }

  const collapsedTaskOrder = parsePersistedCollapsedPanelOrder(terminalPanels.collapsedTaskOrder);
  if (!collapsedTaskOrder) {
    return null;
  }

  return {
    collapsedTaskOrder,
    taskOrder,
    terminals: parsePersistedTerminalRecords(terminalPanels.terminals),
  };
}

export function restorePersistedTerminals(
  storeState: AppStore,
  raw: LegacyPersistedState,
  options: {
    pruneMissing?: boolean;
    agentsToDelete?: Set<string>;
  } = {},
): void {
  const rawTerminals = parsePersistedTerminalRecords(raw.terminals);
  if (options.pruneMissing) {
    const activeTerminalIds = new Set(
      raw.taskOrder.filter((terminalId) => rawTerminals[terminalId] !== undefined),
    );
    for (const existingTerminalId of Object.keys(storeState.terminals)) {
      if (activeTerminalIds.has(existingTerminalId)) {
        continue;
      }

      if (options.agentsToDelete) {
        removeTerminalStoreState(storeState, existingTerminalId, {
          agentIdsToDelete: options.agentsToDelete,
        });
      } else {
        removeTerminalStoreState(storeState, existingTerminalId);
      }
    }
  }

  for (const terminalId of raw.taskOrder) {
    const persistedTerminal = rawTerminals[terminalId];
    if (!persistedTerminal) {
      continue;
    }

    const existingTerminal = storeState.terminals[terminalId];
    const resolvedAgentId = resolvePersistedTerminalAgentId(
      persistedTerminal.agentId ?? existingTerminal?.agentId,
    );
    if (!resolvedAgentId) {
      if (existingTerminal) {
        if (options.agentsToDelete) {
          removeTerminalStoreState(storeState, terminalId, {
            agentIdsToDelete: options.agentsToDelete,
          });
        } else {
          removeTerminalStoreState(storeState, terminalId);
        }
      }
      continue;
    }

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
