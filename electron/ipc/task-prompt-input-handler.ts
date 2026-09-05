import type { AgentSupervisionSnapshot } from '../../src/domain/server-state.js';
import { materializePromptDispatch } from '../../src/domain/task-prompt-materialization.js';
import type {
  OrdinaryTaskPromptInputResult,
  PromptInputAdmissionCurrentState,
  PromptInputAdmissionExpectation,
} from '../../src/domain/task-prompt-input-admission.js';
import type { TaskPromptInputAdmissionService } from './task-prompt-input-admission.js';

export interface TaskPromptAgentMetadata {
  generation: number;
  isShell: boolean;
  taskId: string;
}

export interface TaskPromptLeaseIdentity {
  clientId: string;
  leaseGeneration: number;
  ownerId: string;
}

export interface OrdinaryTaskPromptInputRequest {
  agentId: string;
  controllerId: string;
  taskId: string;
  text: string;
}

export interface TaskPromptInputCurrentStateDependencies {
  getAgentGeneration: (agentId: string) => number | null;
  getAgentMetadata: (agentId: string) => TaskPromptAgentMetadata | null;
  getSupervisionSnapshot: (agentId: string) => AgentSupervisionSnapshot | null;
}

export interface OrdinaryTaskPromptInputHandlerDependencies extends TaskPromptInputCurrentStateDependencies {
  admission: TaskPromptInputAdmissionService;
  getLeaseIdentity: (taskId: string, controllerId: string) => TaskPromptLeaseIdentity | null;
}

export function readTaskPromptInputAdmissionCurrentState(
  dependencies: TaskPromptInputCurrentStateDependencies,
  expectation: Pick<PromptInputAdmissionExpectation, 'agentId' | 'purpose'>,
): PromptInputAdmissionCurrentState | null {
  const generation = dependencies.getAgentGeneration(expectation.agentId);
  const metadata = dependencies.getAgentMetadata(expectation.agentId);
  const supervision = dependencies.getSupervisionSnapshot(expectation.agentId);
  if (
    generation === null ||
    !supervision ||
    supervision.isShell ||
    supervision.generation === undefined ||
    supervision.generation !== generation ||
    (expectation.purpose === 'initial-delivery' && metadata === null) ||
    (metadata !== null &&
      (metadata.isShell ||
        metadata.generation !== generation ||
        metadata.taskId !== supervision.taskId)) ||
    supervision.supervisionVersion === undefined
  ) {
    return null;
  }

  return {
    agentGeneration: generation,
    state: supervision.state,
    supervisionVersion: supervision.supervisionVersion,
    taskId: supervision.taskId,
  };
}

export function createOrdinaryTaskPromptInputHandler(
  dependencies: OrdinaryTaskPromptInputHandlerDependencies,
): (request: OrdinaryTaskPromptInputRequest) => Promise<OrdinaryTaskPromptInputResult> {
  return async (request) => {
    const current = readTaskPromptInputAdmissionCurrentState(dependencies, {
      agentId: request.agentId,
      purpose: 'ordinary-post-start',
    });
    if (!current) {
      const currentGeneration = dependencies.getAgentGeneration(request.agentId);
      return {
        admission: {
          ...(currentGeneration !== null ? { currentGeneration } : {}),
          kind: 'rejected-before-bytes',
          reason: 'agent-generation-changed',
        },
      };
    }
    if (current.taskId !== request.taskId) {
      return {
        admission: {
          kind: 'rejected-before-bytes',
          reason: 'control-or-lease-lost',
        },
      };
    }

    const lease = dependencies.getLeaseIdentity(request.taskId, request.controllerId);
    if (!lease) {
      return {
        admission: {
          kind: 'rejected-before-bytes',
          reason: 'control-or-lease-lost',
        },
      };
    }

    const expectation: PromptInputAdmissionExpectation = {
      agentGeneration: current.agentGeneration,
      agentId: request.agentId,
      controllerId: lease.clientId,
      leaseGeneration: lease.leaseGeneration,
      leaseOwnerId: lease.ownerId,
      purpose: 'ordinary-post-start',
      supervisionVersion: current.supervisionVersion,
      taskId: request.taskId,
    };
    const writes = materializePromptDispatch(request.text).writes;
    const firstWrite = writes[0];
    if (!firstWrite) {
      throw new Error('Prompt materialization produced no input frame');
    }
    const submitWrite = writes[1];

    return {
      admission: await dependencies.admission.admit(expectation, {
        firstFrame: firstWrite.data,
        ...(submitWrite
          ? {
              submitDelayMs: firstWrite.delayAfterMs,
              submitFrame: submitWrite.data,
            }
          : {}),
      }),
    };
  };
}
