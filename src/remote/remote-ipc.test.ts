import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const authMocks = vi.hoisted(() => ({
  getRemoteCsrfToken: vi.fn<() => string | null>(),
  getToken: vi.fn<() => string | null>(),
  initializeRemoteAuthSession: vi.fn<() => Promise<'legacy' | 'scoped'>>(),
}));

vi.mock('./auth', () => ({
  getRemoteCsrfToken: authMocks.getRemoteCsrfToken,
  getToken: authMocks.getToken,
  initializeRemoteAuthSession: authMocks.initializeRemoteAuthSession,
}));

vi.mock('./client-id', () => ({
  getRemoteClientId: vi.fn(() => 'remote-mobile-client'),
}));

import {
  acquireRemoteTaskCommandLease,
  remoteTaskCatalogFacade,
  remoteTaskNotesTransport,
  writeRemoteAgent,
} from './remote-ipc';

const TASK_NOTES_TOKEN = Buffer.alloc(32, 0x31).toString('base64url');
const TASK_NOTES_OPERATION_ID = Buffer.alloc(16, 0x32).toString('base64url');

describe('remote ipc auth transport', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    authMocks.getToken.mockReset();
    authMocks.getRemoteCsrfToken.mockReset();
    authMocks.getRemoteCsrfToken.mockReturnValue(null);
    authMocks.initializeRemoteAuthSession.mockReset();
    authMocks.initializeRemoteAuthSession.mockResolvedValue('legacy');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            acquired: true,
            action: 'type in the terminal',
            changed: true,
            controllerId: 'remote-mobile-client',
            taskId: 'task-1',
            version: 1,
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses same-origin credentials when the auth token is absent', async () => {
    authMocks.getToken.mockReturnValue(null);

    await expect(
      acquireRemoteTaskCommandLease({
        action: 'type in the terminal',
        clientId: 'remote-mobile-client',
        ownerId: 'remote-owner',
        taskId: 'task-1',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        acquired: true,
        taskId: 'task-1',
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ipc/' + encodeURIComponent(IPC.AcquireTaskCommandLease),
      expect.objectContaining({
        credentials: 'same-origin',
        headers: expect.not.objectContaining({
          Authorization: expect.any(String),
        }),
      }),
    );
  });

  it('adds bearer auth when a bootstrap token is still available', async () => {
    authMocks.getToken.mockReturnValue('bootstrap-token');

    await acquireRemoteTaskCommandLease({
      action: 'type in the terminal',
      clientId: 'remote-mobile-client',
      ownerId: 'remote-owner',
      taskId: 'task-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ipc/' + encodeURIComponent(IPC.AcquireTaskCommandLease),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer bootstrap-token',
        }),
      }),
    );
  });

  it('accepts empty success payloads for write operations', async () => {
    authMocks.getToken.mockReturnValue(null);
    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(
      writeRemoteAgent({
        agentId: 'agent-1',
        data: 'pwd\r',
        taskId: 'task-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('uses scoped commands for Notes, forwards abort signals, and preserves domain errors', async () => {
    authMocks.getRemoteCsrfToken.mockReturnValue('notes-csrf');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: 'forbidden' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 403,
      }),
    );
    const abort = new AbortController();
    await expect(remoteTaskNotesTransport.get({ taskId: 'task-1' }, abort.signal)).resolves.toEqual(
      {
        ok: false,
        error: { code: 'forbidden' },
      },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commands/task-notes.get',
      expect.objectContaining({
        body: JSON.stringify({ taskId: 'task-1' }),
        headers: expect.objectContaining({ 'X-Parallel-Code-CSRF': 'notes-csrf' }),
        signal: abort.signal,
      }),
    );
  });

  it('keeps Notes operation capabilities in the guarded scoped body', async () => {
    authMocks.getToken.mockReturnValue('legacy-bootstrap-token');
    authMocks.getRemoteCsrfToken.mockReturnValue('notes-csrf');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            kind: 'issued',
            operation: {
              admitUntil: '2026-08-04T08:00:00.000Z',
              operationCapability: TASK_NOTES_TOKEN,
              operationId: TASK_NOTES_OPERATION_ID,
              replayUntil: '2026-08-04T09:00:00.000Z',
            },
          },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );

    await expect(
      remoteTaskNotesTransport.issue({
        acknowledgedOperations: [
          {
            operationCapability: TASK_NOTES_TOKEN,
            operationId: TASK_NOTES_OPERATION_ID,
          },
        ],
        taskId: 'task-1',
        taskIncarnation: TASK_NOTES_TOKEN,
      }),
    ).resolves.toMatchObject({ ok: true, result: { kind: 'issued' } });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commands/task-notes.issue',
      expect.objectContaining({
        body: expect.stringContaining(TASK_NOTES_TOKEN),
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
          'X-Parallel-Code-Client-Id': expect.anything(),
        }),
      }),
    );
  });

  it('rejects malformed Notes requests before authentication or fetch', async () => {
    await expect(
      remoteTaskNotesTransport.get({ taskId: '__proto__' }, new AbortController().signal),
    ).rejects.toThrow('Invalid task-notes get request');

    expect(authMocks.initializeRemoteAuthSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts every exact direct Notes error status without losing recovery fields', async () => {
    authMocks.getRemoteCsrfToken.mockReturnValue('notes-csrf');
    const cases = [
      [400, { code: 'bad-request' }],
      [401, { code: 'unauthenticated' }],
      [403, { code: 'forbidden' }],
      [409, { code: 'operation-identity-rejected' }],
      [413, { code: 'payload-too-large' }],
      [415, { code: 'unsupported-media-type' }],
      [429, { code: 'rate-limited', retryAfterMs: 1_250 }],
      [500, { code: 'internal-error', retryable: false }],
      [503, { code: 'capacity-exhausted', retryAfterMs: 500 }],
      [503, { code: 'persistence-unavailable', retryable: true }],
    ] as const;

    for (const [status, error] of cases) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error }), {
          headers: { 'Content-Type': 'application/json' },
          status,
        }),
      );
      await expect(
        remoteTaskNotesTransport.get({ taskId: 'task-1' }, new AbortController().signal),
      ).resolves.toEqual({ ok: false, error });
    }
  });

  it('fails closed on malformed or method-crossed Notes results', async () => {
    authMocks.getRemoteCsrfToken.mockReturnValue('notes-csrf');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { kind: 'issued' },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );
    await expect(
      remoteTaskNotesTransport.issue({
        taskId: 'task-1',
        taskIncarnation: TASK_NOTES_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { kind: 'not-found' },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );
    await expect(
      remoteTaskNotesTransport.update({
        baseContentVersion: TASK_NOTES_TOKEN,
        notes: 'handoff',
        operationCapability: TASK_NOTES_TOKEN,
        operationId: TASK_NOTES_OPERATION_ID,
        taskId: 'task-1',
        taskIncarnation: TASK_NOTES_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('rejects retired, unnormalized, and status-mismatched Notes envelopes', async () => {
    authMocks.getRemoteCsrfToken.mockReturnValue('notes-csrf');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { ok: false, error: { code: 'forbidden' } },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      ),
    );
    await expect(
      remoteTaskNotesTransport.get({ taskId: 'task-1' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: 'forbidden' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );
    await expect(
      remoteTaskNotesTransport.get({ taskId: 'task-1' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: 'csrf-rejected' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 403,
      }),
    );
    await expect(
      remoteTaskNotesTransport.get({ taskId: 'task-1' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('uses the scoped command envelope with in-memory CSRF for catalog reads', async () => {
    authMocks.getRemoteCsrfToken.mockReturnValue('csrf-token');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { kind: 'unavailable' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(remoteTaskCatalogFacade.getManifest()).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commands/task-catalog.get-manifest',
      expect.objectContaining({
        body: '{}',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'X-Parallel-Code-CSRF': 'csrf-token',
        }),
        method: 'POST',
      }),
    );
  });

  it('fails closed on malformed scoped responses', async () => {
    authMocks.getRemoteCsrfToken.mockReturnValue('csrf-token');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { kind: 'found', value: 'unsafe' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(remoteTaskCatalogFacade.getManifest()).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });
});
