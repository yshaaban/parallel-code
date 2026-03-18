import { describe, expect, it } from 'vitest';
import {
  appendRemoteAgentTail,
  deriveRemoteAgentPreview,
  formatRemoteAgentActivity,
  formatRemoteAgentId,
  getRemoteAgentStatusPresentation,
  truncateRemoteAgentTail,
} from './agent-presentation';

describe('remote agent presentation helpers', () => {
  it('derives a readable preview from ansi-heavy terminal output', () => {
    const preview = deriveRemoteAgentPreview(
      '\u001b[32mBuild complete\u001b[0m\nready for next input\n❯ ',
      'running',
    );

    expect(preview).toBe('ready for next input');
  });

  it('falls back to a meaningful status message when no visible output exists', () => {
    expect(deriveRemoteAgentPreview('', 'paused')).toBe('Paused and waiting for input');
  });

  it('caps retained tail size while preserving the most recent output', () => {
    const nextTail = appendRemoteAgentTail('a'.repeat(1100), 'b'.repeat(300));

    expect(nextTail).toHaveLength(1200);
    expect(nextTail.endsWith('b'.repeat(300))).toBe(true);
  });

  it('truncates full scrollback snapshots before they become preview tails', () => {
    const truncatedTail = truncateRemoteAgentTail('x'.repeat(1_500));

    expect(truncatedTail).toHaveLength(1_200);
    expect(truncatedTail).toBe('x'.repeat(1_200));
  });

  it('formats activity labels for live and older updates', () => {
    expect(formatRemoteAgentActivity('running', null, 1_000)).toBe('Live now');
    expect(formatRemoteAgentActivity('paused', 5_000, 20_000)).toBe('15s ago');
    expect(formatRemoteAgentActivity('exited', 60_000, 3_660_000)).toBe('1h ago');
  });

  it('formats long agent ids compactly', () => {
    expect(formatRemoteAgentId('1234567890abcdef')).toBe('123456…cdef');
    expect(formatRemoteAgentId('short-id')).toBe('short-id');
  });

  it('maps agent statuses to explicit badge presentation', () => {
    expect(getRemoteAgentStatusPresentation('running').badgeLabel).toBe('Live');
    expect(getRemoteAgentStatusPresentation('restoring').badgeLabel).toBe('Syncing');
    expect(getRemoteAgentStatusPresentation('exited').badgeLabel).toBe('Finished');
  });
});
