import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import type { IpcHandlerMap } from './handlers.js';
import type { HandlerContext } from './handler-context.js';
import { validatePath, validateRelativePath } from './path-utils.js';
import { defineIpcHandler } from './typed-handler.js';
import {
  assertOptionalInt,
  assertOptionalString,
  assertString,
  assertTcpPortNumber,
} from './validate.js';
import {
  destroyTaskContainers,
  getTaskContainerLogs,
  inspectTaskContainers,
  startTaskContainers,
  stopTaskContainers,
} from './task-containers.js';
import { isTaskCommandLeaseHeld } from './task-command-leases.js';
import type {
  ProjectContainerConfig,
  ProjectContainerRunnerProfileConfig,
} from '../../src/domain/task-containers.js';
import { isTaskPortProtocol } from '../../src/domain/server-state.js';
import { isRecord } from '../../src/lib/type-guards.js';

function normalizeRunnerProfile(value: unknown): ProjectContainerRunnerProfileConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new BadRequestError('projectContainerConfig.runnerProfile must be an object');
  }

  if (value.kind !== 'compose' && value.kind !== 'docker') {
    throw new BadRequestError(
      'projectContainerConfig.runnerProfile.kind must be "compose" or "docker"',
    );
  }

  assertOptionalString(value.image, 'projectContainerConfig.runnerProfile.image');
  assertOptionalString(value.dockerfile, 'projectContainerConfig.runnerProfile.dockerfile');
  if (value.dockerfile !== undefined) {
    validateRelativePath(value.dockerfile, 'projectContainerConfig.runnerProfile.dockerfile');
  }

  return {
    ...(value.dockerfile !== undefined ? { dockerfile: value.dockerfile } : {}),
    ...(value.image !== undefined ? { image: value.image } : {}),
    kind: value.kind,
  };
}

function normalizeProjectContainerConfig(value: unknown): ProjectContainerConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new BadRequestError('projectContainerConfig must be an object');
  }

  const composeFile = value.composeFile;
  assertOptionalString(composeFile, 'projectContainerConfig.composeFile');
  if (composeFile !== undefined) {
    validateRelativePath(composeFile, 'projectContainerConfig.composeFile');
  }

  const requiredEnvFilesValue = value.requiredEnvFiles;
  if (requiredEnvFilesValue !== undefined && !Array.isArray(requiredEnvFilesValue)) {
    throw new BadRequestError('projectContainerConfig.requiredEnvFiles must be an array');
  }
  const requiredEnvFiles =
    requiredEnvFilesValue?.map((entry, index) => {
      assertString(entry, `projectContainerConfig.requiredEnvFiles[${index}]`);
      return entry;
    }) ?? undefined;

  const previewPortsValue = value.previewPorts;
  if (previewPortsValue !== undefined && !Array.isArray(previewPortsValue)) {
    throw new BadRequestError('projectContainerConfig.previewPorts must be an array');
  }
  const previewPorts =
    previewPortsValue?.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new BadRequestError(
          `projectContainerConfig.previewPorts[${index}] must be an object`,
        );
      }

      assertTcpPortNumber(entry.port, `projectContainerConfig.previewPorts[${index}].port`);
      assertOptionalString(entry.label, `projectContainerConfig.previewPorts[${index}].label`);
      const protocol = entry.protocol;
      if (protocol !== undefined && !isTaskPortProtocol(protocol)) {
        throw new BadRequestError(
          `projectContainerConfig.previewPorts[${index}].protocol must be "http", "https", or undefined`,
        );
      }

      return {
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        port: entry.port,
        ...(protocol !== undefined ? { protocol } : {}),
      };
    }) ?? undefined;
  const runnerProfile = normalizeRunnerProfile(value.runnerProfile);

  return {
    ...(composeFile !== undefined ? { composeFile } : {}),
    ...(previewPorts !== undefined ? { previewPorts } : {}),
    ...(requiredEnvFiles !== undefined ? { requiredEnvFiles } : {}),
    ...(runnerProfile !== undefined ? { runnerProfile } : {}),
  };
}

function createTaskContainerRequest(
  request: {
    projectContainerConfig?: unknown;
    projectPath: string;
    taskId: string;
    worktreePath: string;
  },
  context: HandlerContext,
): {
  projectContainerConfig?: ProjectContainerConfig;
  projectPath: string;
  taskId: string;
  userDataPath: string;
  worktreePath: string;
} {
  assertString(request.taskId, 'taskId');
  assertString(request.projectPath, 'projectPath');
  assertString(request.worktreePath, 'worktreePath');
  validatePath(request.projectPath, 'projectPath');
  validatePath(request.worktreePath, 'worktreePath');
  const projectContainerConfig = normalizeProjectContainerConfig(request.projectContainerConfig);

  return {
    ...(projectContainerConfig !== undefined ? { projectContainerConfig } : {}),
    projectPath: request.projectPath,
    taskId: request.taskId,
    userDataPath: context.userDataPath,
    worktreePath: request.worktreePath,
  };
}

function assertTaskContainerMutationLease(request: { controllerId: string; taskId: string }): void {
  assertString(request.taskId, 'taskId');
  assertString(request.controllerId, 'controllerId');
  if (!isTaskCommandLeaseHeld(request.taskId, request.controllerId)) {
    throw new BadRequestError('Task is controlled by another client');
  }
}

export function createTaskContainerIpcHandlers(context: HandlerContext): IpcHandlerMap {
  return {
    [IPC.ContainersInspectTask]: defineIpcHandler(IPC.ContainersInspectTask, (request) => {
      return inspectTaskContainers(createTaskContainerRequest(request, context));
    }),
    [IPC.ContainersStartTask]: defineIpcHandler(IPC.ContainersStartTask, (request) => {
      assertTaskContainerMutationLease(request);
      return startTaskContainers(createTaskContainerRequest(request, context));
    }),
    [IPC.ContainersStopTask]: defineIpcHandler(IPC.ContainersStopTask, (request) => {
      assertTaskContainerMutationLease(request);
      return stopTaskContainers(createTaskContainerRequest(request, context));
    }),
    [IPC.ContainersDestroyTask]: defineIpcHandler(IPC.ContainersDestroyTask, (request) => {
      assertTaskContainerMutationLease(request);
      return destroyTaskContainers(createTaskContainerRequest(request, context));
    }),
    [IPC.ContainersGetTaskLogs]: defineIpcHandler(IPC.ContainersGetTaskLogs, (request) => {
      assertOptionalInt(request.lines, 'lines');
      return getTaskContainerLogs({
        ...createTaskContainerRequest(request, context),
        ...(typeof request.lines === 'number' ? { lines: request.lines } : {}),
      });
    }),
  };
}
