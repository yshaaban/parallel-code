import type { RendererAgentSessionOperationRequest } from '../domain/agent-session-operation';
import { canDispatchToTask } from '../domain/task-catalog';
import { createRandomId } from '../lib/random-id';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { applyAgentSessionOperationProjection } from '../store/agents';
import { store } from '../store/state';
import type { ManualAgentSessionAction } from './agent-session-action';
import { getRetainedTaskCommandLeaseGeneration } from './task-command-lease-runtime';
import { isTaskCommandLeaseSkipped, runWithTaskCommandLease } from './task-command-lease-session';
import { getProductionTaskReliabilityClient } from './task-reliability-production';
import {
  clearRetainedManualAgentSessionOperation,
  retainManualAgentSessionOperation,
  resetManualAgentSessionOperationsForTests,
} from './agent-session-operation-retention';

export { resetManualAgentSessionOperationsForTests };

function newOperationId(): string {
  return `agent-session-ui:v1:${createRandomId()}`;
}

function actionKey(taskId: string, action: ManualAgentSessionAction): string {
  return `${taskId}\u0000${action.kind}\u0000${action.kind === 'switch' ? action.agentDef.id : ''}`;
}

function actionDescription(action: ManualAgentSessionAction): string {
  switch (action.kind) {
    case 'restart':
      return 'restart an agent';
    case 'resume':
      return 'resume an agent';
    case 'switch':
      return 'switch an agent';
  }
}

function createRequest(
  agentId: string,
  taskId: string,
  sourceGeneration: number,
  leaseGeneration: number,
  action: ManualAgentSessionAction,
  retainedOperationId: string,
): RendererAgentSessionOperationRequest {
  const base = {
    admission: { kind: 'task-command' as const },
    agentId,
    controllerId: getRuntimeClientId(),
    expectedLeaseGeneration: leaseGeneration,
    expectedSourceGeneration: sourceGeneration,
    operationId: retainedOperationId,
    taskId,
  };
  switch (action.kind) {
    case 'restart':
      return { ...base, launchReason: 'manual-restart', mode: 'fresh' };
    case 'resume':
      return { ...base, launchReason: 'manual-resume', mode: 'resume' };
    case 'switch':
      return {
        ...base,
        launchReason: 'agent-switch',
        mode: 'switch',
        nextAgentDefId: action.agentDef.id,
      };
  }
}

function operationFailureMessage(action: ManualAgentSessionAction, phase: string): string {
  const label = action.kind === 'switch' ? 'switch agent' : `${action.kind} agent`;
  return `Could not ${label}; the session operation ended in ${phase}.`;
}

/**
 * Sole renderer command for manual agent replacement. It holds the existing
 * task-control lease while the backend validates and executes the generation
 * transition; renderer state changes only after an authoritative result.
 */
export async function runManualAgentSessionAction(
  agentId: string,
  action: ManualAgentSessionAction,
  options: { confirmTakeover?: boolean } = {},
): Promise<boolean> {
  const initialAgent = store.agents[agentId];
  if (!initialAgent) return false;
  const client = getProductionTaskReliabilityClient();
  const capabilities = await client.refreshCapabilities();
  if (capabilities.kind !== 'active' || !capabilities.agentSessions.manualReplacement) {
    throw new Error('Managed agent-session replacement is unavailable.');
  }
  const retained = retainManualAgentSessionOperation({
    actionKey: actionKey(initialAgent.taskId, action),
    agentId,
    createOperationId: newOperationId,
    taskId: initialAgent.taskId,
  });

  const result = await runWithTaskCommandLease(
    initialAgent.taskId,
    actionDescription(action),
    async () => {
      const current = store.agents[agentId];
      const leaseGeneration = getRetainedTaskCommandLeaseGeneration(initialAgent.taskId);
      if (!current || current.taskId !== initialAgent.taskId || leaseGeneration === null) {
        return false;
      }
      if (retained.request) {
        const latest = await client.agentSessions
          .getProjection({ agentId, taskId: initialAgent.taskId })
          .catch(() => null);
        if (latest?.operation.operationId === retained.operationId) {
          const terminal =
            latest.operation.phase === 'running' ||
            latest.operation.phase === 'failed' ||
            latest.operation.phase === 'cancelled' ||
            latest.operation.phase === 'superseded' ||
            latest.operation.phase === 'attempted-no-replay';
          if (terminal) {
            clearRetainedManualAgentSessionOperation(agentId);
            const running =
              latest.operation.phase === 'running' ||
              (latest.operation.phase === 'attempted-no-replay' &&
                latest.operation.markerTerminalPhase === 'running');
            if (!running) {
              throw new Error(operationFailureMessage(action, latest.operation.phase));
            }
            return applyAgentSessionOperationProjection(
              latest,
              action.kind === 'switch' ? action.agentDef : undefined,
            );
          }
        } else if (latest) {
          clearRetainedManualAgentSessionOperation(agentId);
          throw new Error('Could not retry the agent session; a newer operation already exists.');
        }
      }
      const request =
        retained.request ??
        createRequest(
          agentId,
          initialAgent.taskId,
          current.generation,
          leaseGeneration,
          action,
          retained.operationId,
        );
      retained.request = request;
      const response = await client.agentSessions.execute(request);
      if (response.kind !== 'operation') {
        throw new Error('Managed agent-session state is unavailable.');
      }
      if (response.projection.operation.operationId === retained.operationId) {
        clearRetainedManualAgentSessionOperation(agentId);
      }
      if (!canDispatchToTask(response.projection.current)) return false;
      const { operation } = response.projection;
      const running =
        operation.phase === 'running' ||
        (operation.phase === 'attempted-no-replay' && operation.markerTerminalPhase === 'running');
      if (!running) throw new Error(operationFailureMessage(action, operation.phase));
      return applyAgentSessionOperationProjection(
        response.projection,
        action.kind === 'switch' ? action.agentDef : undefined,
      );
    },
    options,
  );

  return isTaskCommandLeaseSkipped(result) ? false : result;
}
