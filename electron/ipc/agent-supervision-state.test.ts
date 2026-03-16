import { describe, expect, it } from 'vitest';

import {
  getAttentionReasonForState,
  getPausedSupervisionState,
  shouldComparePreviewForState,
  shouldScheduleQuietTimerForState,
} from './agent-supervision-state.js';

describe('agent supervision state helpers', () => {
  it('maps supervision states to attention reasons exhaustively', () => {
    expect(getAttentionReasonForState('active')).toBeNull();
    expect(getAttentionReasonForState('awaiting-input')).toBe('waiting-input');
    expect(getAttentionReasonForState('idle-at-prompt')).toBe('ready-for-next-step');
    expect(getAttentionReasonForState('quiet')).toBe('quiet-too-long');
    expect(getAttentionReasonForState('paused')).toBe('paused');
    expect(getAttentionReasonForState('flow-controlled')).toBe('flow-controlled');
    expect(getAttentionReasonForState('restoring')).toBe('restoring');
    expect(getAttentionReasonForState('exited-clean')).toBeNull();
    expect(getAttentionReasonForState('exited-error')).toBe('failed');
  });

  it('maps pause reasons to paused supervision states', () => {
    expect(getPausedSupervisionState('manual')).toBe('paused');
    expect(getPausedSupervisionState('flow-control')).toBe('flow-controlled');
    expect(getPausedSupervisionState('restore')).toBe('restoring');
    expect(getPausedSupervisionState(null)).toBeNull();
  });

  it('tracks preview comparison and quiet timer states exhaustively', () => {
    expect(shouldComparePreviewForState('active')).toBe(false);
    expect(shouldComparePreviewForState('awaiting-input')).toBe(true);
    expect(shouldComparePreviewForState('idle-at-prompt')).toBe(true);
    expect(shouldComparePreviewForState('quiet')).toBe(false);
    expect(shouldComparePreviewForState('paused')).toBe(false);
    expect(shouldComparePreviewForState('flow-controlled')).toBe(false);
    expect(shouldComparePreviewForState('restoring')).toBe(false);
    expect(shouldComparePreviewForState('exited-clean')).toBe(true);
    expect(shouldComparePreviewForState('exited-error')).toBe(true);

    expect(shouldScheduleQuietTimerForState('active')).toBe(true);
    expect(shouldScheduleQuietTimerForState('awaiting-input')).toBe(true);
    expect(shouldScheduleQuietTimerForState('idle-at-prompt')).toBe(true);
    expect(shouldScheduleQuietTimerForState('quiet')).toBe(true);
    expect(shouldScheduleQuietTimerForState('paused')).toBe(false);
    expect(shouldScheduleQuietTimerForState('flow-controlled')).toBe(false);
    expect(shouldScheduleQuietTimerForState('restoring')).toBe(false);
    expect(shouldScheduleQuietTimerForState('exited-clean')).toBe(false);
    expect(shouldScheduleQuietTimerForState('exited-error')).toBe(false);
  });
});
