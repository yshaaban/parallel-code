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

const PREVIEW_COMPARISON_BY_SUPERVISION_STATE: Record<AgentSupervisionState, boolean> = {
  active: false,
  'awaiting-input': true,
  'idle-at-prompt': true,
  quiet: false,
  paused: false,
  'flow-controlled': false,
  restoring: false,
  'exited-clean': true,
  'exited-error': true,
};

const QUIET_TIMER_BY_SUPERVISION_STATE: Record<AgentSupervisionState, boolean> = {
  active: true,
  'awaiting-input': true,
  'idle-at-prompt': true,
  quiet: true,
  paused: false,
  'flow-controlled': false,
  restoring: false,
  'exited-clean': false,
  'exited-error': false,
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

export function shouldComparePreviewForState(state: AgentSupervisionState): boolean {
  return PREVIEW_COMPARISON_BY_SUPERVISION_STATE[state];
}

export function shouldScheduleQuietTimerForState(state: AgentSupervisionState): boolean {
  return QUIET_TIMER_BY_SUPERVISION_STATE[state];
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

  if (shouldComparePreviewForState(next.state)) {
    return current.preview !== next.preview;
  }

  return false;
}
