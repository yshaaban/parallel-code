import path from 'path';
import type { RemoteAgentTaskMeta } from '../src/domain/server-state.js';
import { parseSavedStateTasksRecord } from '../src/domain/saved-state-tasks.js';
import { isRecord } from '../src/lib/type-guards.js';

type RemoteWorktreeOwnership = NonNullable<RemoteAgentTaskMeta['worktreeOwnership']>;
type RemoteTaskGitIsolation = NonNullable<RemoteAgentTaskMeta['gitIsolation']>;
type RemoteTaskProjectMode = NonNullable<RemoteAgentTaskMeta['projectMode']>;

export interface TaskNameRegistry {
  deleteTask: (taskId: string) => void;
  deleteTaskName: (taskId: string) => void;
  deleteTaskMetadata: (taskId: string) => void;
  getTaskName: (taskId: string) => string;
  getTaskMetadata: (taskId: string, agentId?: string) => RemoteAgentTaskMeta | null;
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
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length <= LAST_PROMPT_LIMIT) {
    return trimmed;
  }

  return `${trimmed.slice(0, LAST_PROMPT_LIMIT - 1)}…`;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

interface SavedStateTask {
  agentDefs?: Array<SavedAgentDef | undefined>;
  agentIds?: Array<string | undefined>;
  id?: unknown;
  name?: unknown;
  agentDef?: SavedAgentDef;
  branchName?: unknown;
  gitIsolation?: unknown;
  worktreePath?: unknown;
  directMode?: unknown;
  lastPrompt?: unknown;
  projectMode?: unknown;
  savedAgentDef?: SavedAgentDef;
  worktreeOwnership?: unknown;
}

export interface CreatedTaskRegistryEntry {
  agentDefId?: string | null;
  agentDefName?: string | null;
  branchName?: string | null;
  directMode?: boolean;
  gitIsolation?: RemoteTaskGitIsolation | null;
  projectMode?: RemoteTaskProjectMode | null;
  taskName?: string | null;
  worktreePath?: string | null;
  worktreeOwnership?: RemoteWorktreeOwnership | null;
}

interface TaskMetadataSource {
  agentDefId?: string | null;
  agentDefName?: string | null;
  branchName?: string | null;
  directMode?: boolean;
  gitIsolation?: RemoteTaskGitIsolation | null;
  lastPrompt?: string | null;
  projectMode?: RemoteTaskProjectMode | null;
  worktreePath?: string | null;
  worktreeOwnership?: RemoteWorktreeOwnership | null;
}

function readWorktreeOwnership(value: unknown): RemoteWorktreeOwnership | null {
  return value === 'external' || value === 'managed' ? value : null;
}

function readGitIsolation(value: unknown): RemoteTaskGitIsolation | null {
  if (value === 'worktree' || value === 'current-branch' || value === 'existing-worktree') {
    return value;
  }

  return null;
}

function readProjectMode(value: unknown): RemoteTaskProjectMode | null {
  if (value === 'git' || value === 'non-git') {
    return value;
  }

  return null;
}

function buildTaskMetadata(source: TaskMetadataSource): RemoteAgentTaskMeta {
  const worktreeOwnership = readWorktreeOwnership(source.worktreeOwnership);
  const gitIsolation = readGitIsolation(source.gitIsolation);
  const projectMode = readProjectMode(source.projectMode);
  return {
    agentDefId: source.agentDefId ?? null,
    agentDefName: source.agentDefName ?? null,
    branchName: source.branchName ?? null,
    directMode: gitIsolation === 'current-branch' || source.directMode === true,
    folderName: source.worktreePath ? path.basename(source.worktreePath) : null,
    ...(gitIsolation !== null ? { gitIsolation } : {}),
    lastPrompt:
      typeof source.lastPrompt === 'string' ? truncateLastPrompt(source.lastPrompt) : null,
    ...(projectMode !== null ? { projectMode } : {}),
    ...(typeof source.worktreePath === 'string' ? { worktreePath: source.worktreePath } : {}),
    ...(worktreeOwnership !== null ? { worktreeOwnership } : {}),
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

function parseSavedAgentDef(value: unknown): SavedAgentDef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    id: value.id,
    name: value.name,
  };
}

function parseSavedAgentDefs(value: unknown): Array<SavedAgentDef | undefined> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const agentDefs = value.map((entry) => parseSavedAgentDef(entry));

  return agentDefs.some((entry) => entry !== undefined) ? agentDefs : undefined;
}

function parseSavedAgentIds(value: unknown): Array<string | undefined> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const agentIds = value.map((entry) => (typeof entry === 'string' ? entry : undefined));

  return agentIds.some((entry) => entry !== undefined) ? agentIds : undefined;
}

function parseSavedStateTask(value: unknown): SavedStateTask | null {
  if (!isRecord(value)) {
    return null;
  }

  const agentDef = parseSavedAgentDef(value.agentDef);
  const agentDefs = parseSavedAgentDefs(value.agentDefs);
  const agentIds = parseSavedAgentIds(value.agentIds);
  const savedAgentDef = parseSavedAgentDef(value.savedAgentDef);

  return {
    branchName: value.branchName,
    directMode: value.directMode,
    gitIsolation: value.gitIsolation,
    id: value.id,
    lastPrompt: value.lastPrompt,
    name: value.name,
    projectMode: value.projectMode,
    worktreeOwnership: value.worktreeOwnership,
    worktreePath: value.worktreePath,
    ...(agentDef ? { agentDef } : {}),
    ...(agentDefs ? { agentDefs } : {}),
    ...(agentIds ? { agentIds } : {}),
    ...(savedAgentDef ? { savedAgentDef } : {}),
  };
}

