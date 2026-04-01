import { describe, expect, it, vi } from 'vitest';

import { inspectArenaCompetitor } from './arena-competitors.js';

function createSuccessfulProbe(stdout = '') {
  return vi.fn(async () => ({ ok: true, stderr: '', stdout }));
}

describe('inspectArenaCompetitor', () => {
  it('marks empty commands invalid', async () => {
    const result = await inspectArenaCompetitor('   ');

    expect(result).toEqual({
      executable: null,
      issues: [
        {
          code: 'invalid_empty_command',
          message: 'Competitor command must not be empty.',
          severity: 'error',
        },
      ],
      status: 'invalid_command',
    });
  });

  it('marks missing commands unavailable', async () => {
    const result = await inspectArenaCompetitor('missing-cli --flag', {
      isCommandAvailable: async () => false,
    });

    expect(result).toEqual({
      executable: 'missing-cli',
      issues: [
        {
          code: 'missing_command',
          message: 'Command not found: missing-cli',
          severity: 'error',
        },
      ],
      status: 'missing_command',
    });
  });

  it('requires GEMINI_API_KEY for the gemini preset', async () => {
    const probeCommand = vi.fn();
    const result = await inspectArenaCompetitor('gemini -p "{prompt}" --yolo', {
      env: {},
      isCommandAvailable: async () => true,
      probeCommand,
    });

    expect(result).toEqual({
      executable: 'gemini',
      issues: [
        {
          code: 'missing_gemini_api_key',
          message: 'Gemini requires GEMINI_API_KEY in the app/server environment.',
          severity: 'error',
        },
      ],
      status: 'missing_auth',
    });
    expect(probeCommand).not.toHaveBeenCalled();
  });

  it('accepts claude when CLI auth is available and adds a quiet-execution warning', async () => {
    const probeCommand = createSuccessfulProbe('Logged in as test@example.com');

    const result = await inspectArenaCompetitor(
      'claude -p "{prompt}" --dangerously-skip-permissions',
      {
        env: {},
        isCommandAvailable: async () => true,
        probeCommand,
      },
    );

    expect(result).toEqual({
      executable: 'claude',
      issues: [
        {
          code: 'quiet_noninteractive_output',
          message: 'This CLI can stay quiet until it finishes even when it is still working.',
          severity: 'warning',
        },
      ],
      status: 'ready',
    });
    expect(probeCommand).toHaveBeenCalledWith('claude', ['auth', 'status']);
  });

  it('accepts codex when login status succeeds and adds a quiet-execution warning', async () => {
    const probeCommand = createSuccessfulProbe('Logged in using ChatGPT');

    const result = await inspectArenaCompetitor('codex exec --full-auto "{prompt}"', {
      env: {},
      isCommandAvailable: async () => true,
      probeCommand,
    });

    expect(result).toEqual({
      executable: 'codex',
      issues: [
        {
          code: 'quiet_noninteractive_output',
          message: 'This CLI can stay quiet until it finishes even when it is still working.',
          severity: 'warning',
        },
      ],
      status: 'ready',
    });
    expect(probeCommand).toHaveBeenCalledWith('codex', ['login', 'status']);
  });
});
