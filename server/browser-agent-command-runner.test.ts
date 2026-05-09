import { describe, expect, it, vi } from 'vitest';

import {
  createAgentCommandResult,
  createBrowserAgentCommandResultCache,
  type AgentCommandRequest,
} from './browser-agent-command-results.js';
import { createBrowserAgentCommandRunner } from './browser-agent-command-runner.js';

const CLIENT = { id: 'client-1' } as const;
type TestRunnerOptions = Parameters<typeof createBrowserAgentCommandRunner<typeof CLIENT>>[0];
type TestClaimAgentControl = TestRunnerOptions['claimAgentControl'];

function createRequest(): AgentCommandRequest {
  return {
    agentId: 'agent-1',
    requestId: 'request-1',
    type: 'input',
  };
}

function createRunner(
  overrides: Partial<Parameters<typeof createBrowserAgentCommandRunner<typeof CLIENT>>[0]> = {},
) {
  const agentCommandResults =
    overrides.agentCommandResults ??
    createBrowserAgentCommandResultCache<typeof CLIENT>({
      getClientId: (client) => client.id,
    });

  return {
    agentCommandResults,
    runner: createBrowserAgentCommandRunner<typeof CLIENT>({
      agentCommandResults,
      agentControllerStillOwnsTask: vi.fn(() => true),
      claimAgentControl: vi.fn<TestClaimAgentControl>(() => ({
        ok: true,
        controllerId: 'client-1',
      })),
      releaseAgentControl: vi.fn(),
      sendAgentError: vi.fn(),
      sendMessage: vi.fn(() => true),
      ...overrides,
    }),
  };
}

describe('browser agent command runner', () => {
  it('replays cached request results without executing again', () => {
    const { agentCommandResults, runner } = createRunner();
    const request = createRequest();
    const execute = vi.fn();
    agentCommandResults.cache(CLIENT, createAgentCommandResult(request, true));

    runner.run(CLIENT, 'agent-1', 'write', execute, true, { request });

    expect(execute).not.toHaveBeenCalled();
  });

  it('sends request-tracked failure results when claim control fails', () => {
    const sendAgentError = vi.fn();
    const sendMessage = vi.fn(() => true);
    const onFailure = vi.fn();
    const { runner } = createRunner({
      claimAgentControl: vi.fn<TestClaimAgentControl>(() => ({
        ok: false,
        reason: 'unauthenticated',
      })),
      sendAgentError,
      sendMessage,
    });

    runner.run(CLIENT, 'agent-1', 'write', vi.fn(), true, {
      onFailure,
      request: createRequest(),
    });

    expect(onFailure).toHaveBeenCalledWith('Agent is no longer authenticated.');
    expect(sendMessage).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        accepted: false,
        message: 'Agent is no longer authenticated.',
        type: 'agent-command-result',
      }),
    );
    expect(sendAgentError).not.toHaveBeenCalled();
  });

  it('releases stale agent control and retries when the stale controller no longer owns the task', () => {
    const claimAgentControl = vi
      .fn<TestClaimAgentControl>()
      .mockReturnValueOnce({
        ok: false,
        reason: 'controlled-by-peer',
        controllerId: 'stale-client',
      })
      .mockReturnValueOnce({ ok: true, controllerId: 'client-1' });
    const releaseAgentControl = vi.fn();
    const execute = vi.fn();
    const { runner } = createRunner({
      agentControllerStillOwnsTask: vi.fn(() => false),
      claimAgentControl,
      releaseAgentControl,
    });

    runner.run(CLIENT, 'agent-1', 'write', execute, true, { taskId: 'task-1' });

    expect(releaseAgentControl).toHaveBeenCalledWith('agent-1', 'stale-client');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('sends request-tracked execution failures without falling back to agent-error', () => {
    const sendAgentError = vi.fn();
    const sendMessage = vi.fn(() => true);
    const { runner } = createRunner({
      sendAgentError,
      sendMessage,
    });

    runner.run(
      CLIENT,
      'agent-1',
      'write',
      () => {
        throw new Error('write failed');
      },
      true,
      { request: createRequest() },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        accepted: false,
        message: 'write failed',
      }),
    );
    expect(sendAgentError).not.toHaveBeenCalled();
  });

  it('falls back to agent-error when task-control failure is not request-tracked', () => {
    const sendAgentError = vi.fn();
    const { runner } = createRunner({ sendAgentError });

    runner.sendTaskControlFailure(
      CLIENT,
      {
        agentId: 'agent-1',
      },
      'write',
    );

    expect(sendAgentError).toHaveBeenCalledWith(
      CLIENT,
      'agent-1',
      'write failed',
      expect.any(Error),
    );
  });
});
