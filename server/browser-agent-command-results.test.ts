import { describe, expect, it, vi } from 'vitest';

import {
  createAgentCommandResult,
  createBrowserAgentCommandResultCache,
  getAgentCommandRequest,
  type AgentCommandRequest,
} from './browser-agent-command-results.js';

const CLIENT = { id: 'client-1' } as const;

function createRequest(requestId: string): AgentCommandRequest {
  return {
    agentId: 'agent-1',
    requestId,
    type: 'input',
  };
}

describe('browser agent command result cache', () => {
  it('creates request-tracked command results', () => {
    expect(createAgentCommandResult(createRequest('request-1'), false, 'denied')).toEqual({
      accepted: false,
      agentId: 'agent-1',
      command: 'input',
      message: 'denied',
      requestId: 'request-1',
      type: 'agent-command-result',
    });
  });

  it('extracts command requests only from request-tracked input and resize messages', () => {
    expect(
      getAgentCommandRequest({
        agentId: 'agent-1',
        requestId: 'request-1',
        type: 'resize',
      }),
    ).toEqual({
      agentId: 'agent-1',
      requestId: 'request-1',
      type: 'resize',
    });
    expect(getAgentCommandRequest({ agentId: 'agent-1', type: 'input' })).toBeUndefined();
  });

  it('caches command results by client, command, agent, and request id', () => {
    const cache = createBrowserAgentCommandResultCache<typeof CLIENT>({
      getClientId: (client) => client.id,
    });
    const request = createRequest('request-1');
    const result = createAgentCommandResult(request, true);

    cache.cache(CLIENT, result);

    expect(cache.get(CLIENT, request)).toBe(result);
    expect(cache.get(CLIENT, createRequest('request-2'))).toBeNull();
  });

  it('expires cached results and clears its prune timer', async () => {
    vi.useFakeTimers();
    try {
      const cache = createBrowserAgentCommandResultCache<typeof CLIENT>({
        getClientId: (client) => client.id,
        ttlMs: 100,
      });
      const request = createRequest('request-1');

      cache.cache(CLIENT, createAgentCommandResult(request, true));
      expect(cache.get(CLIENT, request)).not.toBeNull();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(100);

      expect(cache.get(CLIENT, request)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans cached results and pending prune timers during shutdown', () => {
    vi.useFakeTimers();
    try {
      const cache = createBrowserAgentCommandResultCache<typeof CLIENT>({
        getClientId: (client) => client.id,
        ttlMs: 15_000,
      });
      const request = createRequest('request-1');

      cache.cache(CLIENT, createAgentCommandResult(request, true));
      expect(cache.get(CLIENT, request)).not.toBeNull();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      cache.cleanup();

      expect(cache.get(CLIENT, request)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest cached results per client when over capacity', () => {
    const cache = createBrowserAgentCommandResultCache<typeof CLIENT>({
      getClientId: (client) => client.id,
      maxResultsPerClient: 1,
    });
    const firstRequest = createRequest('request-1');
    const secondRequest = createRequest('request-2');

    cache.cache(CLIENT, createAgentCommandResult(firstRequest, true));
    cache.cache(CLIENT, createAgentCommandResult(secondRequest, true));

    expect(cache.get(CLIENT, firstRequest)).toBeNull();
    expect(cache.get(CLIENT, secondRequest)).not.toBeNull();
  });
});
