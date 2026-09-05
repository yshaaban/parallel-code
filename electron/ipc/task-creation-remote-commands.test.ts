import { describe, expect, it, vi } from 'vitest';

import {
  REMOTE_TASK_CREATION_CAPABILITY_DARK,
  type TaskCreationIntent,
} from '../../src/domain/task-creation.js';
import type {
  TaskCreationOperationCapability,
  TaskCreationOperationId,
} from '../../src/domain/task-creation-ticket.js';
import type {
  RetryTaskShellSessionOperationResult,
  TaskShellSessionOperationReplay,
} from '../../src/domain/task-shell-session-operation.js';
import {
  createRemoteCommandGateway,
  type RemoteCommandAuthentication,
  type RemoteCommandName,
  type RemoteCommandRegistrationTable,
} from './remote-command-gateway.js';
import { createTaskCreationRemoteCommandRegistrations } from './task-creation-remote-commands.js';
import type { TaskCreationWorkflow } from './task-creation-workflow.js';

const OPERATION_ID = Buffer.alloc(16, 0x21).toString('base64url') as TaskCreationOperationId;
const OPERATION_CAPABILITY = Buffer.alloc(32, 0x22).toString(
  'base64url',
) as TaskCreationOperationCapability;
const AUTHENTICATION_GENERATION = Buffer.alloc(16, 0x23).toString('base64url');

function authentication(
  overrides: Partial<RemoteCommandAuthentication> = {},
): RemoteCommandAuthentication {
  return {
    authEpoch: '1',
    authenticationSessionGeneration: AUTHENTICATION_GENERATION,
    csrfValidated: true,
    directPeerValidated: true,
    expiresAt: 20_000,
    grants: new Set(['task:create']),
    kind: 'browser-session',
    originValidated: true,
    principalId: 'workspace-1',
    sourceId: 'client-1',
    transportSecure: true,
    ...overrides,
  };
}

function intent(): TaskCreationIntent {
  return {
    launch: { kind: 'terminal' },
    location: { kind: 'managed-worktree', requestedLinkNames: [] },
    name: 'Remote terminal',
    operationCapability: OPERATION_CAPABILITY,
    operationId: OPERATION_ID,
    operationTicket: 'ticket-1',
    projectId: 'project-1',
    stepsTracking: false,
  };
}

function enabledCapabilities() {
  return {
    coordinator: { reason: 'coordinator-not-supported' as const, supported: false as const },
    enabled: true,
    locations: {
      'existing-worktree': { enabled: true as const },
      'managed-worktree': { enabled: true as const },
      'project-root': { enabled: true as const },
    },
    modes: { agent: { enabled: true as const }, terminal: { enabled: true as const } },
    permissionBypass: { enabled: true as const },
  };
}

function shellReplay(): TaskShellSessionOperationReplay {
  return {
    current: {
      catalogVersion: 0,
      serverInstanceId: 'server-1',
      session: null,
      task: null,
      taskClosing: false,
      taskState: 'not-visible',
      workspaceRevision: 0,
    },
    disposition: { kind: 'in-progress', reason: 'task-commit-pending' },
    identity: {
      committedWorkspaceRevision: null,
      creationOperationId: OPERATION_ID,
      expectedGeneration: 0,
      operationId: 'launch-1',
      sessionId: 'shell-1',
      taskId: 'task-1',
    },
    phase: 'reserved-for-task-commit',
    recordVersion: 1,
    replayKind: 'full',
  };
}

function workflow(): TaskCreationWorkflow {
  const retry: RetryTaskShellSessionOperationResult = {
    outcome: 'accepted',
    shellLaunch: shellReplay(),
  };
  return {
    cancel: vi.fn(async () => ({ kind: 'operation-state-unavailable' as const })),
    create: vi.fn(async () => ({
      code: 'rate-limited' as const,
      kind: 'create-rejected-without-snapshot' as const,
    })),
    get: vi.fn(async () => ({ kind: 'operation-state-unavailable' as const })),
    getCapabilities: vi.fn(async () => REMOTE_TASK_CREATION_CAPABILITY_DARK),
    getPickerPage: vi.fn(async (_authentication, request) => ({
      catalogVersion: 1,
      generation: 1,
      items: [],
      kind: request.kind,
      nextCursor: null,
      serverInstanceId: 'server-1',
      truncated: false,
    })),
    getWorktreeLinkCandidates: vi.fn(async () => ({ kind: 'unavailable' as const })),
    issue: vi.fn(async () => ({
      expiresAt: 10_001,
      issuedAt: 1,
      operationId: OPERATION_ID,
      operationTicket: 'ticket-1',
    })),
    refreshOperation: vi.fn(async () => undefined),
    retryShell: vi.fn(async () => retry),
    subscribeOperation: vi.fn(async () => ({
      kind: 'subscribed' as const,
      unsubscribe: async () => undefined,
    })),
  };
}

