import type { BrowserColdBootstrapProjection } from './browser-cold-bootstrap.js';
import { decodeMergeProgressPersistenceProjection } from './task-merge.js';
import type { AgentDef } from '../ipc/types.js';
import { getLocalDateKey } from '../lib/date.js';
import { isHydraStartupMode } from '../lib/hydra.js';
import {
  forEachHydratedPersistedTaskInContext,
  parsePersistedLoadContext,
} from '../store/persistence-load-context.js';
import type { LegacyPersistedState } from '../store/persistence-legacy-state.js';
import type { BrowserColdBootstrapProjectionBuildOptions } from '../store/browser-cold-bootstrap-projection-types.js';
import type { Task } from '../store/types.js';

interface ProjectionTempState {
  collapsedTaskOrder: string[];
  taskOrder: string[];
  tasks: Record<string, Task>;
}

function createEmptyBrowserColdBootstrapProjection(
  options?: Partial<BrowserColdBootstrapProjectionBuildOptions>,
): BrowserColdBootstrapProjection {
  return {
    availableAgents: [...(options?.currentAvailableAgents ?? [])],
    collapsedTaskOrder: [],
    completedTaskCount: 0,
    completedTaskDate: getLocalDateKey(),
    customAgents: [...(options?.currentCustomAgents ?? [])],
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    lastProjectId: null,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    mergeProgress: null,
    projects: [],
    taskOrder: [],
    tasks: {},
    terminals: {},
  };
}

function getCompletedTaskDate(value: unknown, today: string): string {
  if (typeof value === 'string') {
    return value;
  }

  return today;
}

function getHydraStartupMode(value: unknown): BrowserColdBootstrapProjection['hydraStartupMode'] {
  if (typeof value === 'string' && isHydraStartupMode(value)) {
    return value;
  }

  return 'auto';
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function withSavedAgentDefs<
  TTask extends { savedAgentDef?: AgentDef; savedAgentDefs?: AgentDef[] },
>(task: TTask, agentDefs: AgentDef[]): TTask {
  if (agentDefs.length === 0) {
    return task;
  }

  return {
    ...task,
    ...(agentDefs[0] ? { savedAgentDef: agentDefs[0] } : {}),
    ...(agentDefs.length > 1 ? { savedAgentDefs: agentDefs } : {}),
  };
}

function syncProjectionTaskVisibility(state: ProjectionTempState, raw: LegacyPersistedState): void {
  state.taskOrder = raw.taskOrder.filter((taskId) => state.tasks[taskId] !== undefined);
  const activeTaskIds = new Set(state.taskOrder);
  const collapsedTaskOrder = raw.collapsedTaskOrder ?? [];
  state.collapsedTaskOrder = collapsedTaskOrder.filter(
    (taskId) => state.tasks[taskId] !== undefined && !activeTaskIds.has(taskId),
  );
}

export function buildBrowserColdBootstrapProjectionFromJson(
  json: string | null,
  options: BrowserColdBootstrapProjectionBuildOptions,
): BrowserColdBootstrapProjection {
  if (!json) {
    return createEmptyBrowserColdBootstrapProjection(options);
  }

  const context = parsePersistedLoadContext(json, {
    currentAvailableAgents: options.currentAvailableAgents,
    currentCustomAgents: options.currentCustomAgents,
    invalidMessage: 'Invalid browser cold bootstrap workspace state structure, skipping load',
    parseErrorMessage: 'Failed to parse browser cold bootstrap workspace state',
  });
  if (!context) {
    return createEmptyBrowserColdBootstrapProjection(options);
  }

  const tempState: ProjectionTempState = {
    collapsedTaskOrder: [],
    taskOrder: [],
    tasks: {},
  };
  const today = getLocalDateKey();

  forEachHydratedPersistedTaskInContext(context, {
    getExistingTask(): Task | undefined {
      return undefined;
    },
    visit(entry): void {
      const agentDefs = entry.agentEntries.map((agentEntry) => agentEntry.agentDef);
      tempState.tasks[entry.taskId] = withSavedAgentDefs(entry.task, agentDefs);
    },
  });

  syncProjectionTaskVisibility(tempState, context.raw);
  const mergeProgressProjection = decodeMergeProgressPersistenceProjection(context.raw);

  return {
    availableAgents: [...context.availableAgents],
    collapsedTaskOrder: [...tempState.collapsedTaskOrder],
    completedTaskCount: toNonNegativeInt(context.raw.completedTaskCount),
    completedTaskDate: getCompletedTaskDate(context.raw.completedTaskDate, today),
    customAgents: [...context.customAgents],
    hydraCommand: context.restoredHydraCommand,
    hydraForceDispatchFromPromptPanel:
      typeof context.raw.hydraForceDispatchFromPromptPanel === 'boolean'
        ? context.raw.hydraForceDispatchFromPromptPanel
        : true,
    hydraStartupMode: getHydraStartupMode(context.raw.hydraStartupMode),
    lastProjectId: context.lastProjectId,
    mergedLinesAdded: toNonNegativeInt(context.raw.mergedLinesAdded),
    mergedLinesRemoved: toNonNegativeInt(context.raw.mergedLinesRemoved),
    ...(mergeProgressProjection?.mergeOperation
      ? {
          committedMergeOperationId: mergeProgressProjection.committedMergeOperationId,
          mergeOperation: { ...mergeProgressProjection.mergeOperation },
        }
      : {}),
    mergeProgress: mergeProgressProjection ? { ...mergeProgressProjection.mergeProgress } : null,
    projects: [...context.projects],
    taskOrder: [...tempState.taskOrder],
    tasks: { ...tempState.tasks },
    terminals: {},
  };
}
