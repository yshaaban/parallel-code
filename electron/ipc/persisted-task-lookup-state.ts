import type { PersistedProjectLookup, PersistedTaskLookup } from '../../src/store/types.js';

export interface ParsedPersistedTaskLookupState {
  projects: PersistedProjectLookup[];
  tasks: Record<string, PersistedTaskLookup>;
}

function createEmptyParsedPersistedTaskLookupState(): ParsedPersistedTaskLookupState {
  return {
    projects: [],
    tasks: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePersistedProjectLookup(value: unknown): PersistedProjectLookup | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.id === 'string' && typeof value.path === 'string') {
    return {
      id: value.id,
      path: value.path,
    };
  }

  return null;
}

function parsePersistedTaskLookup(taskId: string, value: unknown): PersistedTaskLookup | null {
  if (!isRecord(value)) {
    return null;
  }

  const task: PersistedTaskLookup = {};
  let hasKnownField = false;
  if (typeof value.branchName === 'string') {
    task.branchName = value.branchName;
    hasKnownField = true;
  }
  if (typeof value.id === 'string') {
    task.id = value.id;
    hasKnownField = true;
  }
  if (typeof value.name === 'string') {
    task.name = value.name;
    hasKnownField = true;
  }
  if (typeof value.projectId === 'string') {
    task.projectId = value.projectId;
    hasKnownField = true;
  }
  if (typeof value.worktreePath === 'string') {
    task.worktreePath = value.worktreePath;
    hasKnownField = true;
  }

  if (task.id === undefined && hasKnownField && taskId.length > 0) {
    task.id = taskId;
  }

  return Object.keys(task).length > 0 ? task : null;
}

function parsePersistedProjects(value: unknown): PersistedProjectLookup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((project) => parsePersistedProjectLookup(project))
    .filter((project): project is PersistedProjectLookup => project !== null);
}

function parsePersistedTasks(value: unknown): Record<string, PersistedTaskLookup> {
  if (!isRecord(value)) {
    return {};
  }

  const tasks: Record<string, PersistedTaskLookup> = {};
  for (const [taskId, taskValue] of Object.entries(value)) {
    const task = parsePersistedTaskLookup(taskId, taskValue);
    if (task) {
      tasks[taskId] = task;
    }
  }
  return tasks;
}

export function parsePersistedTaskLookupState(savedJson: string): ParsedPersistedTaskLookupState {
  try {
    const parsed: unknown = JSON.parse(savedJson);
    if (!isRecord(parsed)) {
      return createEmptyParsedPersistedTaskLookupState();
    }

    return {
      projects: parsePersistedProjects(parsed.projects),
      tasks: parsePersistedTasks(parsed.tasks),
    };
  } catch {
    return createEmptyParsedPersistedTaskLookupState();
  }
}
