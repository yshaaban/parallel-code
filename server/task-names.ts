import path from 'path';
import type { RemoteAgentTaskMeta } from '../src/domain/server-state.js';

export interface TaskNameRegistry {
  deleteTask: (taskId: string) => void;
  deleteTaskName: (taskId: string) => void;
  deleteTaskMetadata: (taskId: string) => void;
  getTaskName: (taskId: string) => string;
  getTaskMetadata: (taskId: string) => RemoteAgentTaskMeta | null;
  registerCreatedTask: (taskId: string, task: CreatedTaskRegistryEntry) => void;
  setTaskName: (taskId: string, taskName: string) => void;
  setTaskMetadata: (taskId: string, meta: RemoteAgentTaskMeta) => void;
  syncFromSavedState: (json: string) => void;
}

const LAST_PROMPT_LIMIT = 120;

interface SavedAgentDef {
  id?: unknown;
  name?: unknown;
}

function formatTaskId(taskId: string): string {
  return taskId.startsWith('task-') ? taskId.slice(5) : taskId;
}

function truncateLastPrompt(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= LAST_PROMPT_LIMIT) return trimmed;
  return `${trimmed.slice(0, LAST_PROMPT_LIMIT - 1)}…`;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

interface SavedStateTask {
  id?: unknown;
  name?: unknown;
  agentDef?: SavedAgentDef;
  branchName?: unknown;
  worktreePath?: unknown;
  directMode?: unknown;
  lastPrompt?: unknown;
  savedAgentDef?: SavedAgentDef;
}

export interface CreatedTaskRegistryEntry {
  agentDefId?: string | null;
  agentDefName?: string | null;
  branchName?: string | null;
  directMode?: boolean;
  taskName?: string | null;
  worktreePath?: string | null;
}

interface TaskMetadataSource {
  agentDefId?: string | null;
  agentDefName?: string | null;
  branchName?: string | null;
  directMode?: boolean;
  lastPrompt?: string | null;
  worktreePath?: string | null;
}

function buildTaskMetadata(source: TaskMetadataSource): RemoteAgentTaskMeta {
  return {
    agentDefId: source.agentDefId ?? null,
    agentDefName: source.agentDefName ?? null,
    branchName: source.branchName ?? null,
    directMode: source.directMode === true,
    folderName: source.worktreePath ? path.basename(source.worktreePath) : null,
    lastPrompt:
      typeof source.lastPrompt === 'string' ? truncateLastPrompt(source.lastPrompt) : null,
  };
}

function replaceMapEntries<T>(target: Map<string, T>, next: Map<string, T>): void {
  target.clear();

  for (const [key, value] of next) {
    target.set(key, value);
  }
}

function getSavedAgentDef(task: SavedStateTask): SavedAgentDef | undefined {
  return task.agentDef ?? task.savedAgentDef;
}

function parseTaskMetadata(task: SavedStateTask): RemoteAgentTaskMeta | null {
  if (typeof task.id !== 'string') return null;
  const persistedAgentDef = getSavedAgentDef(task);

  return buildTaskMetadata({
    agentDefId: readOptionalString(persistedAgentDef?.id),
    agentDefName: readOptionalString(persistedAgentDef?.name),
    branchName: readOptionalString(task.branchName),
    directMode: task.directMode === true,
    lastPrompt: readOptionalString(task.lastPrompt),
    worktreePath: readOptionalString(task.worktreePath),
  });
}

export function createTaskNameRegistry(): TaskNameRegistry {
  const taskNames = new Map<string, string>();
  const taskMetadata = new Map<string, RemoteAgentTaskMeta>();

  function syncFromSavedState(json: string): void {
    try {
      const state = JSON.parse(json) as {
        tasks?: Record<string, SavedStateTask>;
      };
      if (!state.tasks) return;

      const nextTaskNames = new Map<string, string>();
      const nextMetadata = new Map<string, RemoteAgentTaskMeta>();

      for (const task of Object.values(state.tasks)) {
        if (typeof task.id === 'string' && typeof task.name === 'string') {
          nextTaskNames.set(task.id, task.name);
        }

        const meta = parseTaskMetadata(task);
        if (meta && typeof task.id === 'string') {
          nextMetadata.set(task.id, meta);
        }
      }

      replaceMapEntries(taskNames, nextTaskNames);
      replaceMapEntries(taskMetadata, nextMetadata);
    } catch (error) {
      console.warn('Ignoring malformed saved state:', error);
    }
  }

  function getTaskName(taskId: string): string {
    return taskNames.get(taskId) ?? formatTaskId(taskId);
  }

  function getTaskMetadata(taskId: string): RemoteAgentTaskMeta | null {
    return taskMetadata.get(taskId) ?? null;
  }

  function setTaskName(taskId: string, taskName: string): void {
    taskNames.set(taskId, taskName);
  }

  function setTaskMetadata(taskId: string, meta: RemoteAgentTaskMeta): void {
    taskMetadata.set(taskId, meta);
  }

  function registerCreatedTask(taskId: string, task: CreatedTaskRegistryEntry): void {
    if (typeof task.taskName === 'string' && task.taskName.trim().length > 0) {
      taskNames.set(taskId, task.taskName);
    }

    taskMetadata.set(
      taskId,
      buildTaskMetadata({
        agentDefId: task.agentDefId ?? null,
        agentDefName: task.agentDefName ?? null,
        branchName: task.branchName ?? null,
        directMode: task.directMode === true,
        worktreePath: task.worktreePath ?? null,
      }),
    );
  }

  function deleteTaskName(taskId: string): void {
    taskNames.delete(taskId);
  }

  function deleteTaskMetadata(taskId: string): void {
    taskMetadata.delete(taskId);
  }

  function deleteTask(taskId: string): void {
    deleteTaskName(taskId);
    deleteTaskMetadata(taskId);
  }

  return {
    deleteTask,
    deleteTaskName,
    deleteTaskMetadata,
    getTaskName,
    getTaskMetadata,
    registerCreatedTask,
    setTaskName,
    setTaskMetadata,
    syncFromSavedState,
  };
}
