import { describe, expect, it, vi } from 'vitest';

import { isRecord } from '../../src/lib/type-guards.js';
import {
  createRemoteCommandGateway,
  getRemoteCommandPolicy,
  isRemoteCommandName,
  type RemoteCommandAuthentication,
  type RemoteCommandExecutionContext,
  type RemoteCommandRegistration,
  type RemoteCommandRegistrationTable,
  type RemoteGrant,
} from './remote-command-gateway.js';

function authentication(
  overrides: Partial<RemoteCommandAuthentication> = {},
): RemoteCommandAuthentication {
  return {
    authEpoch: 'auth-epoch-1',
    authenticationSessionGeneration: 'session-generation-1',
    csrfValidated: true,
    directPeerValidated: true,
    expiresAt: 20_000,
    grants: new Set<RemoteGrant>([
      'catalog:read',
      'notes:read',
      'notes:write',
      'task:create',
      'terminal:control',
      'terminal:read',
    ]),
    kind: 'browser-session',
    originValidated: true,
    principalId: 'workspace-principal-1',
    sourceId: 'browser-client-1',
    transportSecure: true,
    ...overrides,
  };
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}

function registration(
  execute: (context: RemoteCommandExecutionContext, request: Record<string, unknown>) => unknown,
  requestKeys: readonly string[] = [],
): RemoteCommandRegistration {
  return {
    execute: (context, request) => execute(context, request as Record<string, unknown>),
    isRequest: (value): value is Record<string, unknown> => exactKeys(value, requestKeys),
    isResult: (value): value is { accepted: boolean } =>
      exactKeys(value, ['accepted']) && typeof value.accepted === 'boolean',
  };
}

function catalogRegistration(): RemoteCommandRegistration {
  return registration(() => ({ accepted: true }));
}

