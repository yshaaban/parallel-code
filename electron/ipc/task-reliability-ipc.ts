import {
  isGetAgentSessionOperationProjectionRequest,
  isRendererAgentSessionOperationRequest,
} from '../../src/domain/agent-session-operation.js';
import {
  isGetTaskInitialPromptDeliveryProjectionRequest,
  isResolveManualInitialPromptSendAmbiguityRequest,
  isReviseTaskInitialPromptDraftRequest,
  isSendTaskInitialPromptManuallyRequest,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { TaskReliabilityRuntimeEvent } from '../../src/domain/task-reliability-runtime.js';
import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import type { IpcHandlerMap } from './handlers.js';
import type { ProductionTaskExperienceRuntime } from './task-experience-runtime-composition.js';
import { defineIpcHandler } from './typed-handler.js';

function requireRequest<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  label: string,
): T {
  if (!guard(value)) throw new BadRequestError(`Invalid ${label} request`);
  return value;
}

/** Built only after the production composition has returned its active bundle. */
export function createActiveTaskReliabilityIpcHandlers(
  runtime: ProductionTaskExperienceRuntime,
): IpcHandlerMap {
  const prompt = runtime.initialPrompt.getHandlers();
  if (!prompt || prompt.registrationState !== 'active') {
    throw new Error('Task-reliability IPC requires the active initial-prompt owner');
  }
  return {
    [IPC.ExecuteAgentSessionOperation]: defineIpcHandler(
      IPC.ExecuteAgentSessionOperation,
      (request) =>
        runtime.agentSession.workflow.execute(
          requireRequest(
            request,
            isRendererAgentSessionOperationRequest,
            'agent-session operation',
          ),
        ),
    ),
    [IPC.GetAgentSessionOperationProjection]: defineIpcHandler(
      IPC.GetAgentSessionOperationProjection,
      (request) =>
        runtime.agentSession.getProjection(
          requireRequest(
            request,
            isGetAgentSessionOperationProjectionRequest,
            'agent-session projection',
          ),
        ),
    ),
    [IPC.GetInitialPromptDeliveryProjection]: defineIpcHandler(
      IPC.GetInitialPromptDeliveryProjection,
      (request) => {
        const validated = requireRequest(
          request,
          isGetTaskInitialPromptDeliveryProjectionRequest,
          'initial-prompt projection',
        );
        return prompt.getProjection(validated.deliveryId);
      },
    ),
    [IPC.GetTaskReliabilityCapabilities]: () => structuredClone(runtime.capabilities),
    [IPC.ResolveInitialPromptAmbiguity]: defineIpcHandler(
      IPC.ResolveInitialPromptAmbiguity,
      (request) =>
        prompt.resolveManualAmbiguity(
          requireRequest(
            request,
            isResolveManualInitialPromptSendAmbiguityRequest,
            'initial-prompt ambiguity resolution',
          ),
        ),
    ),
    [IPC.ReviseInitialPromptDraft]: defineIpcHandler(IPC.ReviseInitialPromptDraft, (request) =>
      prompt.reviseDraft(
        requireRequest(request, isReviseTaskInitialPromptDraftRequest, 'initial-prompt draft'),
      ),
    ),
    [IPC.SendInitialPromptManually]: defineIpcHandler(IPC.SendInitialPromptManually, (request) =>
      prompt.sendManually(
        requireRequest(
          request,
          isSendTaskInitialPromptManuallyRequest,
          'initial-prompt manual send',
        ),
      ),
    ),
  };
}

export function subscribeActiveTaskReliabilityRuntime(
  runtime: ProductionTaskExperienceRuntime,
  publish: (event: TaskReliabilityRuntimeEvent) => void,
): () => void {
  const identity = {
    cutoverEpoch: runtime.capabilities.cutoverEpoch,
    serverInstanceId: runtime.capabilities.serverInstanceId,
  };
  const stopAgent = runtime.agentSession.subscribe((projection) => {
    publish({ ...identity, kind: 'agent-session-operation-changed', projection });
  });
  const stopPrompt = runtime.initialPrompt.subscribe((projection) => {
    publish({ ...identity, kind: 'initial-prompt-delivery-changed', projection });
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stopAgent();
    stopPrompt();
  };
}
