import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteHttpHandler } from './http-handler.js';

function request(url: string): IncomingMessage {
  return {
    headers: { host: 'parallel.test' },
    method: 'GET',
    url,
  } as IncomingMessage;
}

function response(): {
  body: () => string;
  response: ServerResponse;
  status: () => number;
} {
  let body = '';
  let status = 0;
  return {
    body: () => body,
    response: {
      end: (value?: string) => {
        body = value ?? '';
      },
      writeHead: (value: number) => {
        status = value;
      },
    } as ServerResponse,
    status: () => status,
  };
}

describe('createRemoteHttpHandler scoped reads', () => {
  it('distinguishes unauthenticated requests from sessions without terminal-read grant', () => {
    const getAgentList = vi.fn(() => []);
    const authorization: Array<boolean | { terminalRead: boolean }> = [
      false,
      { terminalRead: false },
      { terminalRead: true },
    ];
    const handler = createRemoteHttpHandler({
      checkAuth: () => authorization.shift() ?? false,
      getAgentDetail: () => null,
      getAgentList,
      staticDir: '/does-not-matter',
    });

    const unauthenticated = response();
    handler(request('/api/agents'), unauthenticated.response);
    expect(unauthenticated.status()).toBe(401);

    const forbidden = response();
    handler(request('/api/agents'), forbidden.response);
    expect(forbidden.status()).toBe(403);
    expect(JSON.parse(forbidden.body())).toEqual({ error: 'forbidden' });

    const accepted = response();
    handler(request('/api/agents'), accepted.response);
    expect(accepted.status()).toBe(200);
    expect(getAgentList).toHaveBeenCalledOnce();
  });
});
