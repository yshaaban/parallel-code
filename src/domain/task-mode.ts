export const TASK_MODES = ['agent', 'terminal'] as const;

export type TaskMode = (typeof TASK_MODES)[number];

export function isTaskMode(value: unknown): value is TaskMode {
  return value === 'agent' || value === 'terminal';
}

export function normalizeTaskMode(value: unknown): TaskMode {
  return isTaskMode(value) ? value : 'agent';
}

export function isTerminalTask(task: { taskMode: TaskMode }): boolean {
  return task.taskMode === 'terminal';
}
