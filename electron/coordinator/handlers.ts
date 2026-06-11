import { IPC } from '../ipc/channels.js';
import type { HandlerContext, IpcHandler } from '../ipc/handler-context.js';
import { BadRequestError } from '../ipc/errors.js';
import { defineIpcHandler } from '../ipc/typed-handler.js';
import { assertBoolean, assertOptionalNonNegativeInt, assertString } from '../ipc/validate.js';
import type { TaskNameRegistry } from '../../server/task-names.js';
import {
  isCoordinatorOperatorActionName,
  isCoordinatorToolName,
  type CoordinatorOperatorActionName,
  type CoordinatorToolName,
} from '../../src/domain/coordinator.js';
import { isNonNegativeInteger } from '../../src/lib/type-guards.js';
import type { ProjectMode } from '../../src/store/types.js';
import {
  applyCoordinatorActivityHint,
  createCoordinatorRunForTask,
  ensureCoordinatorServiceLoaded,
  getCoordinatorPersistenceHealth,
} from './service.js';
import { getCoordinatorDiagnostics } from './runtime.js';
import { executeCoordinatorRendererAction, executeCoordinatorToolCall } from './tool-gateway.js';

const COORDINATOR_UI_CREDENTIAL_FIELDS = ['credentialPath', 'token', 'toolToken'] as const;

function assertProjectMode(value: unknown): asserts value is ProjectMode {
  if (value !== 'git' && value !== 'non-git') {
    throw new BadRequestError('projectMode must be git or non-git');
  }
}

function assertNonNegativeInt(value: unknown, label: string): asserts value is number {
  if (!isNonNegativeInteger(value)) {
    throw new BadRequestError(`${label} must be a non-negative integer`);
  }
}

function assertActivityHintKind(
  value: unknown,
): asserts value is
  | 'manual-prompt-sent'
  | 'prompt-draft'
  | 'terminal-focus'
  | 'terminal-pending-input'
  | 'terminal-printable-input' {
  if (
    value !== 'manual-prompt-sent' &&
    value !== 'prompt-draft' &&
    value !== 'terminal-focus' &&
    value !== 'terminal-pending-input' &&
    value !== 'terminal-printable-input'
  ) {
    throw new BadRequestError('kind must be a coordinator activity hint kind');
  }
}

function assertCoordinatorToolName(value: unknown): asserts value is CoordinatorToolName {
  if (!isCoordinatorToolName(value)) {
    throw new BadRequestError('toolName must be a coordinator tool name');
  }
}

function assertCoordinatorUiActionName(
  value: unknown,
): asserts value is CoordinatorToolName | CoordinatorOperatorActionName {
  if (!isCoordinatorToolName(value) && !isCoordinatorOperatorActionName(value)) {
    throw new BadRequestError('toolName must be a coordinator tool or operator action name');
  }
}

function assertNoCoordinatorUiCredentials(request: object): void {
  for (const field of COORDINATOR_UI_CREDENTIAL_FIELDS) {
    if (Reflect.get(request, field) !== undefined) {
      throw new BadRequestError('Coordinator UI action must not include tool credentials');
    }
  }
}

function ensureCoordinatorRuntime(context: HandlerContext): void {
  ensureCoordinatorServiceLoaded(context);
}

export function createCoordinatorIpcHandlers(
  context: HandlerContext,
  taskNames: Pick<TaskNameRegistry, 'deleteTask' | 'registerCreatedTask'>,
): Partial<Record<IPC, IpcHandler>> {
  ensureCoordinatorRuntime(context);

  return {
    [IPC.CoordinatorActivityHint]: defineIpcHandler<IPC.CoordinatorActivityHint>(
      IPC.CoordinatorActivityHint,
      (request) => {
        assertNonNegativeInt(request.agentGeneration, 'agentGeneration');
        assertBoolean(request.blocked, 'blocked');
        assertString(request.clientId, 'clientId');
        assertActivityHintKind(request.kind);
        assertNonNegativeInt(request.seq, 'seq');
        assertString(request.taskId, 'taskId');
        assertOptionalNonNegativeInt(request.ttlMs, 'ttlMs');

        applyCoordinatorActivityHint(request);
        return undefined;
      },
    ),

    [IPC.CoordinatorCreateRun]: defineIpcHandler<IPC.CoordinatorCreateRun>(
      IPC.CoordinatorCreateRun,
      (request) => {
        assertString(request.coordinatorAgentId, 'coordinatorAgentId');
        assertString(request.coordinatorTaskId, 'coordinatorTaskId');
        assertString(request.projectId, 'projectId');
        assertProjectMode(request.projectMode);
        assertString(request.projectRoot, 'projectRoot');

        return createCoordinatorRunForTask(context, request);
      },
    ),

    [IPC.CoordinatorGetDiagnostics]: () => {
      const persistence = getCoordinatorPersistenceHealth();
      return {
        ...getCoordinatorDiagnostics(),
        ...(persistence !== null ? { persistence } : {}),
      };
    },

    [IPC.CoordinatorToolCall]: defineIpcHandler<IPC.CoordinatorToolCall>(
      IPC.CoordinatorToolCall,
      (request) => {
        assertString(request.callId, 'callId');
        assertString(request.runId, 'runId');
        assertString(request.taskId, 'taskId');
        assertString(request.token, 'token');
        assertCoordinatorToolName(request.toolName);

        return executeCoordinatorToolCall({ context, taskNames }, request);
      },
    ),

    [IPC.CoordinatorUiToolCall]: defineIpcHandler<IPC.CoordinatorUiToolCall>(
      IPC.CoordinatorUiToolCall,
      (request) => {
        assertNoCoordinatorUiCredentials(request);
        assertString(request.requestId, 'requestId');
        assertString(request.coordinatorTaskId, 'coordinatorTaskId');
        assertString(request.runId, 'runId');
        assertCoordinatorUiActionName(request.toolName);

        return executeCoordinatorRendererAction({ context, taskNames }, request);
      },
    ),
  };
}
