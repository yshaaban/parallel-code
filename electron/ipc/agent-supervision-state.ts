import type {
  AgentSupervisionSnapshot,
  AgentSupervisionState,
  PauseReason,
  TaskAttentionReason,
} from '../../src/domain/server-state.js';

export function getAttentionReasonForState(
  state: AgentSupervisionState,
): TaskAttentionReason | null {
  switch (state) {
    case 'awaiting-input':
      return 'waiting-input';
    case 'idle-at-prompt':
      return 'ready-for-next-step';
    case 'quiet':
      return 'quiet-too-long';
    case 'paused':
      return 'paused';
    case 'flow-controlled':
      return 'flow-controlled';
    case 'restoring':
      return 'restoring';
    case 'exited-error':
      return 'failed';
    case 'active':
    case 'exited-clean':
      return null;
    default:
      return null;
  }
}

export function getPausedSupervisionState(
  reason: PauseReason | null,
): AgentSupervisionState | null {
  switch (reason) {
    case 'manual':
      return 'paused';
    case 'flow-control':
      return 'flow-controlled';
    case 'restore':
      return 'restoring';
    case null:
      return null;
    default:
      return null;
  }
}

export function shouldEmitSnapshotChange(
  current: AgentSupervisionSnapshot | undefined,
  next: AgentSupervisionSnapshot,
): boolean {
  if (!current) {
    return true;
  }

  if (
    current.state !== next.state ||
    current.attentionReason !== next.attentionReason ||
    current.taskId !== next.taskId ||
    current.isShell !== next.isShell
  ) {
    return true;
  }

  if (
    next.state === 'awaiting-input' ||
    next.state === 'idle-at-prompt' ||
    next.state === 'exited-clean' ||
    next.state === 'exited-error'
  ) {
    return current.preview !== next.preview;
  }

  return false;
}
