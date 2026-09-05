import type { AgentSupervisionState } from './server-state.js';

export type PromptInputAdmissionPurpose = 'ordinary-post-start' | 'initial-delivery';

export interface PromptInputAdmissionExpectation {
  agentGeneration: number;
  agentId: string;
  controllerId: string;
  leaseGeneration: number;
  leaseOwnerId: string;
  purpose: PromptInputAdmissionPurpose;
  supervisionVersion: number;
  taskId: string;
}

export interface PromptInputAdmissionCurrentState {
  agentGeneration: number;
  state: AgentSupervisionState;
  supervisionVersion: number;
  taskId: string;
}

export type PromptInputAdmissionRejectionReason =
  | 'question-active'
  | 'agent-not-ready'
  | 'agent-generation-changed'
  | 'supervision-version-changed'
  | 'control-or-lease-lost'
  | 'task-closing';

export type PromptInputAdmissionResult =
  | {
      kind: 'rejected-before-bytes';
      reason: PromptInputAdmissionRejectionReason;
      currentGeneration?: number;
      currentSupervisionVersion?: number;
    }
  | {
      admittedSupervisionVersion: number;
      kind: 'accepted';
      lowLevelCallCount: 1 | 2;
    }
  | {
      admittedSupervisionVersion: number;
      bytesMayHaveBeenAccepted: true;
      kind: 'outcome-ambiguous';
    };

export interface OrdinaryTaskPromptInputResult {
  admission: PromptInputAdmissionResult;
}
