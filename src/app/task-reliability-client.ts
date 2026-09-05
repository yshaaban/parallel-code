import {
  isAgentSessionOperationProjection,
  isAgentSessionOperationResult,
  isGetAgentSessionOperationProjectionRequest,
  isRendererAgentSessionOperationRequest,
  type AgentSessionOperationProjection,
  type AgentSessionOperationResult,
  type GetAgentSessionOperationProjectionRequest,
  type RendererAgentSessionOperationRequest,
} from '../domain/agent-session-operation.js';
import {
  isGetTaskInitialPromptDeliveryProjectionRequest,
  isResolveManualInitialPromptSendAmbiguityRequest,
  isResolveManualInitialPromptSendAmbiguityResult,
  isReviseTaskInitialPromptDraftRequest,
  isReviseTaskInitialPromptDraftResult,
  isSendTaskInitialPromptManuallyRequest,
  isSendTaskInitialPromptManuallyResult,
  isTaskInitialPromptDeliveryProjection,
  type GetTaskInitialPromptDeliveryProjectionRequest,
  type ResolveManualInitialPromptSendAmbiguityRequest,
  type ResolveManualInitialPromptSendAmbiguityResult,
  type ReviseTaskInitialPromptDraftRequest,
  type ReviseTaskInitialPromptDraftResult,
  type SendTaskInitialPromptManuallyRequest,
  type SendTaskInitialPromptManuallyResult,
  type TaskInitialPromptDeliveryProjection,
} from '../domain/task-initial-prompt-delivery.js';
import {
  DARK_TASK_RELIABILITY_RUNTIME_CAPABILITIES,
  eventMatchesTaskReliabilityCapabilities,
  isActiveTaskReliabilityRuntimeCapabilities,
  isTaskReliabilityRuntimeEvent,
  type ActiveTaskReliabilityRuntimeCapabilities,
  type TaskReliabilityRuntimeCapabilities,
  type TaskReliabilityRuntimeEvent,
} from '../domain/task-reliability-runtime.js';

export interface TaskReliabilityRawTransport {
  agentSessions: {
    execute(request: RendererAgentSessionOperationRequest, signal?: AbortSignal): Promise<unknown>;
    getProjection(
      request: GetAgentSessionOperationProjectionRequest,
      signal?: AbortSignal,
    ): Promise<unknown>;
  };
  capabilities: {
    /** Returns an active bundle or null. Dark runtimes expose no bundle. */
    read(signal?: AbortSignal): Promise<unknown>;
  };
  initialPromptDelivery: {
    getProjection(
      request: GetTaskInitialPromptDeliveryProjectionRequest,
      signal?: AbortSignal,
    ): Promise<unknown>;
    resolveAmbiguity(
      request: ResolveManualInitialPromptSendAmbiguityRequest,
      signal?: AbortSignal,
    ): Promise<unknown>;
    reviseDraft(
      request: ReviseTaskInitialPromptDraftRequest,
      signal?: AbortSignal,
    ): Promise<unknown>;
    sendManually(
      request: SendTaskInitialPromptManuallyRequest,
      signal?: AbortSignal,
    ): Promise<unknown>;
  };
  liveEvents: {
    subscribe(listener: (event: unknown) => void): () => void;
  };
}

export interface TaskReliabilityClient {
  agentSessions: {
    execute(
      request: RendererAgentSessionOperationRequest,
      signal?: AbortSignal,
    ): Promise<AgentSessionOperationResult>;
    getProjection(
      request: GetAgentSessionOperationProjectionRequest,
      signal?: AbortSignal,
    ): Promise<AgentSessionOperationProjection | null>;
  };
  dispose(): void;
  getCapabilities(): TaskReliabilityRuntimeCapabilities;
  initialPromptDelivery: {
    getProjection(
      request: GetTaskInitialPromptDeliveryProjectionRequest,
      signal?: AbortSignal,
    ): Promise<TaskInitialPromptDeliveryProjection | null>;
    resolveAmbiguity(
      request: ResolveManualInitialPromptSendAmbiguityRequest,
      signal?: AbortSignal,
    ): Promise<ResolveManualInitialPromptSendAmbiguityResult>;
    reviseDraft(
      request: ReviseTaskInitialPromptDraftRequest,
      signal?: AbortSignal,
    ): Promise<ReviseTaskInitialPromptDraftResult>;
    sendManually(
      request: SendTaskInitialPromptManuallyRequest,
      signal?: AbortSignal,
    ): Promise<SendTaskInitialPromptManuallyResult>;
  };
  refreshCapabilities(signal?: AbortSignal): Promise<TaskReliabilityRuntimeCapabilities>;
  subscribe(listener: (event: TaskReliabilityRuntimeEvent) => void): () => void;
}

