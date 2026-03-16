import type {
  AgentSupervisionSnapshot,
  AgentSupervisionState,
  PauseReason,
  TaskAttentionReason,
} from '../../src/domain/server-state.js';

const ATTENTION_REASON_BY_SUPERVISION_STATE: Record<
  AgentSupervisionState,
  TaskAttentionReason | null
> = {
  active: null,
  'awaiting-input': 'waiting-input',
  'idle-at-prompt': 'ready-for-next-step',
  quiet: 'quiet-too-long',
  paused: 'paused',
  'flow-controlled': 'flow-controlled',
  restoring: 'restoring',
  'exited-clean': null,
  'exited-error': 'failed',
};

const PAUSED_SUPERVISION_STATE_BY_REASON: Record<PauseReason, AgentSupervisionState> = {
  manual: 'paused',
  'flow-control': 'flow-controlled',
  restore: 'restoring',
};

export function getAttentionReasonForState(
  state: AgentSupervisionState,
): TaskAttentionReason | null {
  return ATTENTION_REASON_BY_SUPERVISION_STATE[state];
}

export function getPausedSupervisionState(
  reason: PauseReason | null,
): AgentSupervisionState | null {
  if (reason === null) {
    return null;
  }

  return PAUSED_SUPERVISION_STATE_BY_REASON[reason];
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
