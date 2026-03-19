import { describe, expect, it } from 'vitest';

import {
  getRemoteAgentStatus,
  isAutomaticPauseReason,
  isExitedRemoteAgentStatus,
  isPauseReason,
} from './server-state';

describe('server state helpers', () => {
  it('recognizes only supported pause reasons', () => {
    expect(isPauseReason('manual')).toBe(true);
    expect(isPauseReason('flow-control')).toBe(true);
    expect(isPauseReason('restore')).toBe(true);
    expect(isPauseReason('resume')).toBe(false);
    expect(isPauseReason(undefined)).toBe(false);
  });

  it('maps pause reasons to remote agent statuses', () => {
    expect(getRemoteAgentStatus('manual')).toBe('paused');
    expect(getRemoteAgentStatus('flow-control')).toBe('flow-controlled');
    expect(getRemoteAgentStatus('restore')).toBe('restoring');
    expect(getRemoteAgentStatus(null, 'exited')).toBe('exited');
  });

  it('identifies automatic pause reasons without string fallbacks', () => {
    expect(isAutomaticPauseReason('manual')).toBe(false);
    expect(isAutomaticPauseReason('flow-control')).toBe(true);
    expect(isAutomaticPauseReason('restore')).toBe(true);
    expect(isAutomaticPauseReason(undefined)).toBe(false);
  });

  it('exposes explicit remote-agent lifecycle predicates', () => {
    expect(isExitedRemoteAgentStatus('running')).toBe(false);
    expect(isExitedRemoteAgentStatus('paused')).toBe(false);
    expect(isExitedRemoteAgentStatus('flow-controlled')).toBe(false);
    expect(isExitedRemoteAgentStatus('restoring')).toBe(false);
    expect(isExitedRemoteAgentStatus('exited')).toBe(true);
  });
});