export interface CreateTaskReliabilityClientOptions {
  onProtocolError?(error: Error): void;
}

export class TaskReliabilityCapabilityError extends Error {
  constructor(feature: 'agent-sessions' | 'initial-prompt-delivery') {
    super(`${feature} capability is not active`);
    this.name = 'TaskReliabilityCapabilityError';
  }
}

function cloneActiveCapabilities(
  value: ActiveTaskReliabilityRuntimeCapabilities,
): ActiveTaskReliabilityRuntimeCapabilities {
  return Object.freeze({
    agentSessions: Object.freeze({ ...value.agentSessions }),
    contractVersion: value.contractVersion,
    cutoverEpoch: value.cutoverEpoch,
    initialPromptDelivery: Object.freeze({ ...value.initialPromptDelivery }),
    kind: 'active',
    serverInstanceId: value.serverInstanceId,
  });
}

function invalidResponse(label: string): Error {
  return new Error(`Invalid ${label} response`);
}

function isCallerAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError')
  );
}

function requireResponse<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  label: string,
): T {
  if (!guard(value)) throw invalidResponse(label);
  return value;
}

/**
 * Transport-neutral renderer facade shared by Electron/preload and browser
 * adapters. It owns no channel names and cannot invoke or subscribe while the
 * backend capability bundle is absent, malformed, or stale.
 */
