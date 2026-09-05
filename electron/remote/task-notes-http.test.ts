import { describe, expect, it } from 'vitest';

import type { TaskNotesRequestError } from '../../src/domain/task-notes.js';
import type { RemoteCommandGatewayErrorCode } from '../ipc/remote-command-gateway.js';
import {
  mapTaskNotesHttpResponse,
  mapTaskNotesRemoteCommandHttpOutcome,
  TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS,
} from './task-notes-http.js';

describe('task notes shared HTTP response edge', () => {
  it.each([
    ['bad-request', 400],
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['operation-identity-rejected', 409],
    ['payload-too-large', 413],
    ['unsupported-media-type', 415],
    ['rate-limited', 429],
    ['capacity-exhausted', 503],
    ['persistence-unavailable', 503],
    ['internal-error', 500],
  ] as const)('maps %s to HTTP %i without changing the wire envelope', (code, status) => {
    const error: TaskNotesRequestError =
      code === 'rate-limited' || code === 'capacity-exhausted'
        ? { code, retryAfterMs: 1_250 }
        : code === 'persistence-unavailable' || code === 'internal-error'
          ? { code, retryable: true }
          : { code };
    const response = { ok: false as const, error };

    expect(mapTaskNotesHttpResponse('get', response)).toEqual({
      body: response,
      ...(code === 'rate-limited' || code === 'capacity-exhausted' ? { retryAfterMs: 1_250 } : {}),
      status,
    });
  });

  it('keeps expected domain states at 200 and exposes bounded retry advice', () => {
    const response = {
      ok: true as const,
      result: { kind: 'task-state-unavailable' as const, retryAfterMs: 500 },
    };

    expect(mapTaskNotesHttpResponse('get', response)).toEqual({
      body: response,
      retryAfterMs: 500,
      status: 200,
    });
  });

  it('fails closed on malformed and method-crossed backend envelopes', () => {
    const updateOnly = {
      ok: true,
      result: {
        kind: 'host-state-recovery-required',
        replayed: false,
        retention: 'held',
      },
    };
    const expected = {
      body: { ok: false, error: { code: 'internal-error', retryable: false } },
      status: 500,
    };

    expect(mapTaskNotesHttpResponse('issue', updateOnly)).toEqual(expected);
    expect(mapTaskNotesHttpResponse('update', { ok: true, result: { kind: 'completed' } })).toEqual(
      expected,
    );
    expect(mapTaskNotesHttpResponse('get', { ok: true, result: { kind: 'not-found' } })).toEqual(
      expected,
    );
  });

  it.each([
    ['bad-request', 'bad-request', 400, undefined],
    ['unauthenticated', 'unauthenticated', 401, undefined],
    ['csrf-rejected', 'forbidden', 403, undefined],
    ['forbidden', 'forbidden', 403, undefined],
    ['origin-rejected', 'forbidden', 403, undefined],
    ['secure-transport-required', 'forbidden', 403, undefined],
    ['untrusted-peer', 'forbidden', 403, undefined],
    ['unsupported-command', 'forbidden', 403, undefined],
    ['payload-too-large', 'payload-too-large', 413, undefined],
    ['rate-limited', 'rate-limited', 429, 1_250],
    ['gateway-draining', 'capacity-exhausted', 503, 250],
    ['request-aborted', 'internal-error', 500, undefined],
    ['internal-error', 'internal-error', 500, undefined],
  ] as const)(
    'normalizes gateway %s without leaking transport policy',
    (gatewayCode, notesCode, status, expectedRetryAfterMs) => {
      const result = mapTaskNotesRemoteCommandHttpOutcome('get', {
        kind: 'gateway',
        result: {
          error: {
            code: gatewayCode as RemoteCommandGatewayErrorCode,
            ...(gatewayCode === 'rate-limited' ? { retryAfterMs: 1_250 } : {}),
          },
          ok: false,
        },
      });

      expect(result.status).toBe(status);
      expect(result.retryAfterMs).toBe(expectedRetryAfterMs);
      expect(result.body).toMatchObject({ ok: false, error: { code: notesCode } });
      if (gatewayCode === 'request-aborted') {
        expect(result.body).toEqual({
          ok: false,
          error: { code: 'internal-error', retryable: true },
        });
      }
      if (gatewayCode === 'internal-error') {
        expect(result.body).toEqual({
          ok: false,
          error: { code: 'internal-error', retryable: false },
        });
      }
    },
  );

  it.each([
    ['bad-request', 'bad-request', 400],
    ['internal-error', 'internal-error', 500],
    ['payload-too-large', 'payload-too-large', 413],
    ['unsupported-media-type', 'unsupported-media-type', 415],
  ] as const)('normalizes HTTP-edge %s as a direct Notes error', (edgeCode, notesCode, status) => {
    expect(
      mapTaskNotesRemoteCommandHttpOutcome('update', {
        code: edgeCode,
        kind: 'edge-error',
      }),
    ).toMatchObject({
      body: { ok: false, error: { code: notesCode } },
      status,
    });
  });

  it('registers exactly the three Notes methods', () => {
    expect(Object.keys(TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS).sort()).toEqual([
      'task-notes.get',
      'task-notes.issue',
      'task-notes.update',
    ]);
  });
});
