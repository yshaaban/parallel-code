import { describe, expect, it } from 'vitest';
import {
  appendRemoteAgentTail,
  deriveRemoteAgentPreview,
  formatRemoteAgentActivity,
  formatRemoteAgentId,
  formatRemoteLastPrompt,
  formatRemoteTaskContext,
  getRemoteAgentListStatePresentation,
  getRemotePrimaryPreviewPort,
  getRemoteAgentTypeLabel,
  getRemoteAgentStatusPresentation,
  normalizeRemoteAgentGlyphKind,
  summarizeRemoteTaskReview,
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

  it('maps supervision-backed remote list states to actionable labels', () => {
    expect(
      getRemoteAgentListStatePresentation('running', null, {
        attentionReason: 'waiting-input',
        state: 'awaiting-input',
      }).badgeLabel,
    ).toBe('Waiting');
    expect(
      getRemoteAgentListStatePresentation('running', null, {
        attentionReason: 'ready-for-next-step',
        state: 'idle-at-prompt',
      }).badgeLabel,
    ).toBe('Ready');
    expect(
      getRemoteAgentListStatePresentation('running', null, {
        attentionReason: 'quiet-too-long',
        state: 'quiet',
      }).badgeLabel,
    ).toBe('Quiet');
    expect(
      getRemoteAgentListStatePresentation('running', null, {
        attentionReason: null,
        state: 'active',
      }).badgeLabel,
    ).toBe('Busy');
    expect(getRemoteAgentListStatePresentation('exited', 1, null).badgeLabel).toBe('Exit 1');
  });
});

describe('normalizeRemoteAgentGlyphKind', () => {
  it('detects claude from agentDefId', () => {
    expect(normalizeRemoteAgentGlyphKind('claude-code', null)).toBe('claude');
  });

  it('detects gemini from agentDefName', () => {
    expect(normalizeRemoteAgentGlyphKind(null, 'Gemini CLI')).toBe('gemini');
  });

  it('detects codex from agentDefId', () => {
    expect(normalizeRemoteAgentGlyphKind('codex', 'Codex CLI')).toBe('codex');
  });

  it('detects opencode with space variant', () => {
    expect(normalizeRemoteAgentGlyphKind(null, 'Open Code')).toBe('opencode');
  });

  it('detects hydra from agentDefName', () => {
    expect(normalizeRemoteAgentGlyphKind('hydra-cli', null)).toBe('hydra');
  });

  it('returns generic for unknown agents', () => {
    expect(normalizeRemoteAgentGlyphKind(null, null)).toBe('generic');
    expect(normalizeRemoteAgentGlyphKind('custom-tool', 'My Tool')).toBe('generic');
  });
});

describe('formatRemoteTaskContext', () => {
  it('combines branch and folder with separator', () => {
    expect(formatRemoteTaskContext('main', 'my-project', false)).toBe('main \u00B7 my-project');
  });

  it('shows branch with direct mode label', () => {
    expect(formatRemoteTaskContext('feature/auth', null, true)).toBe('feature/auth (direct)');
  });

  it('shows folder alone when branch is null', () => {
    expect(formatRemoteTaskContext(null, 'my-project', false)).toBe('my-project');
  });

  it('keeps direct mode visible when branch metadata is unavailable', () => {
    expect(formatRemoteTaskContext(null, 'my-project', true)).toBe('Direct \u00B7 my-project');
  });

  it('returns null when both are null', () => {
    expect(formatRemoteTaskContext(null, null, false)).toBeNull();
  });
});

describe('formatRemoteLastPrompt', () => {
  it('returns short prompts as-is', () => {
    expect(formatRemoteLastPrompt('implement login')).toBe('implement login');
  });

  it('truncates long prompts with ellipsis', () => {
    const long = 'review the failing build output and collect the regressions before merge '.repeat(
      2,
    );
    const result = formatRemoteLastPrompt(long);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(80);
    expect(result?.endsWith('\u2026')).toBe(true);
  });

  it('returns null for empty or whitespace prompts', () => {
    expect(formatRemoteLastPrompt(null)).toBeNull();
    expect(formatRemoteLastPrompt('   ')).toBeNull();
  });

  it('filters out low-signal prompt noise', () => {
    expect(formatRemoteLastPrompt('klkkkkkkkkkkkkkkkkkkkkkkkk')).toBeNull();
  });
});

describe('getRemoteAgentTypeLabel', () => {
  it('prefers the explicit agent name when available', () => {
    expect(getRemoteAgentTypeLabel('codex', 'Codex CLI')).toBe('Codex CLI');
  });

  it('falls back to the normalized glyph label when only the id is known', () => {
    expect(getRemoteAgentTypeLabel('claude-code', null)).toBe('Claude');
  });
});

describe('task summaries', () => {
  it('summarizes file and conflict counts from task review snapshots', () => {
    expect(
      summarizeRemoteTaskReview({
        branchName: 'feature/review',
        files: [
          { committed: false, lines_added: 1, lines_removed: 0, path: 'src/one.ts', status: 'M' },
          { committed: false, lines_added: 0, lines_removed: 0, path: 'src/two.ts', status: 'U' },
        ],
        projectId: 'project-1',
        revisionId: 'rev-1',
        source: 'branch-fallback',
        taskId: 'task-1',
        totalAdded: 1,
        totalRemoved: 0,
        updatedAt: 10,
        worktreePath: '/tmp/task-1',
      }),
    ).toEqual({
      conflictCount: 1,
      fileCount: 2,
      source: 'branch-fallback',
    });
  });

  it('prefers available exposed preview ports', () => {
    expect(
      getRemotePrimaryPreviewPort({
        exposed: [
          {
            availability: 'unknown',
            host: null,
            label: null,
            lastVerifiedAt: null,
            port: 4173,
            protocol: 'http',
            source: 'manual',
            statusMessage: null,
            updatedAt: 10,
            verifiedHost: null,
          },
          {
            availability: 'available',
            host: '127.0.0.1',
            label: 'Preview',
            lastVerifiedAt: 20,
            port: 3000,
            protocol: 'http',
            source: 'observed',
            statusMessage: null,
            updatedAt: 20,
            verifiedHost: '127.0.0.1',
          },
        ],
        observed: [],
        taskId: 'task-1',
        updatedAt: 20,
      })?.port,
    ).toBe(3000);
  });
});
