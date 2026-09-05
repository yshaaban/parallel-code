import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteCommandAuthentication } from '../ipc/remote-command-gateway.js';

const getAgentMeta = vi.fn(() => null as { taskId: string } | null);
const isTaskCommandLeaseHeld = vi.fn(() => false);
const pauseAgent = vi.fn();
const resizeAgent = vi.fn();
const resumeAgent = vi.fn();
const stopTaskAgentWorkflow = vi.fn().mockResolvedValue(undefined);
const writeToAgent = vi.fn();

vi.mock('../ipc/pty.js', () => ({
  getAgentMeta,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  writeToAgent,
}));
vi.mock('../ipc/task-command-leases.js', () => ({ isTaskCommandLeaseHeld }));
vi.mock('../ipc/task-workflows.js', () => ({ stopTaskAgentWorkflow }));

function authentication(
  overrides: Partial<RemoteCommandAuthentication> = {},
): RemoteCommandAuthentication {
  return {
    authEpoch: '1',
    authenticationSessionGeneration: 'generation-1',
    csrfValidated: true,
    directPeerValidated: true,
    expiresAt: Number.MAX_SAFE_INTEGER,
    grants: new Set(['terminal:control']),
    kind: 'browser-session',
    originValidated: true,
    principalId: 'workspace-owner',
    sourceId: 'mobile-1',
    transportSecure: true,
    ...overrides,
  };
}

describe('createRemoteTerminalCommandRegistrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentMeta.mockReturnValue(null);
  });

  it('executes exact guarded input through the gateway and preserves attribution/order', async () => {
    const { createRemoteCommandGateway } = await import('../ipc/remote-command-gateway.js');
    const { createRemoteTerminalCommandRegistrations } =
      await import('./terminal-command-registrations.js');
    const gateway = createRemoteCommandGateway(createRemoteTerminalCommandRegistrations(), {
      mutationAdmissionInitiallyOpen: true,
    });
    const body = {
      agentId: 'agent-1',
      data: 'ls\r',
      inputEpoch: 'epoch-1',
      inputSeq: 1,
      requestId: 'request-1',
      trace: {
        bufferedAtMs: 95,
        inputChars: 3,
        inputKind: 'interactive' as const,
        sendStartedAtMs: 98,
        startedAtMs: 90,
      },
      type: 'input' as const,
    };

    await expect(gateway.dispatch('terminal.input', authentication(), body)).resolves.toEqual({
      ok: true,
      result: { kind: 'accepted' },
    });
    expect(writeToAgent).toHaveBeenCalledWith(
      'agent-1',
      'ls\r',
      expect.objectContaining({ clientId: 'mobile-1', requestId: 'request-1' }),
      { inputEpoch: 'epoch-1', inputSeq: 1 },
    );
  });

  it('rejects unknown fields and task-control mismatches before terminal writes', async () => {
    const { createRemoteCommandGateway } = await import('../ipc/remote-command-gateway.js');
    const { createRemoteTerminalCommandRegistrations } =
      await import('./terminal-command-registrations.js');
    const gateway = createRemoteCommandGateway(createRemoteTerminalCommandRegistrations(), {
      mutationAdmissionInitiallyOpen: true,
    });

    await expect(
      gateway.dispatch('terminal.input', authentication(), {
        agentId: 'agent-1',
        data: 'x',
        injected: true,
        type: 'input',
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'bad-request' } });
    getAgentMeta.mockReturnValue({ taskId: 'task-1' });
    await expect(
      gateway.dispatch('terminal.input', authentication(), {
        agentId: 'agent-1',
        controllerId: 'controller-1',
        data: 'x',
        taskId: 'other-task',
        type: 'input',
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'internal-error' } });
    expect(writeToAgent).not.toHaveBeenCalled();
  });

  it('fails closed before execution for missing grants or insecure transport', async () => {
    const { createRemoteCommandGateway } = await import('../ipc/remote-command-gateway.js');
    const { createRemoteTerminalCommandRegistrations } =
      await import('./terminal-command-registrations.js');
    const gateway = createRemoteCommandGateway(createRemoteTerminalCommandRegistrations(), {
      mutationAdmissionInitiallyOpen: true,
    });
    const body = { agentId: 'agent-1', data: 'x', type: 'input' };

    await expect(
      gateway.dispatch(
        'terminal.input',
        authentication({ grants: new Set(['terminal:read']) }),
        body,
      ),
    ).resolves.toEqual({ ok: false, error: { code: 'forbidden' } });
    await expect(
      gateway.dispatch('terminal.input', authentication({ transportSecure: false }), body),
    ).resolves.toEqual({ ok: false, error: { code: 'secure-transport-required' } });
    expect(writeToAgent).not.toHaveBeenCalled();
  });
});
