import { IPC } from '../../electron/ipc/channels';
import type {
  ProjectContainerConfig,
  TaskContainerInspectResult,
  TaskContainerLogsResult,
  TaskContainerPreview,
} from '../domain/task-containers';
import { isElectronRuntime } from '../lib/browser-auth';
import { invoke } from '../lib/ipc';

export interface TaskContainerRequest {
  controllerId?: string;
  projectContainerConfig?: ProjectContainerConfig;
  projectPath: string;
  taskId: string;
  worktreePath: string;
}

export type TaskContainerMutationRequest = TaskContainerRequest & { controllerId: string };

function createTaskContainerInvokeRequest(
  request: TaskContainerMutationRequest,
): TaskContainerMutationRequest;
function createTaskContainerInvokeRequest(request: TaskContainerRequest): TaskContainerRequest;
function createTaskContainerInvokeRequest(request: TaskContainerRequest): TaskContainerRequest {
  return {
    ...(request.controllerId !== undefined ? { controllerId: request.controllerId } : {}),
    ...(request.projectContainerConfig !== undefined
      ? { projectContainerConfig: request.projectContainerConfig }
      : {}),
    projectPath: request.projectPath,
    taskId: request.taskId,
    worktreePath: request.worktreePath,
  };
}

export function buildTaskContainerPreviewUrl(
  taskId: string,
  preview: Pick<TaskContainerPreview, 'port' | 'protocol'>,
): string {
  if (isElectronRuntime()) {
    return `${preview.protocol}://127.0.0.1:${preview.port}/`;
  }

  const encodedTaskId = encodeURIComponent(taskId);
  return `${window.location.origin}/_container_preview/${encodedTaskId}/${preview.port}/`;
}

export async function inspectTaskContainerForTask(
  request: TaskContainerRequest,
): Promise<TaskContainerInspectResult> {
  return invoke(IPC.ContainersInspectTask, createTaskContainerInvokeRequest(request));
}

export async function startTaskContainersForTask(
  request: TaskContainerMutationRequest,
): Promise<TaskContainerInspectResult> {
  return invoke(IPC.ContainersStartTask, createTaskContainerInvokeRequest(request));
}

export async function stopTaskContainersForTask(
  request: TaskContainerMutationRequest,
): Promise<TaskContainerInspectResult> {
  return invoke(IPC.ContainersStopTask, createTaskContainerInvokeRequest(request));
}

export async function destroyTaskContainersForTask(
  request: TaskContainerMutationRequest,
): Promise<TaskContainerInspectResult> {
  return invoke(IPC.ContainersDestroyTask, createTaskContainerInvokeRequest(request));
}

export async function fetchTaskContainerLogsForTask(
  request: TaskContainerRequest,
  options?: { lines?: number },
): Promise<TaskContainerLogsResult> {
  return invoke(IPC.ContainersGetTaskLogs, {
    ...createTaskContainerInvokeRequest(request),
    ...(typeof options?.lines === 'number' ? { lines: options.lines } : {}),
  });
}
