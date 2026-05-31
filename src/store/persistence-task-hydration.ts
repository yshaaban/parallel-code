import type { AgentDef } from '../ipc/types.js';
import { createRandomId } from '../lib/random-id.js';
import { isNonEmptyString } from '../lib/type-guards.js';
import { hydratePersistedAgentDef, resolvePersistedAgentId } from './persistence-agent-defaults.js';
import { buildTaskProjectModeFields, getProjectMode } from './project-mode.js';
import {
  isPersistedTask,
  type HydratablePersistedTask,
  type LegacyPersistedState,
} from './persistence-legacy-state.js';
import { buildTaskGitIsolationFields, normalizeTaskBaseBranch } from './task-git-isolation.js';
import { getSelectedTaskAgentId } from './task-agent-selection.js';
import type { Task } from './types.js';

interface HydratedTaskBuildOptions {
  availableAgents: AgentDef[];
  existingTask: Task | undefined;
  hydraCommand: string;
  persistedTask: HydratablePersistedTask;
}

interface HydratedTaskBase {
  agentDefs: AgentDef[];
  agentIds: string[];
  savedSelectedAgentIndex: number | undefined;
  selectedAgentId: string | undefined;
  shellAgentIds: string[];
  taskBase: Omit<
    Task,
    | 'agentIds'
    | 'collapsed'
    | 'savedAgentDef'
    | 'savedAgentDefs'
    | 'savedSelectedAgentIndex'
    | 'shellAgentIds'
  >;
}

interface HydratedTaskBuildResult {
  agentDef: AgentDef | null | undefined;
  agentEntries: { agentDef: AgentDef; agentId: string }[];
  primaryAgentId: string | null;
  shellAgentIds: string[];
  task: Task;
}

export interface HydratedPersistedTaskEntry extends HydratedTaskBuildResult {
  collapsed: boolean;
  taskId: string;
}

function getPersistedCollapsedTaskOrder(raw: LegacyPersistedState): string[] {
  return raw.collapsedTaskOrder ?? [];
}

function createHydratedShellAgentIds(
  persistedTask: HydratablePersistedTask,
  existingTask: Task | undefined,
): string[] {
  let shellAgentIds = Array.isArray(persistedTask.shellAgentIds)
    ? persistedTask.shellAgentIds.filter((value): value is string => isNonEmptyString(value))
    : [];

  if (shellAgentIds.length === 0) {
    shellAgentIds = [...(existingTask?.shellAgentIds ?? [])];
  }
  if (shellAgentIds.length === 0) {
    for (let index = 0; index < (persistedTask.shellCount ?? 0); index += 1) {
      shellAgentIds.push(createRandomId());
    }
  }

  return shellAgentIds;
}

function getHydratedAgentDefs(
  persistedTask: HydratablePersistedTask,
  availableAgents: AgentDef[],
  hydraCommand: string,
): AgentDef[] {
  let agentDefs: AgentDef[] = [];
  if (Array.isArray(persistedTask.agentDefs) && persistedTask.agentDefs.length > 0) {
    agentDefs = [...persistedTask.agentDefs];
  } else if (persistedTask.agentDef) {
    agentDefs = [persistedTask.agentDef];
  }

  for (const agentDef of agentDefs) {
    hydratePersistedAgentDef(agentDef, availableAgents, hydraCommand);
  }

  return agentDefs;
}

function createHydratedAgentIds(
  persistedTask: HydratablePersistedTask,
  existingTask: Task | undefined,
  agentCount: number,
): string[] {
  const persistedAgentIds = Array.isArray(persistedTask.agentIds) ? persistedTask.agentIds : [];
  let candidateAgentIds: string[] = [];
  if (persistedAgentIds.length > 0) {
    candidateAgentIds = persistedAgentIds;
  } else if (persistedTask.agentId) {
    candidateAgentIds = [persistedTask.agentId];
  }
  const usedAgentIds = new Set<string>();

  return Array.from({ length: agentCount }, (_, index) => {
    for (const candidate of [candidateAgentIds[index], existingTask?.agentIds[index]]) {
      if (isNonEmptyString(candidate) && !usedAgentIds.has(candidate)) {
        const agentId = resolvePersistedAgentId(candidate);
        usedAgentIds.add(agentId);
        return agentId;
      }
    }

    const agentId = createRandomId();
    usedAgentIds.add(agentId);
    return agentId;
  });
}

function createAgentSelectionCandidate(
  agentIds: string[],
  persistedTask: HydratablePersistedTask,
  existingTask: Task | undefined,
): Pick<Task, 'agentIds' | 'selectedAgentId'> {
  const selectedAgentId = persistedTask.selectedAgentId ?? existingTask?.selectedAgentId;
  if (selectedAgentId === undefined) {
    return { agentIds };
  }

  return { agentIds, selectedAgentId };
}

function getHydratedSavedSelectedAgentIndex(
  persistedTask: HydratablePersistedTask,
  agentCount: number,
): number | undefined {
  const savedSelectedAgentIndex = persistedTask.savedSelectedAgentIndex;

  if (savedSelectedAgentIndex === undefined || savedSelectedAgentIndex >= agentCount) {
    return undefined;
  }

  return savedSelectedAgentIndex;
}

