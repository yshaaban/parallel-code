import { describe, expect, it } from 'vitest';
import { createTestAgentDef } from '../test/store-test-helpers';
import {
  AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES,
  buildAgentSpawnArgs,
  classifyAgentResumeFallback,
  getAgentResumeStrategy,
  isAgentResumeStrategy,
  shouldResumeAgentOnSpawn,
} from './agent-resume';

const SUPPORTED_CLAUDE = {
  resume_failure_classifier: 'claude-no-conversation-v1',
  resume_failure_fallback: 'fresh-start',
} as const;

function createResumeExitFacts(
  overrides: Partial<Parameters<typeof classifyAgentResumeFallback>[1]> = {},
): Parameters<typeof classifyAgentResumeFallback>[1] {
  return {
    exitCode: 1,
    lastOutput: ['No conversation found to continue'],
    resumed: true,
    signal: null,
    ...overrides,
  };
}

describe('agent resume helpers', () => {
  it('uses hydra session recovery for hydra agents', () => {
    const hydraAgent = createTestAgentDef({
      id: 'hydra',
      adapter: 'hydra',
      args: [],
      resume_args: [],
    });

    expect(getAgentResumeStrategy(hydraAgent)).toBe('hydra-session');
    expect(shouldResumeAgentOnSpawn(hydraAgent, true)).toBe(true);
    expect(shouldResumeAgentOnSpawn(hydraAgent, false)).toBe(false);
  });

  it('uses resume args for non-hydra agents that provide them', () => {
    const agent = createTestAgentDef({
      args: ['run'],
      resume_args: ['resume', '--last'],
      skip_permissions_args: ['--dangerous'],
    });

    expect(getAgentResumeStrategy(agent)).toBe('cli-args');
    expect(
      buildAgentSpawnArgs(agent, {
        resumed: true,
        skipPermissions: true,
      }),
    ).toEqual(['resume', '--last', '--dangerous']);
  });

  it('builds Antigravity resume and skip-permission args without an adapter', () => {
    const agent = createTestAgentDef({
      id: 'antigravity',
      command: 'agy',
      args: ['--dangerously-skip-permissions'],
      resume_args: ['-c'],
      resume_strategy: 'cli-args',
      skip_permissions_args: ['--dangerously-skip-permissions'],
    });

    expect(getAgentResumeStrategy(agent)).toBe('cli-args');
    expect(
      buildAgentSpawnArgs(agent, {
        resumed: true,
        skipPermissions: true,
      }),
    ).toEqual(['-c', '--dangerously-skip-permissions']);
  });

  it('falls back to base args for agents without resume support', () => {
    const agent = createTestAgentDef({
      args: ['run'],
      resume_args: [],
      skip_permissions_args: [],
    });

    expect(getAgentResumeStrategy(agent)).toBe('none');
    expect(
      buildAgentSpawnArgs(agent, {
        resumed: true,
        skipPermissions: false,
      }),
    ).toEqual(['run']);
  });

  it('respects an explicit persisted resume strategy', () => {
    const agent = createTestAgentDef({
      id: 'custom',
      adapter: undefined,
      resume_args: [],
      resume_strategy: 'hydra-session',
    });

    expect(getAgentResumeStrategy(agent)).toBe('hydra-session');
    expect(shouldResumeAgentOnSpawn(agent, true)).toBe(true);
  });

  it('recognizes only supported persisted resume strategies', () => {
    expect(isAgentResumeStrategy('none')).toBe(true);
    expect(isAgentResumeStrategy('cli-args')).toBe(true);
    expect(isAgentResumeStrategy('hydra-session')).toBe(true);
    expect(isAgentResumeStrategy('shell')).toBe(false);
    expect(isAgentResumeStrategy(undefined)).toBe(false);
  });

  it('tolerates legacy persisted agent defs that are missing arg arrays', () => {
    const legacyAgent = {
      ...createTestAgentDef(),
      args: undefined,
      resume_args: undefined,
      skip_permissions_args: undefined,
    };

    expect(getAgentResumeStrategy(legacyAgent)).toBe('none');
    expect(
      buildAgentSpawnArgs(legacyAgent, {
        resumed: true,
        skipPermissions: true,
      }),
    ).toEqual([]);
  });

  it('drops malformed legacy arg values before building spawn args', () => {
    const legacyAgent = {
      ...createTestAgentDef(),
      args: ['run', 42],
      resume_args: ['resume', null],
      skip_permissions_args: ['--dangerous', false],
    };

    expect(
      buildAgentSpawnArgs(legacyAgent, {
        resumed: true,
        skipPermissions: true,
      }),
    ).toEqual(['resume', '--dangerous']);
  });

  it('preserves duplicate positional args while still appending missing skip-permission args', () => {
    const agent = createTestAgentDef({
      args: ['--frame-delay-ms', '18', '--footer-top-row', '18'],
      resume_args: [],
      skip_permissions_args: ['--dangerous', '18'],
    });

    expect(
      buildAgentSpawnArgs(agent, {
        resumed: false,
        skipPermissions: true,
      }),
    ).toEqual(['--frame-delay-ms', '18', '--footer-top-row', '18', '--dangerous']);
  });
});

