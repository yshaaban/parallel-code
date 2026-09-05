import type { RendererAgentSessionOperationRequest } from '../domain/agent-session-operation';

export const RETAINED_MANUAL_AGENT_SESSION_OPERATION_LIMIT = 256;
export const RETAINED_MANUAL_AGENT_SESSION_OPERATION_TTL_MS = 30 * 60_000;

export interface RetainedManualAgentSessionOperation {
  actionKey: string;
  agentId: string;
  operationId: string;
  request?: RendererAgentSessionOperationRequest;
  taskId: string;
  touchedAtMs: number;
}

const retainedByAgentId = new Map<string, RetainedManualAgentSessionOperation>();

function pruneRetainedOperations(nowMs: number): void {
  for (const [agentId, retained] of retainedByAgentId) {
    if (nowMs - retained.touchedAtMs >= RETAINED_MANUAL_AGENT_SESSION_OPERATION_TTL_MS) {
      retainedByAgentId.delete(agentId);
    }
  }
}

export function retainManualAgentSessionOperation(input: {
  actionKey: string;
  agentId: string;
  createOperationId: () => string;
  nowMs?: number;
  taskId: string;
}): RetainedManualAgentSessionOperation {
  const nowMs = input.nowMs ?? Date.now();
  pruneRetainedOperations(nowMs);
  const existing = retainedByAgentId.get(input.agentId);
  if (
    existing?.actionKey === input.actionKey &&
    existing.taskId === input.taskId &&
    nowMs - existing.touchedAtMs < RETAINED_MANUAL_AGENT_SESSION_OPERATION_TTL_MS
  ) {
    existing.touchedAtMs = nowMs;
    retainedByAgentId.delete(input.agentId);
    retainedByAgentId.set(input.agentId, existing);
    return existing;
  }
  while (retainedByAgentId.size >= RETAINED_MANUAL_AGENT_SESSION_OPERATION_LIMIT) {
    const oldestAgentId = retainedByAgentId.keys().next().value as string | undefined;
    if (oldestAgentId === undefined) break;
    retainedByAgentId.delete(oldestAgentId);
  }
  const created: RetainedManualAgentSessionOperation = {
    actionKey: input.actionKey,
    agentId: input.agentId,
    operationId: input.createOperationId(),
    taskId: input.taskId,
    touchedAtMs: nowMs,
  };
  retainedByAgentId.set(input.agentId, created);
  return created;
}

export function clearRetainedManualAgentSessionOperation(agentId: string): void {
  retainedByAgentId.delete(agentId);
}

export function clearRetainedManualAgentSessionOperationsForTask(taskId: string): void {
  for (const [agentId, retained] of retainedByAgentId) {
    if (retained.taskId === taskId) retainedByAgentId.delete(agentId);
  }
}

export function resetManualAgentSessionOperationsForTests(): void {
  retainedByAgentId.clear();
}