describe('RemoteCommandGateway', () => {
  it('dispatches only registered allowlisted commands and keeps identity out of request authority', async () => {
    const execute = vi.fn((context: RemoteCommandExecutionContext) => ({
      accepted: context.principalId === 'workspace-principal-1',
    }));
    const gateway = createRemoteCommandGateway(
      {
        'task-catalog.get-manifest': registration(execute, ['principalId']),
      },
      { now: () => 10_000 },
    );

    await expect(
      gateway.dispatch('task-catalog.get-manifest', authentication(), {
        principalId: 'attacker-controlled',
      }),
    ).resolves.toEqual({ ok: true, result: { accepted: true } });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        authEpoch: 'auth-epoch-1',
        principalId: 'workspace-principal-1',
        sourceId: 'browser-client-1',
      }),
      { principalId: 'attacker-controlled' },
    );
    await expect(gateway.dispatch('local-admin.reconcile', authentication(), {})).resolves.toEqual({
      ok: false,
      error: { code: 'unsupported-command' },
    });
    await expect(gateway.dispatch('task-catalog.get-page', authentication(), {})).resolves.toEqual({
      ok: false,
      error: { code: 'unsupported-command' },
    });
  });

  it('fails closed for insecure, untrusted, stale, originless, CSRF-less, and ungranted contexts', async () => {
    const gateway = createRemoteCommandGateway(
      { 'task-catalog.get-manifest': catalogRegistration() },
      { now: () => 10_000 },
    );
    const cases: Array<[Partial<RemoteCommandAuthentication>, string]> = [
      [{ transportSecure: false }, 'secure-transport-required'],
      [{ directPeerValidated: false }, 'untrusted-peer'],
      [{ originValidated: false }, 'origin-rejected'],
      [{ csrfValidated: false }, 'csrf-rejected'],
      [{ expiresAt: 10_000 }, 'unauthenticated'],
      [{ principalId: '../private/path' }, 'unauthenticated'],
      [{ grants: new Set<RemoteGrant>() }, 'forbidden'],
    ];

    for (const [overrides, code] of cases) {
      await expect(
        gateway.dispatch('task-catalog.get-manifest', authentication(overrides), {}),
      ).resolves.toEqual({ ok: false, error: { code } });
    }
    await expect(gateway.dispatch('task-catalog.get-manifest', null, {})).resolves.toEqual({
      ok: false,
      error: { code: 'unauthenticated' },
    });
  });

  it('allows a trusted local principal without pretending it is a remote secure session', async () => {
    const gateway = createRemoteCommandGateway(
      { 'task-catalog.get-manifest': catalogRegistration() },
      { now: () => 10_000 },
    );
    const local = authentication({
      csrfValidated: undefined,
      directPeerValidated: undefined,
      kind: 'trusted-local',
      originValidated: undefined,
      transportSecure: undefined,
    });
    await expect(gateway.dispatch('task-catalog.get-manifest', local, {})).resolves.toEqual({
      ok: true,
      result: { accepted: true },
    });
  });

  it('enforces the fixed one-MiB parsed-body ceiling and exact request/response guards', async () => {
    const onInternalError = vi.fn();
    const gateway = createRemoteCommandGateway(
      {
        'task-catalog.get-manifest': catalogRegistration(),
        'task-catalog.get-page': {
          execute: () => ({ unsafe: true }),
          isRequest: (value): value is Record<string, never> => exactKeys(value, []),
          isResult: (value): value is { accepted: boolean } =>
            exactKeys(value, ['accepted']) && typeof value.accepted === 'boolean',
        },
      },
      { now: () => 10_000, onInternalError },
    );

    await expect(
      gateway.dispatch('task-catalog.get-manifest', authentication(), { extra: true }),
    ).resolves.toEqual({ ok: false, error: { code: 'bad-request' } });
    await expect(
      gateway.dispatch('task-catalog.get-manifest', authentication(), {
        payload: 'x'.repeat(1024 * 1024),
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'payload-too-large' } });
    await expect(gateway.dispatch('task-catalog.get-page', authentication(), {})).resolves.toEqual({
      ok: false,
      error: { code: 'internal-error' },
    });
    expect(onInternalError).toHaveBeenCalledWith('task-catalog.get-page', expect.any(Error));
    expect(() => createRemoteCommandGateway({}, { maxBodyBytes: 1024 * 1024 + 1 })).toThrow(
      /1 MiB/u,
    );
  });

  it('keeps mutations dark by default and exposes only currently usable capabilities', async () => {
    const registrations: RemoteCommandRegistrationTable = {
      'task-catalog.get-manifest': catalogRegistration(),
      'task-notes.update': registration(() => ({ accepted: true })),
    };
    const gateway = createRemoteCommandGateway(registrations, { now: () => 10_000 });

    expect(gateway.getCapabilities(authentication())).toEqual({
      commands: ['task-catalog.get-manifest'],
      mutationAdmission: 'draining',
    });
    await expect(gateway.dispatch('task-notes.update', authentication(), {})).resolves.toEqual({
      ok: false,
      error: { code: 'gateway-draining' },
    });

    gateway.openMutationAdmission();
    expect(gateway.getCapabilities(authentication())).toEqual({
      commands: ['task-catalog.get-manifest', 'task-notes.update'],
      mutationAdmission: 'open',
    });
    await expect(gateway.dispatch('task-notes.update', authentication(), {})).resolves.toEqual({
      ok: true,
      result: { accepted: true },
    });
  });

  it('checks registration availability in capability advertisement and final dispatch', async () => {
    let available = false;
    const execute = vi.fn(() => ({ accepted: true }));
    const write = registration(execute);
    write.isAvailable = () => available;
    const gateway = createRemoteCommandGateway(
      { 'task-notes.update': write },
      { mutationAdmissionInitiallyOpen: true, now: () => 10_000 },
    );

    expect(gateway.getCapabilities(authentication()).commands).toEqual([]);
    await expect(gateway.dispatch('task-notes.update', authentication(), {})).resolves.toEqual({
      ok: false,
      error: { code: 'unsupported-command' },
    });
    expect(execute).not.toHaveBeenCalled();

    available = true;
    expect(gateway.getCapabilities(authentication()).commands).toEqual(['task-notes.update']);
    await expect(gateway.dispatch('task-notes.update', authentication(), {})).resolves.toEqual({
      ok: true,
      result: { accepted: true },
    });
  });

  it('bounds global/principal mutation concurrency and its waiting queue', async () => {
    const releases: Array<() => void> = [];
    const execute = vi.fn(
      () =>
        new Promise<{ accepted: boolean }>((resolve) => {
          releases.push(() => resolve({ accepted: true }));
        }),
    );
    const gateway = createRemoteCommandGateway(
      { 'task-notes.update': registration(execute) },
      {
        maxActiveMutations: 1,
        maxActiveMutationsPerPrincipal: 1,
        maxQueuedMutations: 1,
        mutationAdmissionInitiallyOpen: true,
        now: () => 10_000,
      },
    );

    const first = gateway.dispatch('task-notes.update', authentication(), {});
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const second = gateway.dispatch('task-notes.update', authentication(), {});
    const third = gateway.dispatch('task-notes.update', authentication(), {});
    await expect(third).resolves.toEqual({
      ok: false,
      error: { code: 'rate-limited', retryAfterMs: 250 },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await expect(first).resolves.toEqual({ ok: true, result: { accepted: true } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await expect(second).resolves.toEqual({ ok: true, result: { accepted: true } });
  });

  it('revalidates queued authentication after acquiring a mutation slot', async () => {
    let current = true;
    const releases: Array<() => void> = [];
    const execute = vi.fn(
      () =>
        new Promise<{ accepted: boolean }>((resolve) => {
          releases.push(() => resolve({ accepted: true }));
        }),
    );
    const gateway = createRemoteCommandGateway(
      { 'task-notes.update': registration(execute) },
      {
        isAuthenticationCurrent: () => current,
        maxActiveMutations: 1,
        maxActiveMutationsPerPrincipal: 1,
        mutationAdmissionInitiallyOpen: true,
        now: () => 10_000,
      },
    );

    const first = gateway.dispatch('task-notes.update', authentication(), {});
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const queued = gateway.dispatch('task-notes.update', authentication(), {});
    current = false;
    releases.shift()?.();

    await expect(first).resolves.toEqual({ ok: true, result: { accepted: true } });
    await expect(queued).resolves.toEqual({
      ok: false,
      error: { code: 'unauthenticated' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('closes queued admission and waits for tracked mutations during graceful drain', async () => {
    let releaseFirst: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<{ accepted: boolean }>((resolve) => {
          releaseFirst = () => resolve({ accepted: true });
        }),
    );
    const gateway = createRemoteCommandGateway(
      { 'task-notes.update': registration(execute) },
      {
        maxActiveMutations: 1,
        maxActiveMutationsPerPrincipal: 1,
        mutationAdmissionInitiallyOpen: true,
        now: () => 10_000,
      },
    );
    const first = gateway.dispatch('task-notes.update', authentication(), {});
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const queued = gateway.dispatch('task-notes.update', authentication(), {});
    const drain = gateway.closeAndDrainMutations();

    await expect(queued).resolves.toEqual({
      ok: false,
      error: { code: 'gateway-draining' },
    });
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(() => gateway.openMutationAdmission()).toThrow(/drain/u);

    releaseFirst?.();
    await expect(first).resolves.toEqual({ ok: true, result: { accepted: true } });
    await drain;
    expect(drained).toBe(true);
    gateway.openMutationAdmission();
  });

  it('removes an aborted queued request without consuming a later slot', async () => {
    const releases: Array<() => void> = [];
    const gateway = createRemoteCommandGateway(
      {
        'task-notes.update': registration(
          () =>
            new Promise<{ accepted: boolean }>((resolve) => {
              releases.push(() => resolve({ accepted: true }));
            }),
        ),
      },
      {
        maxActiveMutations: 1,
        maxActiveMutationsPerPrincipal: 1,
        mutationAdmissionInitiallyOpen: true,
        now: () => 10_000,
      },
    );
    const first = gateway.dispatch('task-notes.update', authentication(), {});
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const controller = new AbortController();
    const aborted = gateway.dispatch('task-notes.update', authentication(), {}, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toEqual({
      ok: false,
      error: { code: 'request-aborted' },
    });
    releases.shift()?.();
    await first;
  });

  it('keeps the static policy exhaustive and excludes local repair authority', () => {
    expect(isRemoteCommandName('task-creation.create')).toBe(true);
    expect(isRemoteCommandName('task-removal.reconcile')).toBe(false);
    expect(isRemoteCommandName('failed-creation.keep-current-branch')).toBe(false);
    expect(getRemoteCommandPolicy('task-creation.create')).toEqual({
      effect: 'code-execution',
      grants: ['task:create'],
    });
    expect(getRemoteCommandPolicy('terminal.input')).toEqual({
      effect: 'code-execution',
      grants: ['terminal:control'],
    });
    expect(() =>
      createRemoteCommandGateway({
        ...({ 'local-admin.reconcile': catalogRegistration() } as RemoteCommandRegistrationTable),
      }),
    ).toThrow(/not allowlisted/u);
  });
});
