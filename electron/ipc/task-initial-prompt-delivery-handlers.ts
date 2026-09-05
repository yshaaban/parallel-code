import {
  isGetTaskInitialPromptDeliveryProjectionRequest,
  isResolveManualInitialPromptSendAmbiguityRequest,
  isReviseTaskInitialPromptDraftRequest,
  isSendTaskInitialPromptManuallyRequest,
  isTaskInitialPromptDeliveryRequest,
  type QueueTaskInitialPromptDeliveryResult,
  type ResolveManualInitialPromptSendAmbiguityRequest,
  type ResolveManualInitialPromptSendAmbiguityResult,
  type ReviseTaskInitialPromptDraftRequest,
  type ReviseTaskInitialPromptDraftResult,
  type SendTaskInitialPromptManuallyRequest,
  type SendTaskInitialPromptManuallyResult,
  type TaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDeliveryRequest,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { TaskInitialPromptDeliveryService } from './task-initial-prompt-delivery.js';

export type TaskInitialPromptDeliveryAction =
  | 'observe'
  | 'queue'
  | 'manual-send'
  | 'edit'
  | 'resolve';

export interface TaskInitialPromptDeliveryHandlers {
  readonly registrationState: 'active' | 'unregistered';
  getProjection(deliveryId: string): Promise<TaskInitialPromptDeliveryProjection | null>;
  queue(request: TaskInitialPromptDeliveryRequest): Promise<QueueTaskInitialPromptDeliveryResult>;
  resolveManualAmbiguity(
    request: ResolveManualInitialPromptSendAmbiguityRequest,
  ): Promise<ResolveManualInitialPromptSendAmbiguityResult>;
  reviseDraft(
    request: ReviseTaskInitialPromptDraftRequest,
  ): Promise<ReviseTaskInitialPromptDraftResult>;
  sendManually(
    request: SendTaskInitialPromptManuallyRequest,
  ): Promise<SendTaskInitialPromptManuallyResult>;
}

export interface UnregisteredTaskInitialPromptDeliveryHandlers extends TaskInitialPromptDeliveryHandlers {
  readonly registrationState: 'unregistered';
}

export interface ActiveTaskInitialPromptDeliveryHandlers extends TaskInitialPromptDeliveryHandlers {
  readonly registrationState: 'active';
}

export interface TaskInitialPromptDeliveryHandlerDependencies {
  authorize(action: TaskInitialPromptDeliveryAction, taskId: string | null): boolean;
  service: TaskInitialPromptDeliveryService;
}

export class TaskInitialPromptAuthorizationError extends Error {
  readonly code = 'not-authorized';
}

export class TaskInitialPromptHandlerBadRequestError extends Error {
  readonly code = 'bad-request';
}

function requireRequest<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  label: string,
): asserts value is T {
  if (!guard(value)) throw new TaskInitialPromptHandlerBadRequestError(`${label} is invalid`);
}

function authorize(
  dependencies: TaskInitialPromptDeliveryHandlerDependencies,
  action: TaskInitialPromptDeliveryAction,
  taskId: string | null,
): void {
  if (!dependencies.authorize(action, taskId)) {
    throw new TaskInitialPromptAuthorizationError('Initial prompt action is not authorized');
  }
}

/**
 * These adapters intentionally have no IPC/WebSocket channel names and cannot
 * register themselves. Slice 5 may wrap them only after the durable cutover
 * assertion succeeds; direct dark calls still hit the service barrier.
 */
function createTaskInitialPromptDeliveryHandlers(
  dependencies: TaskInitialPromptDeliveryHandlerDependencies,
  registrationState: TaskInitialPromptDeliveryHandlers['registrationState'],
): TaskInitialPromptDeliveryHandlers {
  return {
    async getProjection(deliveryId) {
      requireRequest(
        { deliveryId },
        isGetTaskInitialPromptDeliveryProjectionRequest,
        'projection request',
      );
      authorize(dependencies, 'observe', null);
      return dependencies.service.getProjection(deliveryId);
    },
    async queue(request) {
      requireRequest(request, isTaskInitialPromptDeliveryRequest, 'queue request');
      authorize(dependencies, 'queue', request.taskId);
      return dependencies.service.queue(request);
    },
    registrationState,
    async resolveManualAmbiguity(request) {
      requireRequest(
        request,
        isResolveManualInitialPromptSendAmbiguityRequest,
        'ambiguity request',
      );
      authorize(dependencies, 'resolve', null);
      return dependencies.service.resolveManualAmbiguity(request);
    },
    async reviseDraft(request) {
      requireRequest(request, isReviseTaskInitialPromptDraftRequest, 'draft request');
      authorize(dependencies, 'edit', request.taskId);
      return dependencies.service.reviseDraft(request);
    },
    async sendManually(request) {
      requireRequest(request, isSendTaskInitialPromptManuallyRequest, 'manual send request');
      authorize(dependencies, 'manual-send', request.taskId);
      return dependencies.service.sendManually(request);
    },
  };
}

export function createUnregisteredTaskInitialPromptDeliveryHandlers(
  dependencies: TaskInitialPromptDeliveryHandlerDependencies,
): UnregisteredTaskInitialPromptDeliveryHandlers {
  return createTaskInitialPromptDeliveryHandlers(
    dependencies,
    'unregistered',
  ) as UnregisteredTaskInitialPromptDeliveryHandlers;
}

/** Created only after the durable removal/prompt cutover has been re-read. */
export function createActiveTaskInitialPromptDeliveryHandlers(
  dependencies: TaskInitialPromptDeliveryHandlerDependencies,
): ActiveTaskInitialPromptDeliveryHandlers {
  return createTaskInitialPromptDeliveryHandlers(
    dependencies,
    'active',
  ) as ActiveTaskInitialPromptDeliveryHandlers;
}
