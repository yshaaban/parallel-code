import { describe, expect, it, vi } from 'vitest';

import {
  coordinateTaskExperienceCleanShutdown,
  rethrowTaskExperienceActivationFailure,
  settleTaskExperienceRuntimeCleanupOwners,
  stopAgentRunnersAfterTaskExperience,
  TaskExperienceRuntimeActivationError,
  TaskExperienceRuntimeCleanupError,
  TaskShellCleanRestartPermitError,
} from './task-experience-runtime-composition.js';

function cleanRestartCandidate(sessionId: string) {
  return {
    candidateId: `candidate-${sessionId}`,
    expectedRecordVersion: 1,
    launchOperationId: `launch-${sessionId}`,
    sessionId,
    sourceGeneration: 0,
    targetGeneration: 1,
    taskId: `task-${sessionId}`,
  };
}

describe('task-experience runtime cleanup', () => {
  it('stops all runners after both snapshots and persists permits before closing owners', async () => {
    const order: string[] = [];
    const candidate = cleanRestartCandidate('shell-1');

    await coordinateTaskExperienceCleanShutdown({
      agentSession: {
        closeWithoutRestartPermit: vi.fn(async () => {
          order.push('agent-direct-close');
        }),
        completeCleanShutdown: vi.fn(async () => {
          order.push('agent-complete');
        }),
        prepareCleanShutdown: vi.fn(async () => {
          order.push('agent-prepare');
        }),
      },
      closeOwners: [
        {
          cleanup: async () => {
            order.push('prompt-close');
          },
          label: 'initial prompt',
        },
      ],
      shell: {
        abortCleanRestartDrain: vi.fn(() => true),
        beginCleanRestartDrain: vi.fn(async () => {
          order.push('shell-prepare');
          return [candidate];
        }),
        close: vi.fn(async () => {
          order.push('shell-close');
        }),
        persistCleanRestartPermit: vi.fn(async () => {
          order.push('shell-permit');
          return { kind: 'prepared' as const };
        }),
      },
      stopAgentRunners: vi.fn(async () => {
        order.push('runner-stop');
      }),
    });

    expect(order).toEqual([
      'agent-prepare',
      'shell-prepare',
      'runner-stop',
      'agent-complete',
      'shell-permit',
      'prompt-close',
      'shell-close',
    ]);
    expect(order).not.toContain('agent-direct-close');
  });

  it('never mints a restart permit when the global runner stop fails', async () => {
    const stopError = new Error('runner stop was not proven');
    const completeAgentSession = vi.fn(async () => undefined);
    const persistShellPermit = vi.fn(async () => ({ kind: 'prepared' as const }));
    const abortShellDrain = vi.fn(() => true);
    const closeAgentSession = vi.fn(async () => undefined);
    const closeShell = vi.fn(async () => undefined);
    const closePrompt = vi.fn(async () => undefined);

    const error = await coordinateTaskExperienceCleanShutdown({
      agentSession: {
        closeWithoutRestartPermit: closeAgentSession,
        completeCleanShutdown: completeAgentSession,
        prepareCleanShutdown: vi.fn(async () => undefined),
      },
      closeOwners: [{ cleanup: closePrompt, label: 'initial prompt' }],
      shell: {
        abortCleanRestartDrain: abortShellDrain,
        beginCleanRestartDrain: vi.fn(async () => [cleanRestartCandidate('shell-1')]),
        close: closeShell,
        persistCleanRestartPermit: persistShellPermit,
      },
      stopAgentRunners: vi.fn(async () => Promise.reject(stopError)),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TaskExperienceRuntimeCleanupError);
    expect((error as TaskExperienceRuntimeCleanupError).failures).toEqual([
      { error: stopError, label: 'agent runner' },
    ]);
    expect(completeAgentSession).not.toHaveBeenCalled();
    expect(persistShellPermit).not.toHaveBeenCalled();
    expect(abortShellDrain).toHaveBeenCalledOnce();
    expect(closeAgentSession).toHaveBeenCalledOnce();
    expect(closePrompt).toHaveBeenCalledOnce();
    expect(closeShell).toHaveBeenCalledOnce();
  });

  it('attempts every shell permit and reports an unavailable result as a labeled failure', async () => {
    const candidates = [cleanRestartCandidate('shell-1'), cleanRestartCandidate('shell-2')];
    const persistShellPermit = vi.fn(async (candidate: (typeof candidates)[number]) =>
      candidate.sessionId === 'shell-1'
        ? { kind: 'unavailable' as const, reason: 'stop-not-proven' }
        : { kind: 'prepared' as const },
    );

    const error = await coordinateTaskExperienceCleanShutdown({
      agentSession: {
        closeWithoutRestartPermit: vi.fn(async () => undefined),
        completeCleanShutdown: vi.fn(async () => undefined),
        prepareCleanShutdown: vi.fn(async () => undefined),
      },
      closeOwners: [],
      shell: {
        abortCleanRestartDrain: vi.fn(() => true),
        beginCleanRestartDrain: vi.fn(async () => candidates),
        close: vi.fn(async () => undefined),
        persistCleanRestartPermit: persistShellPermit,
      },
      stopAgentRunners: vi.fn(async () => undefined),
    }).catch((caught: unknown) => caught);

    expect(persistShellPermit).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(TaskExperienceRuntimeCleanupError);
    const [failure] = (error as TaskExperienceRuntimeCleanupError).failures;
    expect(failure?.label).toBe('shell clean-restart permit');
    expect(failure?.error).toBeInstanceOf(TaskShellCleanRestartPermitError);
    expect((failure?.error as TaskShellCleanRestartPermitError).errors).toEqual([
      {
        candidate: candidates[0],
        result: { kind: 'unavailable', reason: 'stop-not-proven' },
      },
    ]);
  });

  it('keeps the agent journal open and retries a failed agent permit completion', async () => {
    const completionError = new Error('agent permit fsync failed');
    const completeAgentSession = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(completionError)
      .mockResolvedValueOnce(undefined);
    const closeAgentSession = vi.fn(async () => undefined);
    const closeShell = vi.fn(async () => undefined);
    const dependencies = {
      agentSession: {
        closeWithoutRestartPermit: closeAgentSession,
        completeCleanShutdown: completeAgentSession,
        prepareCleanShutdown: vi.fn(async () => undefined),
      },
      closeOwners: [],
      shell: {
        abortCleanRestartDrain: vi.fn(() => true),
        beginCleanRestartDrain: vi.fn(async () => []),
        close: closeShell,
        persistCleanRestartPermit: vi.fn(async () => ({ kind: 'prepared' as const })),
      },
      stopAgentRunners: vi.fn(async () => undefined),
    };

    const firstError = await coordinateTaskExperienceCleanShutdown(dependencies).catch(
      (caught: unknown) => caught,
    );
    expect((firstError as TaskExperienceRuntimeCleanupError).failures).toEqual([
      { error: completionError, label: 'agent clean-shutdown completion' },
    ]);
    expect(closeAgentSession).not.toHaveBeenCalled();

    await expect(coordinateTaskExperienceCleanShutdown(dependencies)).resolves.toBeUndefined();
    expect(completeAgentSession).toHaveBeenCalledTimes(2);
    expect(closeAgentSession).not.toHaveBeenCalled();
    expect(closeShell).toHaveBeenCalledTimes(2);
  });

  it('keeps the shell journal open and retries only the remaining partial permit', async () => {
    const first = cleanRestartCandidate('shell-1');
    const second = cleanRestartCandidate('shell-2');
    let remaining = [first, second];
    let secondAttempt = 0;
    const persistShellPermit = vi.fn(async (candidate: typeof first) => {
      if (candidate.sessionId === first.sessionId) {
        remaining = remaining.filter((item) => item.sessionId !== candidate.sessionId);
        return { kind: 'prepared' as const };
      }
      secondAttempt += 1;
      if (secondAttempt === 1) {
        return { kind: 'unavailable' as const, reason: 'journal-unavailable' };
      }
      remaining = remaining.filter((item) => item.sessionId !== candidate.sessionId);
      return { kind: 'prepared' as const };
    });
    const closeShell = vi.fn(async () => undefined);
    const dependencies = {
      agentSession: {
        closeWithoutRestartPermit: vi.fn(async () => undefined),
        completeCleanShutdown: vi.fn(async () => undefined),
        prepareCleanShutdown: vi.fn(async () => undefined),
      },
      closeOwners: [],
      shell: {
        abortCleanRestartDrain: vi.fn(() => true),
        beginCleanRestartDrain: vi.fn(async () => [...remaining]),
        close: closeShell,
        persistCleanRestartPermit: persistShellPermit,
      },
      stopAgentRunners: vi.fn(async () => undefined),
    };

    await expect(coordinateTaskExperienceCleanShutdown(dependencies)).rejects.toBeInstanceOf(
      TaskExperienceRuntimeCleanupError,
    );
    expect(persistShellPermit).toHaveBeenCalledTimes(2);
    expect(closeShell).not.toHaveBeenCalled();
    expect(remaining.map((candidate) => candidate.sessionId)).toEqual(['shell-2']);

    await expect(coordinateTaskExperienceCleanShutdown(dependencies)).resolves.toBeUndefined();
    expect(persistShellPermit).toHaveBeenCalledTimes(3);
    expect(persistShellPermit.mock.calls[2]?.[0].sessionId).toBe('shell-2');
    expect(closeShell).toHaveBeenCalledOnce();
  });

  it('runs the host fallback only after task-experience cleanup settles, including failure', async () => {
    let rejectTaskExperience: (error: unknown) => void = () => {};
    const taskExperienceError = new Error('task experience failed');
    const taskExperienceCleanup = new Promise<void>((_resolve, reject) => {
      rejectTaskExperience = reject;
    });
    const stopAgentRunners = vi.fn(async () => undefined);
    const fallback = stopAgentRunnersAfterTaskExperience(taskExperienceCleanup, stopAgentRunners);

    expect(stopAgentRunners).not.toHaveBeenCalled();
    rejectTaskExperience(taskExperienceError);
    await expect(fallback).resolves.toBeUndefined();
    expect(stopAgentRunners).toHaveBeenCalledOnce();
    await expect(taskExperienceCleanup).rejects.toBe(taskExperienceError);
  });

  it('settles every independent owner and preserves each labeled failure', async () => {
    const initialPromptError = new Error('initial prompt close failed');
    const journalError = new Error('journal close failed');
    const closeAgentSession = vi.fn(async () => undefined);
    const closeShellSession = vi.fn(async () => undefined);

    const cleanup = settleTaskExperienceRuntimeCleanupOwners([
      {
        cleanup: () => {
          throw initialPromptError;
        },
        label: 'initial prompt',
      },
      { cleanup: closeAgentSession, label: 'agent session' },
      { cleanup: closeShellSession, label: 'shell session' },
      { cleanup: async () => Promise.reject(journalError), label: 'creation journal' },
    ]);

    const error = await cleanup.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskExperienceRuntimeCleanupError);
    expect((error as TaskExperienceRuntimeCleanupError).failures).toEqual([
      { error: initialPromptError, label: 'initial prompt' },
      { error: journalError, label: 'creation journal' },
    ]);
    expect(closeAgentSession).toHaveBeenCalledOnce();
    expect(closeShellSession).toHaveBeenCalledOnce();
  });

  it('preserves activation and rollback failures together', async () => {
    const activationError = new Error('activation failed');
    const cleanupError = new Error('cleanup failed');

    const error = await rethrowTaskExperienceActivationFailure(activationError, () =>
      Promise.reject(cleanupError),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TaskExperienceRuntimeActivationError);
    expect(error).toMatchObject({ activationError, cleanupError });
    expect((error as TaskExperienceRuntimeActivationError).errors).toEqual([
      activationError,
      cleanupError,
    ]);
  });

  it('retains failed activation cleanup ownership for a successful retry', async () => {
    const activationError = new Error('activation failed');
    const cleanupError = new Error('cleanup failed once');
    let cleanupAttempts = 0;
    const cleanup = async (): Promise<void> => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw cleanupError;
    };

    const error = await rethrowTaskExperienceActivationFailure(activationError, cleanup).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TaskExperienceRuntimeActivationError);

    await Promise.all([
      (error as TaskExperienceRuntimeActivationError).retryCleanup(),
      (error as TaskExperienceRuntimeActivationError).retryCleanup(),
    ]);
    expect(cleanupAttempts).toBe(2);
  });

  it('rethrows the original activation failure when rollback succeeds', async () => {
    const activationError = new Error('activation failed');

    await expect(
      rethrowTaskExperienceActivationFailure(activationError, () => Promise.resolve()),
    ).rejects.toBe(activationError);
  });
});