export function createTaskReliabilityClient(
  transport: TaskReliabilityRawTransport,
  options: CreateTaskReliabilityClientOptions = {},
): TaskReliabilityClient {
  let capabilities: TaskReliabilityRuntimeCapabilities = DARK_TASK_RELIABILITY_RUNTIME_CAPABILITIES;
  let capabilityReadGeneration = 0;
  let capabilityCommitGeneration = 0;
  let disposed = false;
  let stopLiveEvents: (() => void) | null = null;
  const listeners = new Set<(event: TaskReliabilityRuntimeEvent) => void>();

  function reportProtocolError(error: Error): void {
    options.onProtocolError?.(error);
  }

  function deactivate(fencePendingReads = false): void {
    if (fencePendingReads) {
      capabilityCommitGeneration = ++capabilityReadGeneration;
    }
    capabilities = DARK_TASK_RELIABILITY_RUNTIME_CAPABILITIES;
    stopLiveEvents?.();
    stopLiveEvents = null;
  }

  function getActiveCapabilities(
    feature: 'agent-sessions' | 'initial-prompt-delivery',
  ): ActiveTaskReliabilityRuntimeCapabilities {
    if (
      capabilities.kind !== 'active' ||
      (feature === 'initial-prompt-delivery' && !capabilities.initialPromptDelivery.enabled)
    ) {
      throw new TaskReliabilityCapabilityError(feature);
    }
    return capabilities;
  }

  function assertCapabilitiesUnchanged(
    expected: ActiveTaskReliabilityRuntimeCapabilities,
    feature: 'agent-sessions' | 'initial-prompt-delivery',
  ): void {
    const current = getActiveCapabilities(feature);
    if (
      current.cutoverEpoch !== expected.cutoverEpoch ||
      current.serverInstanceId !== expected.serverInstanceId
    ) {
      throw new TaskReliabilityCapabilityError(feature);
    }
  }

  function assertCurrentServer(
    serverInstanceId: string,
    expected: ActiveTaskReliabilityRuntimeCapabilities,
    label: string,
  ): void {
    if (serverInstanceId !== expected.serverInstanceId) throw invalidResponse(label);
  }

  function handleLiveEvent(value: unknown): void {
    if (disposed || capabilities.kind !== 'active') return;
    if (!isTaskReliabilityRuntimeEvent(value)) {
      reportProtocolError(new Error('Invalid task-reliability live event'));
      deactivate(true);
      return;
    }
    if (!eventMatchesTaskReliabilityCapabilities(value, capabilities)) {
      reportProtocolError(new Error('Task-reliability live event did not match the active bundle'));
      deactivate(true);
      return;
    }
    if (value.kind === 'task-reliability-capabilities-invalidated') {
      deactivate(true);
      return;
    }
    for (const listener of listeners) listener(value);
  }

  function attachLiveEvents(): boolean {
    if (stopLiveEvents || disposed || capabilities.kind !== 'active') return true;
    try {
      const stop = transport.liveEvents.subscribe(handleLiveEvent);
      if (disposed || capabilities.kind !== 'active') {
        stop();
        return false;
      }
      stopLiveEvents = stop;
      return true;
    } catch (error) {
      reportProtocolError(
        error instanceof Error ? error : new Error('Task-reliability event subscription failed'),
      );
      deactivate(true);
      return false;
    }
  }

  async function refreshCapabilities(
    signal?: AbortSignal,
  ): Promise<TaskReliabilityRuntimeCapabilities> {
    if (disposed) return DARK_TASK_RELIABILITY_RUNTIME_CAPABILITIES;
    const readGeneration = ++capabilityReadGeneration;
    let response: unknown;
    try {
      response = await transport.capabilities.read(signal);
    } catch (error) {
      // A component aborting its own read must not mutate the singleton's
      // capability truth or suppress an older in-flight successful read.
      if (isCallerAbort(error, signal)) return capabilities;
      if (readGeneration < capabilityCommitGeneration || disposed) return capabilities;
      capabilityCommitGeneration = readGeneration;
      deactivate();
      reportProtocolError(
        error instanceof Error ? error : new Error('Task-reliability capability read failed'),
      );
      return capabilities;
    }
    if (signal?.aborted) return capabilities;
    if (readGeneration < capabilityCommitGeneration || disposed) return capabilities;
    capabilityCommitGeneration = readGeneration;
    if (response === null) {
      deactivate();
      return capabilities;
    }
    if (!isActiveTaskReliabilityRuntimeCapabilities(response)) {
      deactivate();
      reportProtocolError(new Error('Invalid task-reliability capability bundle'));
      return capabilities;
    }

    const next = cloneActiveCapabilities(response);
    const identityChanged =
      capabilities.kind !== 'active' ||
      capabilities.cutoverEpoch !== next.cutoverEpoch ||
      capabilities.serverInstanceId !== next.serverInstanceId;
    if (identityChanged) {
      stopLiveEvents?.();
      stopLiveEvents = null;
    }
    capabilities = next;
    if (!attachLiveEvents()) return capabilities;
    return capabilities;
  }

  return {
    agentSessions: {
      async execute(request, signal) {
        const expected = getActiveCapabilities('agent-sessions');
        if (!isRendererAgentSessionOperationRequest(request)) {
          throw new TypeError('Invalid renderer agent-session operation request');
        }
        const result = requireResponse(
          await transport.agentSessions.execute(request, signal),
          isAgentSessionOperationResult,
          'agent-session operation',
        );
        assertCapabilitiesUnchanged(expected, 'agent-sessions');
        if (result.kind === 'operation') {
          assertCurrentServer(
            result.projection.current.serverInstanceId,
            expected,
            'agent-session operation',
          );
          const operation = result.projection.operation;
          if (
            operation.agentId !== request.agentId ||
            operation.taskId !== request.taskId ||
            operation.operationId !== request.operationId ||
            operation.launchReason !== request.launchReason ||
            operation.sourceGeneration !== request.expectedSourceGeneration ||
            operation.resumed !== (request.mode === 'resume')
          ) {
            throw invalidResponse('agent-session operation identity');
          }
        }
        return result;
      },
      async getProjection(request, signal) {
        const expected = getActiveCapabilities('agent-sessions');
        if (!isGetAgentSessionOperationProjectionRequest(request)) {
          throw new TypeError('Invalid agent-session projection request');
        }
        const response = await transport.agentSessions.getProjection(request, signal);
        assertCapabilitiesUnchanged(expected, 'agent-sessions');
        if (response === null) return null;
        const projection = requireResponse(
          response,
          isAgentSessionOperationProjection,
          'agent-session projection',
        );
        assertCurrentServer(
          projection.current.serverInstanceId,
          expected,
          'agent-session projection',
        );
        if (
          projection.operation.agentId !== request.agentId ||
          projection.operation.taskId !== request.taskId
        ) {
          throw invalidResponse('agent-session projection identity');
        }
        return projection;
      },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      capabilityReadGeneration += 1;
      listeners.clear();
      deactivate();
    },
    getCapabilities: () => capabilities,
    initialPromptDelivery: {
      async getProjection(request, signal) {
        const expected = getActiveCapabilities('initial-prompt-delivery');
        if (!isGetTaskInitialPromptDeliveryProjectionRequest(request)) {
          throw new TypeError('Invalid initial-prompt projection request');
        }
        const response = await transport.initialPromptDelivery.getProjection(request, signal);
        assertCapabilitiesUnchanged(expected, 'initial-prompt-delivery');
        if (response === null) return null;
        const projection = requireResponse(
          response,
          isTaskInitialPromptDeliveryProjection,
          'initial-prompt projection',
        );
        assertCurrentServer(
          projection.current.serverInstanceId,
          expected,
          'initial-prompt projection',
        );
        if (projection.delivery.deliveryId !== request.deliveryId) {
          throw invalidResponse('initial-prompt projection identity');
        }
        return projection;
      },
      async resolveAmbiguity(request, signal) {
        const expected = getActiveCapabilities('initial-prompt-delivery');
        if (!isResolveManualInitialPromptSendAmbiguityRequest(request)) {
          throw new TypeError('Invalid initial-prompt ambiguity request');
        }
        const result = requireResponse(
          await transport.initialPromptDelivery.resolveAmbiguity(request, signal),
          isResolveManualInitialPromptSendAmbiguityResult,
          'initial-prompt ambiguity resolution',
        );
        assertCapabilitiesUnchanged(expected, 'initial-prompt-delivery');
        const projection = result.kind === 'resolved' ? result.projection : result.current;
        if (projection) {
          assertCurrentServer(
            projection.current.serverInstanceId,
            expected,
            'initial-prompt ambiguity resolution',
          );
        }
        const operationId =
          result.kind === 'resolved'
            ? result.projection.manualSendOperation.manualSendOperationId
            : result.current?.manualSendOperation?.manualSendOperationId;
        if (operationId !== undefined && operationId !== request.manualSendOperationId) {
          throw invalidResponse('initial-prompt ambiguity resolution identity');
        }
        return result;
      },
      async reviseDraft(request, signal) {
        const expected = getActiveCapabilities('initial-prompt-delivery');
        if (!isReviseTaskInitialPromptDraftRequest(request)) {
          throw new TypeError('Invalid initial-prompt draft request');
        }
        const result = requireResponse(
          await transport.initialPromptDelivery.reviseDraft(request, signal),
          isReviseTaskInitialPromptDraftResult,
          'initial-prompt draft revision',
        );
        assertCapabilitiesUnchanged(expected, 'initial-prompt-delivery');
        return result;
      },
      async sendManually(request, signal) {
        const expected = getActiveCapabilities('initial-prompt-delivery');
        if (!isSendTaskInitialPromptManuallyRequest(request)) {
          throw new TypeError('Invalid initial-prompt manual-send request');
        }
        const result = requireResponse(
          await transport.initialPromptDelivery.sendManually(request, signal),
          isSendTaskInitialPromptManuallyResult,
          'initial-prompt manual send',
        );
        assertCapabilitiesUnchanged(expected, 'initial-prompt-delivery');
        if (result.current) {
          assertCurrentServer(
            result.current.serverInstanceId,
            expected,
            'initial-prompt manual send',
          );
        }
        if (result.kind === 'operation') {
          if (
            result.operation.agentId !== request.agentId ||
            result.operation.taskId !== request.taskId ||
            result.operation.deliveryId !== request.deliveryId ||
            result.operation.manualSendOperationId !== request.manualSendOperationId
          ) {
            throw invalidResponse('initial-prompt manual-send operation identity');
          }
        } else if (
          result.kind === 'domain-rejected' &&
          (result.delivery.agentId !== request.agentId ||
            result.delivery.taskId !== request.taskId ||
            result.delivery.deliveryId !== request.deliveryId)
        ) {
          throw invalidResponse('initial-prompt manual-send delivery identity');
        }
        return result;
      },
    },
    refreshCapabilities,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