describe('classifyAgentResumeFallback', () => {
  it('matches the exact Claude failure line in a bounded ANSI/redraw frame', () => {
    expect(
      classifyAgentResumeFallback(
        SUPPORTED_CLAUDE,
        createResumeExitFacts({
          lastOutput: [
            '\x1b[1mClaude Code\x1b[22m',
            'status\rNo conversation found to continue',
            'Run claude without --continue to start a new conversation',
            '❯ ',
          ],
        }),
      ),
    ).toEqual({ classifier: 'claude-no-conversation-v1', kind: 'eligible' });
  });

  it.each([
    'No conversation found to continue.',
    'Error: No conversation found to continue',
    'no conversation found to continue',
    'source = "No conversation found to continue"',
    'No conversation found to continue later',
  ])('rejects near-match line %j', (line) => {
    expect(
      classifyAgentResumeFallback(SUPPORTED_CLAUDE, createResumeExitFacts({ lastOutput: [line] })),
    ).toEqual({ kind: 'ineligible', reason: 'no-match' });
  });

  it('requires the signature to remain in the final error frame', () => {
    expect(
      classifyAgentResumeFallback(
        SUPPORTED_CLAUDE,
        createResumeExitFacts({
          lastOutput: [
            'No conversation found to continue',
            'later-1',
            'later-2',
            'later-3',
            'later-4',
            'later-5',
          ],
        }),
      ),
    ).toEqual({ kind: 'ineligible', reason: 'no-match' });
  });

  it('never searches before the final 16 KiB of exit output', () => {
    expect(
      classifyAgentResumeFallback(
        SUPPORTED_CLAUDE,
        createResumeExitFacts({
          lastOutput: [
            'No conversation found to continue',
            'x'.repeat(AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES + 1),
          ],
        }),
      ),
    ).toEqual({ kind: 'ineligible', reason: 'no-match' });

    expect(
      classifyAgentResumeFallback(
        SUPPORTED_CLAUDE,
        createResumeExitFacts({
          lastOutput: [
            'x'.repeat(AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES + 1),
            'No conversation found to continue',
          ],
        }),
      ),
    ).toEqual({ classifier: 'claude-no-conversation-v1', kind: 'eligible' });
  });

  it('bounds a single oversized terminal chunk before matching its suffix', () => {
    expect(
      classifyAgentResumeFallback(
        SUPPORTED_CLAUDE,
        createResumeExitFacts({
          lastOutput: [
            `${'x'.repeat(AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES * 10)}\nNo conversation found to continue`,
          ],
        }),
      ),
    ).toEqual({ classifier: 'claude-no-conversation-v1', kind: 'eligible' });
  });

  it.each([
    [{ resumed: false }, 'not-resumed'],
    [{ exitCode: 0 }, 'successful-exit'],
    [{ exitCode: null, signal: 'spawn_failed' }, 'spawn-failed'],
    [{ signal: 'SIGTERM' }, 'signal'],
  ] as const)('rejects invalid exit metadata with %s', (overrides, reason) => {
    expect(classifyAgentResumeFallback(SUPPORTED_CLAUDE, createResumeExitFacts(overrides))).toEqual(
      { kind: 'ineligible', reason },
    );
  });

  it('requires an explicit supported fallback capability', () => {
    expect(classifyAgentResumeFallback({}, createResumeExitFacts())).toEqual({
      kind: 'ineligible',
      reason: 'unsupported',
    });
    expect(
      classifyAgentResumeFallback(
        {
          resume_failure_classifier: 'claude-no-conversation-v1',
          resume_failure_fallback: 'none',
        },
        createResumeExitFacts(),
      ),
    ).toEqual({ kind: 'ineligible', reason: 'unsupported' });
  });

  it('does not infer trust from a custom Claude display name or executable path', () => {
    const customClaude = createTestAgentDef({
      command: '/usr/local/bin/claude',
      id: 'custom-claude',
      name: 'Claude Code',
    });

    expect(classifyAgentResumeFallback(customClaude, createResumeExitFacts())).toEqual({
      kind: 'ineligible',
      reason: 'unsupported',
    });
  });
});
