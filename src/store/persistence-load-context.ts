import type { AgentDef } from '../ipc/types';
import {
  createWorkspaceStateBaseAgents,
  getRestoredHydraCommand,
} from './persistence-agent-defaults';
import { isLegacyPersistedState, type LegacyPersistedState } from './persistence-legacy-state';
import { parseSharedProjects } from './persistence-projects';
import {
  forEachHydratedPersistedTask,
  type HydratedPersistedTaskEntry,
} from './persistence-task-hydration';
import type { Project, Task } from './types';

export interface PersistedLoadContext {
  availableAgents: AgentDef[];
  customAgents: AgentDef[];
  lastProjectId: string | null;
  projects: Project[];
  raw: LegacyPersistedState;
  restoredHydraCommand: string;
}

export function parsePersistedLoadContext(
  json: string,
  options: {
    currentAvailableAgents: ReadonlyArray<AgentDef>;
    currentCustomAgents: ReadonlyArray<AgentDef>;
    invalidMessage: string;
    parseErrorMessage: string;
  },
): PersistedLoadContext | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn(options.parseErrorMessage);
    return null;
  }

  if (!isLegacyPersistedState(raw)) {
    console.warn(options.invalidMessage);
    return null;
  }

  const restoredHydraCommand = getRestoredHydraCommand(raw);
  const { availableAgents, customAgents } = createWorkspaceStateBaseAgents(
    raw,
    restoredHydraCommand,
    options.currentAvailableAgents,
    options.currentCustomAgents,
  );
  const { lastProjectId, projects } = parseSharedProjects(raw);

  return {
    availableAgents,
    customAgents,
    lastProjectId,
    projects,
    raw,
    restoredHydraCommand,
  };
}

export function forEachHydratedPersistedTaskInContext(
  context: PersistedLoadContext,
  options: {
    getExistingTask: (taskId: string) => Task | undefined;
    visit: (entry: HydratedPersistedTaskEntry) => void;
  },
): void {
  forEachHydratedPersistedTask(context.raw, {
    availableAgents: context.availableAgents,
    getExistingTask: options.getExistingTask,
    hydraCommand: context.restoredHydraCommand,
    visit: options.visit,
  });
}
