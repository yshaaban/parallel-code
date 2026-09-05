import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from './agent-session-operation.js';
import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  isTaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDeliveryProjection,
} from './task-initial-prompt-delivery.js';
import {
  isAgentSessionOperationProjection,
  type AgentSessionOperationProjection,
} from './agent-session-operation.js';
import { isRecord } from '../lib/type-guards.js';

export const TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION = 'task-reliability-runtime-v1' as const;

export interface ActiveTaskReliabilityRuntimeCapabilities {
  agentSessions: {
    automaticResumeFallback: boolean;
    hookSetVersion: typeof AGENT_SESSION_OWNER_HOOK_SET_VERSION;
    initialLaunch: true;
    manualReplacement: true;
  };
  contractVersion: typeof TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION;
  cutoverEpoch: string;
  initialPromptDelivery:
    | { enabled: false }
    | {
        enabled: true;
        hookSetVersion: typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION;
      };
  kind: 'active';
  serverInstanceId: string;
}

export interface DarkTaskReliabilityRuntimeCapabilities {
  contractVersion: typeof TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION;
  kind: 'dark';
}

export type TaskReliabilityRuntimeCapabilities =
  | ActiveTaskReliabilityRuntimeCapabilities
  | DarkTaskReliabilityRuntimeCapabilities;

/** Local fail-closed state. A dark backend does not advertise this object. */
export const DARK_TASK_RELIABILITY_RUNTIME_CAPABILITIES: Readonly<DarkTaskReliabilityRuntimeCapabilities> =
  Object.freeze({
    contractVersion: TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION,
    kind: 'dark',
  });

export type TaskReliabilityRuntimeEvent =
  | {
      cutoverEpoch: string;
      kind: 'agent-session-operation-changed';
      projection: AgentSessionOperationProjection;
      serverInstanceId: string;
    }
  | {
      cutoverEpoch: string;
      kind: 'initial-prompt-delivery-changed';
      projection: TaskInitialPromptDeliveryProjection;
      serverInstanceId: string;
    }
  | {
      kind: 'task-reliability-capabilities-invalidated';
      serverInstanceId: string;
    };

const SAFE_IDENTITY = /^[A-Za-z0-9._:@-]+$/u;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isSafeIdentity(value: unknown, maxLength = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    SAFE_IDENTITY.test(value)
  );
}

export function isActiveTaskReliabilityRuntimeCapabilities(
  value: unknown,
): value is ActiveTaskReliabilityRuntimeCapabilities {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'agentSessions',
      'contractVersion',
      'cutoverEpoch',
      'initialPromptDelivery',
      'kind',
      'serverInstanceId',
    ]) ||
    value.contractVersion !== TASK_RELIABILITY_RUNTIME_CONTRACT_VERSION ||
    value.kind !== 'active' ||
    !isSafeIdentity(value.cutoverEpoch) ||
    !isSafeIdentity(value.serverInstanceId) ||
    !isRecord(value.agentSessions) ||
    !hasExactKeys(value.agentSessions, [
      'automaticResumeFallback',
      'hookSetVersion',
      'initialLaunch',
      'manualReplacement',
    ]) ||
    typeof value.agentSessions.automaticResumeFallback !== 'boolean' ||
    value.agentSessions.hookSetVersion !== AGENT_SESSION_OWNER_HOOK_SET_VERSION ||
    value.agentSessions.initialLaunch !== true ||
    value.agentSessions.manualReplacement !== true ||
    !isRecord(value.initialPromptDelivery)
  ) {
    return false;
  }

  return value.initialPromptDelivery.enabled === false
    ? hasExactKeys(value.initialPromptDelivery, ['enabled'])
    : value.initialPromptDelivery.enabled === true &&
        hasExactKeys(value.initialPromptDelivery, ['enabled', 'hookSetVersion']) &&
        value.initialPromptDelivery.hookSetVersion === TASK_INITIAL_PROMPT_HOOK_SET_VERSION;
}

export function isTaskReliabilityRuntimeEvent(
  value: unknown,
): value is TaskReliabilityRuntimeEvent {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'task-reliability-capabilities-invalidated') {
    return (
      hasExactKeys(value, ['kind', 'serverInstanceId']) && isSafeIdentity(value.serverInstanceId)
    );
  }
  if (
    !hasExactKeys(value, ['cutoverEpoch', 'kind', 'projection', 'serverInstanceId']) ||
    !isSafeIdentity(value.cutoverEpoch) ||
    !isSafeIdentity(value.serverInstanceId)
  ) {
    return false;
  }
  if (value.kind === 'agent-session-operation-changed') {
    return (
      isAgentSessionOperationProjection(value.projection) &&
      value.projection.current.serverInstanceId === value.serverInstanceId
    );
  }
  return (
    value.kind === 'initial-prompt-delivery-changed' &&
    isTaskInitialPromptDeliveryProjection(value.projection) &&
    value.projection.current.serverInstanceId === value.serverInstanceId
  );
}

export function eventMatchesTaskReliabilityCapabilities(
  event: TaskReliabilityRuntimeEvent,
  capabilities: ActiveTaskReliabilityRuntimeCapabilities,
): boolean {
  if (event.serverInstanceId !== capabilities.serverInstanceId) return false;
  if (event.kind === 'task-reliability-capabilities-invalidated') return true;
  if (event.cutoverEpoch !== capabilities.cutoverEpoch) return false;
  return (
    event.kind !== 'initial-prompt-delivery-changed' || capabilities.initialPromptDelivery.enabled
  );
}
