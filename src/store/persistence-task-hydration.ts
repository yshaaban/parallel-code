import type { AgentDef } from '../ipc/types';
import { isNonEmptyString } from '../lib/type-guards';
import { hydratePersistedAgentDef, resolvePersistedAgentId } from './persistence-agent-defaults';
import type { LegacyPersistedState } from './persistence-legacy-state';
import type { PersistedTask, Task } from './types';

interface HydratedTaskBuildOptions {
  availableAgents: AgentDef[];
  existingTask: Task | undefined;
  hydraCommand: string;
  persistedTask: PersistedTask & { projectId?: string };
}

interface HydratedTaskBase {
  agentDef: AgentDef | null | undefined;
  primaryAgentId: string | null;
  shellAgentIds: string[];
  taskBase: Omit<Task, 'agentIds' | 'collapsed' | 'savedAgentDef' | 'shellAgentIds'>;
}

interface HydratedTaskBuildResult {
  agentDef: AgentDef | null | undefined;
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
  persistedTask: PersistedTask,
  existingTask: Task | undefined,
): string[] {
  let shellAgentIds = Array.isArray(persistedTask.shellAgentIds)
    ? persistedTask.shellAgentIds.filter((value): value is string => isNonEmptyString(value))
    : [];

  if (shellAgentIds.length === 0) {
    shellAgentIds = [...(existingTask?.shellAgentIds ?? [])];
  }
  if (shellAgentIds.length === 0) {
    for (let index = 0; index < persistedTask.shellCount; index += 1) {
      shellAgentIds.push(crypto.randomUUID());
    }
  }

  return shellAgentIds;
}

function buildHydratedTaskBase(options: HydratedTaskBuildOptions): HydratedTaskBase {
  const agentDef = options.persistedTask.agentDef;
  hydratePersistedAgentDef(agentDef, options.availableAgents, options.hydraCommand);

  const primaryAgentId = agentDef
    ? resolvePersistedAgentId(options.persistedTask.agentId ?? options.existingTask?.agentIds[0])
    : null;
  const shellAgentIds = createHydratedShellAgentIds(options.persistedTask, options.existingTask);

  return {
    agentDef,
    primaryAgentId,
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
      ...(options.persistedTask.directMode ? { directMode: true } : {}),
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
    },
  };
}

export function buildExpandedHydratedTask(
  options: HydratedTaskBuildOptions,
): HydratedTaskBuildResult {
  const hydratedTask = buildHydratedTaskBase(options);
  const agentIds =
    hydratedTask.agentDef && hydratedTask.primaryAgentId ? [hydratedTask.primaryAgentId] : [];

  return {
    agentDef: hydratedTask.agentDef,
    primaryAgentId: hydratedTask.primaryAgentId,
    shellAgentIds: hydratedTask.shellAgentIds,
    task: {
      ...hydratedTask.taskBase,
      agentIds,
      shellAgentIds: hydratedTask.shellAgentIds,
    },
  };
}

export function buildCollapsedHydratedTask(
  options: HydratedTaskBuildOptions,
): HydratedTaskBuildResult {
  const hydratedTask = buildHydratedTaskBase(options);

  return {
    agentDef: hydratedTask.agentDef,
    primaryAgentId: hydratedTask.primaryAgentId,
    shellAgentIds: hydratedTask.shellAgentIds,
    task: {
      ...hydratedTask.taskBase,
      agentIds: [],
      shellAgentIds: [],
      collapsed: true,
      ...(hydratedTask.agentDef ? { savedAgentDef: hydratedTask.agentDef } : {}),
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
    if (!persistedTask || (collapsed && !persistedTask.collapsed)) {
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