function registration(registrations: RemoteCommandRegistrationTable, name: RemoteCommandName) {
  const value = registrations[name];
  if (!value) throw new Error(`Missing ${name} registration`);
  return value;
}

describe('task-creation remote command registrations', () => {
  it('registers exactly the eight reviewed task-creation commands', () => {
    const registrations = createTaskCreationRemoteCommandRegistrations(workflow());

    expect(Object.keys(registrations).sort()).toEqual([
      'task-creation.cancel',
      'task-creation.create',
      'task-creation.get',
      'task-creation.get-capabilities',
      'task-creation.get-picker-page',
      'task-creation.get-worktree-link-candidates',
      'task-creation.issue',
      'task-creation.retry-shell',
    ]);
  });

  it('accepts only exact command-specific request shapes', () => {
    const registrations = createTaskCreationRemoteCommandRegistrations(workflow());
    const getRequest = {
      operationCapability: OPERATION_CAPABILITY,
      operationId: OPERATION_ID,
    };
    const retryRequest = {
      action: 'retry-same-tuple',
      expectedRecordVersion: 1,
      operationCapability: OPERATION_CAPABILITY,
      operationId: 'launch-1',
    };
    const pickerRequest = { kind: 'base-branch', projectId: 'project-1' };

    expect(registration(registrations, 'task-creation.issue').isRequest({})).toBe(true);
    expect(registration(registrations, 'task-creation.issue').isRequest({ extra: true })).toBe(
      false,
    );
    expect(registration(registrations, 'task-creation.get-capabilities').isRequest({})).toBe(true);
    expect(registration(registrations, 'task-creation.create').isRequest(intent())).toBe(true);
    expect(
      registration(registrations, 'task-creation.create').isRequest({ ...intent(), extra: true }),
    ).toBe(false);
    expect(registration(registrations, 'task-creation.get').isRequest(getRequest)).toBe(true);
    expect(
      registration(registrations, 'task-creation.get').isRequest({ ...getRequest, extra: true }),
    ).toBe(false);
    expect(
      registration(registrations, 'task-creation.cancel').isRequest({
        expectedVersion: 1,
        ...getRequest,
      }),
    ).toBe(true);
    expect(
      registration(registrations, 'task-creation.cancel').isRequest({
        expectedVersion: 0,
        ...getRequest,
      }),
    ).toBe(false);
    expect(
      registration(registrations, 'task-creation.get-picker-page').isRequest(pickerRequest),
    ).toBe(true);
    expect(
      registration(registrations, 'task-creation.get-picker-page').isRequest({
        ...pickerRequest,
        cursor: undefined,
      }),
    ).toBe(false);
    expect(
      registration(registrations, 'task-creation.get-picker-page').isRequest({
        ...pickerRequest,
        query: '\ud800',
      }),
    ).toBe(false);
    expect(
      registration(registrations, 'task-creation.get-worktree-link-candidates').isRequest({
        projectId: 'project-1',
      }),
    ).toBe(true);
    expect(registration(registrations, 'task-creation.retry-shell').isRequest(retryRequest)).toBe(
      true,
    );
    expect(
      registration(registrations, 'task-creation.retry-shell').isRequest({
        ...retryRequest,
        operationId: OPERATION_ID,
      }),
    ).toBe(true);
    expect(
      registration(registrations, 'task-creation.retry-shell').isRequest({
        ...retryRequest,
        expectedRecordVersion: 0,
      }),
    ).toBe(false);
  });

  it('converts server-owned authentication and dispatches all eight commands', async () => {
    const owner = workflow();
    const gateway = createRemoteCommandGateway(
      createTaskCreationRemoteCommandRegistrations(owner),
      { mutationAdmissionInitiallyOpen: true, now: () => 1 },
    );
    const auth = authentication();
    const commands: Array<[RemoteCommandName, unknown]> = [
      ['task-creation.issue', {}],
      ['task-creation.get-capabilities', {}],
      ['task-creation.get-picker-page', { kind: 'base-branch', projectId: 'project-1' }],
      ['task-creation.get-worktree-link-candidates', { projectId: 'project-1' }],
      ['task-creation.create', intent()],
      [
        'task-creation.get',
        { operationCapability: OPERATION_CAPABILITY, operationId: OPERATION_ID },
      ],
      [
        'task-creation.cancel',
        {
          expectedVersion: 1,
          operationCapability: OPERATION_CAPABILITY,
          operationId: OPERATION_ID,
        },
      ],
      [
        'task-creation.retry-shell',
        {
          action: 'retry-same-tuple',
          expectedRecordVersion: 1,
          operationCapability: OPERATION_CAPABILITY,
          operationId: 'launch-1',
        },
      ],
    ];

    for (const [name, request] of commands) {
      await expect(gateway.dispatch(name, auth, request)).resolves.toMatchObject({ ok: true });
    }
    expect(owner.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        authEpoch: '1',
        workspacePrincipalId: 'workspace-1',
      }),
    );
    const issuedAuthentication = vi.mocked(owner.issue).mock.calls[0]?.[0];
    expect(issuedAuthentication?.authenticationSessionGeneration).toEqual(
      Uint8Array.from(Buffer.alloc(16, 0x23)),
    );
  });

  it('projects root, imported-worktree, and permission-bypass grants independently', async () => {
    const owner = workflow();
    vi.mocked(owner.getCapabilities).mockResolvedValue(enabledCapabilities());
    const gateway = createRemoteCommandGateway(
      createTaskCreationRemoteCommandRegistrations(owner),
      { mutationAdmissionInitiallyOpen: true, now: () => 1 },
    );

    await expect(
      gateway.dispatch('task-creation.get-capabilities', authentication(), {}),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        locations: {
          'existing-worktree': { enabled: false, reason: 'not-authorized' },
          'managed-worktree': { enabled: true },
          'project-root': { enabled: false, reason: 'not-authorized' },
        },
        permissionBypass: { enabled: false, reason: 'not-authorized' },
      },
    });
    await expect(
      gateway.dispatch(
        'task-creation.get-capabilities',
        authentication({
          grants: new Set([
            'task:create',
            'task:create-imported',
            'task:create-root',
            'task:permission-bypass',
          ]),
        }),
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        locations: {
          'existing-worktree': { enabled: true },
          'project-root': { enabled: true },
        },
        permissionBypass: { enabled: true },
      },
    });
  });

  it('denies each high-risk create shape at final gateway admission without its exact grant', async () => {
    const owner = workflow();
    const gateway = createRemoteCommandGateway(
      createTaskCreationRemoteCommandRegistrations(owner),
      { mutationAdmissionInitiallyOpen: true, now: () => 1 },
    );
    const requests: TaskCreationIntent[] = [
      { ...intent(), location: { kind: 'project-root' } },
      {
        ...intent(),
        location: { kind: 'existing-worktree', worktreeRef: 'worktree-ref-1' },
      },
      {
        ...intent(),
        launch: {
          agentDefId: 'agent-def-1',
          kind: 'agent',
          skipPermissions: true,
        },
      },
    ];

    for (const request of requests) {
      await expect(
        gateway.dispatch('task-creation.create', authentication(), request),
      ).resolves.toEqual({ ok: false, error: { code: 'forbidden' } });
    }
    await expect(
      gateway.dispatch('task-creation.get-picker-page', authentication(), {
        kind: 'existing-worktree',
        projectId: 'project-1',
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(owner.create).not.toHaveBeenCalled();
    expect(owner.getPickerPage).not.toHaveBeenCalled();

    await expect(
      gateway.dispatch(
        'task-creation.create',
        authentication({
          grants: new Set([
            'task:create',
            'task:create-imported',
            'task:create-root',
            'task:permission-bypass',
          ]),
        }),
        {
          ...intent(),
          launch: {
            agentDefId: 'agent-def-1',
            kind: 'agent',
            skipPermissions: true,
          },
          location: { kind: 'project-root' },
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(owner.create).toHaveBeenCalledOnce();
  });

  it('rejects noncanonical remote session generations before workflow execution', async () => {
    const owner = workflow();
    const onInternalError = vi.fn();
    const gateway = createRemoteCommandGateway(
      createTaskCreationRemoteCommandRegistrations(owner),
      { mutationAdmissionInitiallyOpen: true, now: () => 1, onInternalError },
    );

    await expect(
      gateway.dispatch(
        'task-creation.issue',
        authentication({ authenticationSessionGeneration: 'generation-1' }),
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: 'internal-error' } });
    expect(owner.issue).not.toHaveBeenCalled();
    expect(onInternalError).toHaveBeenCalledOnce();
  });

  it('keeps create and lookup no-snapshot result families distinct', () => {
    const registrations = createTaskCreationRemoteCommandRegistrations(workflow());
    const createRejected = {
      code: 'rate-limited',
      kind: 'create-rejected-without-snapshot',
    };
    const lookupUnavailable = { kind: 'operation-state-unavailable' };

    expect(registration(registrations, 'task-creation.create').isResult(createRejected)).toBe(true);
    expect(registration(registrations, 'task-creation.create').isResult(lookupUnavailable)).toBe(
      false,
    );
    expect(registration(registrations, 'task-creation.get').isResult(lookupUnavailable)).toBe(true);
    expect(registration(registrations, 'task-creation.get').isResult(createRejected)).toBe(false);
  });
});
