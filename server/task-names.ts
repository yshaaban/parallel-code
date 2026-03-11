export interface TaskNameRegistry {
  deleteTaskName: (taskId: string) => void;
  getTaskName: (taskId: string) => string;
  setTaskName: (taskId: string, taskName: string) => void;
  syncFromSavedState: (json: string) => void;
}

function formatTaskId(taskId: string): string {
  return taskId.startsWith('task-') ? taskId.slice(5) : taskId;
}

export function createTaskNameRegistry(): TaskNameRegistry {
  const taskNames = new Map<string, string>();

  function syncFromSavedState(json: string): void {
    try {
      const state = JSON.parse(json) as {
        tasks?: Record<string, { id?: unknown; name?: unknown }>;
      };
      if (!state.tasks) return;

      const nextTaskNames = new Map<string, string>();
      for (const task of Object.values(state.tasks)) {
        if (typeof task.id === 'string' && typeof task.name === 'string') {
          nextTaskNames.set(task.id, task.name);
        }
      }

      taskNames.clear();
      for (const [taskId, taskName] of nextTaskNames) {
        taskNames.set(taskId, taskName);
      }
    } catch (error) {
      console.warn('Ignoring malformed saved state:', error);
    }
  }

  function getTaskName(taskId: string): string {
    return taskNames.get(taskId) ?? formatTaskId(taskId);
  }

  function setTaskName(taskId: string, taskName: string): void {
    taskNames.set(taskId, taskName);
  }

  function deleteTaskName(taskId: string): void {
    taskNames.delete(taskId);
  }

  return {
    deleteTaskName,
    getTaskName,
    setTaskName,
    syncFromSavedState,
  };
}
