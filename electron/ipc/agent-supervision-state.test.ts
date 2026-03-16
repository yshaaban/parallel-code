import { describe, expect, it } from 'vitest';

import {
  getAttentionReasonForState,
  getPausedSupervisionState,
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
});
