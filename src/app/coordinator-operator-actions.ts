import type {
  CoordinatorApproveWorkflowActionsPayload,
  CoordinatorDenyWorkflowActionsPayload,
  CoordinatorRetryLanePayload,
} from '../domain/coordinator';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { getCoordinatorRunForTask } from '../store/coordinator';
import { callCoordinatorUiTool } from './coordinator';

export type CoordinatorOperatorActionRequest =
  | {
      payload?: undefined;
      toolName: 'pause_run' | 'resume_run' | 'unpause_run';
    }
  | {
      payload: CoordinatorApproveWorkflowActionsPayload;
      toolName: 'approve_workflow_actions';
    }
  | {
      payload: CoordinatorDenyWorkflowActionsPayload;
      toolName: 'deny_workflow_actions';
    }
  | {
      payload: CoordinatorRetryLanePayload;
      toolName: 'retry_lane';
    };

export type CoordinatorOperatorActionResult =
  | { accepted: true }
  | { accepted: false; message: string };

function createOperatorActionRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOperatorActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  return message || 'Coordinator action failed.';
}

// One canonical workflow for renderer-initiated operator actions on a
// coordinator run. The rail, title bar, and any future surface share this
// path so request shape, run lookup, and rejection mapping cannot drift.
export async function runCoordinatorOperatorAction(args: {
  taskId: string;
  request: CoordinatorOperatorActionRequest;
}): Promise<CoordinatorOperatorActionResult> {
  const run = getCoordinatorRunForTask(args.taskId);
  if (!run) {
    return { accepted: false, message: 'No coordinator run is loaded for this task.' };
  }

  try {
    const response = await callCoordinatorUiTool({
      controllerId: getRuntimeClientId(),
      coordinatorTaskId: run.coordinatorTaskId,
      requestId: createOperatorActionRequestId(),
      runId: run.id,
      ...args.request,
    });
    if (!response.accepted) {
      return {
        accepted: false,
        message: response.error ?? 'Coordinator action was rejected.',
      };
    }

    return { accepted: true };
  } catch (error) {
    return { accepted: false, message: getOperatorActionErrorMessage(error) };
  }
}