function buildHydratedTaskBase(options: HydratedTaskBuildOptions): HydratedTaskBase {
  const agentDefs = getHydratedAgentDefs(
    options.persistedTask,
    options.availableAgents,
    options.hydraCommand,
  );
  const agentIds = createHydratedAgentIds(
    options.persistedTask,
    options.existingTask,
    agentDefs.length,
  );
  const shellAgentIds = createHydratedShellAgentIds(options.persistedTask, options.existingTask);
  const taskProjectMode = getProjectMode(options.persistedTask);
  const baseBranch =
    taskProjectMode === 'git' ? normalizeTaskBaseBranch(options.persistedTask) : undefined;
  const selectedAgentId =
    getSelectedTaskAgentId(
      createAgentSelectionCandidate(agentIds, options.persistedTask, options.existingTask),
      undefined,
    ) ?? undefined;

  return {
    agentDefs,
    agentIds,
    savedSelectedAgentIndex: getHydratedSavedSelectedAgentIndex(
      options.persistedTask,
      agentDefs.length,
    ),
    selectedAgentId,
    shellAgentIds,
    taskBase: {
      id: options.persistedTask.id,
      name: options.persistedTask.name,
      projectId: options.persistedTask.projectId ?? '',
      branchName: options.persistedTask.branchName,
      worktreePath: options.persistedTask.worktreePath,
      notes: options.persistedTask.notes,
      lastPrompt: options.persistedTask.lastPrompt,
      skipPermissions: options.persistedTask.skipPermissions === true,
      ...buildTaskProjectModeFields(options.persistedTask),
      ...(taskProjectMode === 'git' ? buildTaskGitIsolationFields(options.persistedTask) : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(options.persistedTask.githubUrl !== undefined
        ? { githubUrl: options.persistedTask.githubUrl }
        : {}),
      ...(options.persistedTask.savedInitialPrompt !== undefined
        ? { savedInitialPrompt: options.persistedTask.savedInitialPrompt }
        : {}),
      ...(options.persistedTask.planFileName !== undefined
        ? { planFileName: options.persistedTask.planFileName }
        : {}),
      ...(options.persistedTask.planRelativePath !== undefined
        ? { planRelativePath: options.persistedTask.planRelativePath }
        : {}),
      ...(options.persistedTask.stepsTracking !== undefined
        ? { stepsTracking: options.persistedTask.stepsTracking }
        : {}),
      ...(options.persistedTask.terminalLayoutMode !== undefined
        ? { terminalLayoutMode: options.persistedTask.terminalLayoutMode }
        : {}),
    },
  };
}

export function buildExpandedHydratedTask(
  options: HydratedTaskBuildOptions,
): HydratedTaskBuildResult {
  const hydratedTask = buildHydratedTaskBase(options);
  const agentEntries = hydratedTask.agentIds.flatMap((agentId, index) => {
    const agentDef = hydratedTask.agentDefs[index];
    return agentDef ? [{ agentDef, agentId }] : [];
  });

  return {
    agentDef: hydratedTask.agentDefs[0] ?? null,
    agentEntries,
    primaryAgentId: hydratedTask.agentIds[0] ?? null,
    shellAgentIds: hydratedTask.shellAgentIds,
    task: {
      ...hydratedTask.taskBase,
      agentIds: hydratedTask.agentIds,
      ...(hydratedTask.selectedAgentId ? { selectedAgentId: hydratedTask.selectedAgentId } : {}),
      shellAgentIds: hydratedTask.shellAgentIds,
    },
  };
}

export function buildCollapsedHydratedTask(
  options: HydratedTaskBuildOptions,
): HydratedTaskBuildResult {
  const hydratedTask = buildHydratedTaskBase(options);

  return {
    agentDef: hydratedTask.agentDefs[0] ?? null,
    agentEntries: [],
    primaryAgentId: hydratedTask.agentIds[0] ?? null,
    shellAgentIds: hydratedTask.shellAgentIds,
    task: {
      ...hydratedTask.taskBase,
      agentIds: [],
      shellAgentIds: [],
      collapsed: true,
      ...(hydratedTask.agentDefs[0] ? { savedAgentDef: hydratedTask.agentDefs[0] } : {}),
      ...(hydratedTask.agentDefs.length > 1 ? { savedAgentDefs: hydratedTask.agentDefs } : {}),
      ...(hydratedTask.savedSelectedAgentIndex !== undefined
        ? { savedSelectedAgentIndex: hydratedTask.savedSelectedAgentIndex }
        : {}),
    },
  };
}

export function forEachHydratedPersistedTask(
  raw: LegacyPersistedState,
  options: {
    availableAgents: AgentDef[];
    hydraCommand: string;
    getExistingTask: (taskId: string) => Task | undefined;
    visit: (entry: HydratedPersistedTaskEntry) => void;
  },
): void {
  function visitTask(taskId: string, collapsed: boolean): void {
    const persistedTask = raw.tasks[taskId];
    if (!isPersistedTask(persistedTask) || (collapsed && !persistedTask.collapsed)) {
      return;
    }

    const hydratedTask = collapsed
      ? buildCollapsedHydratedTask({
          availableAgents: options.availableAgents,
          existingTask: options.getExistingTask(taskId),
          hydraCommand: options.hydraCommand,
          persistedTask,
        })
      : buildExpandedHydratedTask({
          availableAgents: options.availableAgents,
          existingTask: options.getExistingTask(taskId),
          hydraCommand: options.hydraCommand,
          persistedTask,
        });

    options.visit({
      ...hydratedTask,
      collapsed,
      taskId,
    });
  }

  for (const taskId of raw.taskOrder) {
    visitTask(taskId, false);
  }

  for (const taskId of getPersistedCollapsedTaskOrder(raw)) {
    visitTask(taskId, true);
  }
}