function parseSavedStateTasks(json: string): SavedStateTask[] | null {
  const state = parseSavedStateTasksRecord(json);
  if (state.kind === 'invalid' && state.reason === 'json') {
    throw new Error('Malformed saved state JSON');
  }
  if (state.kind !== 'valid') {
    return null;
  }

  const tasks: SavedStateTask[] = [];
  let malformedTaskCount = 0;
  for (const value of Object.values(state.tasks)) {
    const task = parseSavedStateTask(value);
    if (!task) {
      malformedTaskCount += 1;
      continue;
    }

    tasks.push(task);
  }

  return tasks.length > 0 || malformedTaskCount === 0 ? tasks : null;
}

function parseTaskMetadata(task: SavedStateTask): RemoteAgentTaskMeta | null {
  if (typeof task.id !== 'string') {
    return null;
  }

  const persistedAgentDef = getSavedAgentDef(task);

  return buildTaskMetadata({
    agentDefId: readOptionalString(persistedAgentDef?.id),
    agentDefName: readOptionalString(persistedAgentDef?.name),
    branchName: readOptionalString(task.branchName),
    directMode: task.directMode === true,
    gitIsolation: readGitIsolation(task.gitIsolation),
    lastPrompt: readOptionalString(task.lastPrompt),
    projectMode: readProjectMode(task.projectMode),
    worktreePath: readOptionalString(task.worktreePath),
    worktreeOwnership: readWorktreeOwnership(task.worktreeOwnership),
  });
}

interface AgentMetadataRecord {
  meta: RemoteAgentTaskMeta;
  taskId: string;
}

function parseTaskAgentMetadata(
  task: SavedStateTask,
  taskMeta: RemoteAgentTaskMeta,
): Map<string, AgentMetadataRecord> {
  const metadata = new Map<string, AgentMetadataRecord>();
  if (typeof task.id !== 'string' || !task.agentIds || !task.agentDefs) {
    return metadata;
  }

  for (const [index, agentId] of task.agentIds.entries()) {
    const agentDef = task.agentDefs[index];
    if (typeof agentId !== 'string' || !agentDef) {
      continue;
    }

    metadata.set(agentId, {
      meta: {
        ...taskMeta,
        agentDefId: readOptionalString(agentDef.id),
        agentDefName: readOptionalString(agentDef.name),
      },
      taskId: task.id,
    });
  }

  return metadata;
}

export function createTaskNameRegistry(): TaskNameRegistry {
  const taskNames = new Map<string, string>();
  const taskMetadata = new Map<string, RemoteAgentTaskMeta>();
  const agentMetadata = new Map<string, AgentMetadataRecord>();

  function syncFromSavedState(json: string): void {
    try {
      const tasks = parseSavedStateTasks(json);
      if (!tasks) {
        return;
      }

      const nextTaskNames = new Map<string, string>();
      const nextMetadata = new Map<string, RemoteAgentTaskMeta>();
      const nextAgentMetadata = new Map<string, AgentMetadataRecord>();

      for (const task of tasks) {
        if (typeof task.id === 'string' && typeof task.name === 'string') {
          nextTaskNames.set(task.id, task.name);
        }

        const meta = parseTaskMetadata(task);
        if (meta && typeof task.id === 'string') {
          nextMetadata.set(task.id, meta);
          for (const [agentId, agentMeta] of parseTaskAgentMetadata(task, meta)) {
            nextAgentMetadata.set(agentId, agentMeta);
          }
        }
      }

      replaceMapEntries(taskNames, nextTaskNames);
      replaceMapEntries(taskMetadata, nextMetadata);
      replaceMapEntries(agentMetadata, nextAgentMetadata);
    } catch (error) {
      console.warn('Ignoring malformed saved state:', error);
    }
  }

  function getTaskName(taskId: string): string {
    return taskNames.get(taskId) ?? formatTaskId(taskId);
  }

  function getTaskMetadata(taskId: string, agentId?: string): RemoteAgentTaskMeta | null {
    if (agentId !== undefined) {
      const agentMeta = agentMetadata.get(agentId);
      if (agentMeta?.taskId === taskId) {
        return agentMeta.meta;
      }
    }

    return taskMetadata.get(taskId) ?? null;
  }

  function setTaskName(taskId: string, taskName: string): void {
    taskNames.set(taskId, taskName);
  }

  function deleteTaskAgentMetadata(taskId: string): void {
    for (const [agentId, record] of agentMetadata) {
      if (record.taskId === taskId) {
        agentMetadata.delete(agentId);
      }
    }
  }

  function setTaskMetadata(taskId: string, meta: RemoteAgentTaskMeta): void {
    deleteTaskAgentMetadata(taskId);
    taskMetadata.set(taskId, meta);
  }

  function registerCreatedTask(taskId: string, task: CreatedTaskRegistryEntry): void {
    if (typeof task.taskName === 'string' && task.taskName.trim().length > 0) {
      taskNames.set(taskId, task.taskName);
    }

    setTaskMetadata(
      taskId,
      buildTaskMetadata({
        agentDefId: task.agentDefId ?? null,
        agentDefName: task.agentDefName ?? null,
        branchName: task.branchName ?? null,
        directMode: task.directMode === true,
        gitIsolation: task.gitIsolation ?? null,
        projectMode: task.projectMode ?? null,
        worktreePath: task.worktreePath ?? null,
        worktreeOwnership: task.worktreeOwnership ?? null,
      }),
    );
  }

  function deleteTaskName(taskId: string): void {
    taskNames.delete(taskId);
  }

  function deleteTaskMetadata(taskId: string): void {
    taskMetadata.delete(taskId);
    deleteTaskAgentMetadata(taskId);
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
