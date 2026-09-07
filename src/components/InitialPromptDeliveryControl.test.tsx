import { fireEvent, render } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  type ManualInitialPromptSendOperationSnapshot,
  type ReviseTaskInitialPromptDraftResult,
  type TaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDraftSnapshot,
} from '../domain/task-initial-prompt-delivery';

const {
  getProjectionMock,
  refreshCapabilitiesMock,
  resolveAmbiguityMock,
  reviseDraftMock,
  sendManuallyMock,
  subscribeMock,
} = vi.hoisted(() => ({
  getProjectionMock: vi.fn(),
  refreshCapabilitiesMock: vi.fn(),
  resolveAmbiguityMock: vi.fn(),
  reviseDraftMock: vi.fn(),
  sendManuallyMock: vi.fn(),
  subscribeMock: vi.fn(() => vi.fn()),
}));

vi.mock('../app/task-reliability-production', () => ({
  getProductionTaskReliabilityClient: () => ({
    initialPromptDelivery: {
      getProjection: getProjectionMock,
      resolveAmbiguity: resolveAmbiguityMock,
      reviseDraft: reviseDraftMock,
      sendManually: sendManuallyMock,
    },
    refreshCapabilities: refreshCapabilitiesMock,
    subscribe: subscribeMock,
  }),
}));

import { InitialPromptDeliveryControl } from './InitialPromptDeliveryControl';

function draft(
  overrides: Partial<TaskInitialPromptDraftSnapshot> = {},
): TaskInitialPromptDraftSnapshot {
  const text = overrides.text ?? 'Ship it';
  return {
    editRevision: 0,
    fingerprint: deriveTaskInitialPromptDraftFingerprint({
      agentId: 'agent-1',
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: 'task-1',
      text,
    }),
    mode: 'manual-only',
    text,
    workspaceRevision: 1,
    ...overrides,
  };
}

function projection(
  overrides: Partial<TaskInitialPromptDeliveryProjection> = {},
): TaskInitialPromptDeliveryProjection {
  return {
    current: {
      catalogVersion: 1,
      serverInstanceId: 'server-1',
      taskClosing: false,
      taskState: 'present',
    },
    currentDraft: draft(),
    delivery: {
      agentId: 'agent-1',
      attempts: 1,
      createdAt: '2026-08-03T00:00:00.000Z',
      deliveryId: 'delivery-1',
      status: 'manual-required',
      targetGeneration: 4,
      taskId: 'task-1',
      updatedAt: '2026-08-03T00:00:00.000Z',
      version: 2,
    },
    ...overrides,
  };
}

function operation(
  phase: ManualInitialPromptSendOperationSnapshot['phase'],
): ManualInitialPromptSendOperationSnapshot {
  const acknowledged = draft();
  return {
    acknowledgedDraftFingerprint: acknowledged.fingerprint,
    acknowledgedEditRevision: acknowledged.editRevision,
    agentId: 'agent-1',
    attempt: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    deliveryId: 'delivery-1',
    expectedAgentGeneration: 4,
    manualSendOperationId: deriveManualInitialPromptSendOperationId({
      acknowledgedDraftFingerprint: acknowledged.fingerprint,
      acknowledgedEditRevision: acknowledged.editRevision,
      deliveryId: 'delivery-1',
    }),
    phase,
    possiblePriorAutomaticWrite: false,
    taskId: 'task-1',
    updatedAt: '2026-08-03T00:00:01.000Z',
    version: 3,
  };
}

function renderControl(
  overrides: Partial<Parameters<typeof InitialPromptDeliveryControl>[0]> = {},
) {
  return render(() => (
    <InitialPromptDeliveryControl
      agentGeneration={4}
      agentId="agent-1"
      deliveryId="delivery-1"
      taskId="task-1"
      {...overrides}
    />
  ));
}

describe('InitialPromptDeliveryControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshCapabilitiesMock.mockResolvedValue({
      initialPromptDelivery: { enabled: true },
      kind: 'active',
    });
    getProjectionMock.mockResolvedValue(projection());
    sendManuallyMock.mockResolvedValue({
      current: projection().current,
      currentDraft: null,
      delivery: { ...projection().delivery, status: 'delivered', version: 3 },
      kind: 'operation',
      operation: operation('completed'),
      recovery: { kind: 'none' },
      replayed: false,
    });
  });

  it('explains unknown legacy history, preserves its draft, and requires explicit confirmation before sending', async () => {
    const recovered = projection({
      delivery: { ...projection().delivery, attempts: 0, priorDeliveryUnknown: true },
    });
    let current = recovered;
    getProjectionMock.mockImplementation(async () => current);
    sendManuallyMock.mockImplementation(async (request) => {
      const nextOperation = {
        ...operation(
          request.confirmPossiblePriorAutomaticWrite ? 'completed' : 'confirmation-required',
        ),
        possiblePriorAutomaticWrite: true,
      };
      current = { ...recovered, manualSendOperation: nextOperation };
      return {
        ...current,
        kind: 'operation',
        operation: nextOperation,
        recovery: { kind: 'none' },
        replayed: false,
      };
    });
    const inspectTerminal = vi.fn();
    let result = renderControl({ onInspectTerminal: inspectTerminal });
    expect(
      await result.findByText(
        'Previous delivery is unknown. Inspect the terminal before sending this saved prompt.',
      ),
    ).toBeTruthy();
    expect((result.getByLabelText('Initial prompt draft') as HTMLTextAreaElement).value).toBe(
      'Ship it',
    );
    expect(result.getByRole('button', { name: 'Copy draft' })).toBeTruthy();
    result.getByRole('button', { name: 'Inspect terminal' }).click();
    expect(inspectTerminal).toHaveBeenCalledWith('agent-1');
    expect(sendManuallyMock).not.toHaveBeenCalled();
    result.getByRole('button', { name: 'Send initial prompt' }).click();
    await result.findByRole('button', { name: 'Confirm send' });
    expect(sendManuallyMock).toHaveBeenCalledOnce();
    expect(sendManuallyMock.mock.calls[0]?.[0].confirmPossiblePriorAutomaticWrite).toBe(false);
    result.unmount();
    result = renderControl({ onInspectTerminal: inspectTerminal });
    const confirm = await result.findByRole('button', { name: 'Confirm send' });
    expect(sendManuallyMock).toHaveBeenCalledOnce();
    confirm.click();
    await vi.waitFor(() => expect(sendManuallyMock).toHaveBeenCalledTimes(2));
    expect(sendManuallyMock.mock.calls[1]?.[0]).toMatchObject({
      confirmPossiblePriorAutomaticWrite: true,
      expectedDraftFingerprint: recovered.currentDraft?.fingerprint,
      expectedEditRevision: 0,
    });
  });

  it('offers inspection but no send for an unrecoverable legacy identity and clears the error after a successful refresh', async () => {
    const message =
      'This saved prompt no longer matches its original task or draft. It cannot be recovered safely.';
    getProjectionMock.mockRejectedValueOnce(new Error(message));
    const inspectTerminal = vi.fn();
    const result = renderControl({ onInspectTerminal: inspectTerminal });
    expect(await result.findByText(message)).toBeTruthy();
    expect(result.queryByRole('button', { name: 'Send initial prompt' })).toBeNull();
    result.getByRole('button', { name: 'Inspect terminal' }).click();
    expect(inspectTerminal).toHaveBeenCalledWith('agent-1');
    result.getByRole('button', { name: 'Refresh status' }).click();
    expect(await result.findByLabelText('Initial prompt draft')).toBeTruthy();
    expect(result.queryByText(message)).toBeNull();
    expect(sendManuallyMock).not.toHaveBeenCalled();
  });

  it('keeps a recovered legacy draft inspectable but not writable under peer control', async () => {
    getProjectionMock.mockResolvedValue(
      projection({
        delivery: { ...projection().delivery, attempts: 0, priorDeliveryUnknown: true },
      }),
    );
    const result = renderControl({ readOnly: true });
    const textarea = (await result.findByLabelText('Initial prompt draft')) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    const send = result.getByRole('button', { name: 'Send initial prompt' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    send.click();
    expect(sendManuallyMock).not.toHaveBeenCalled();
    expect(result.getByRole('button', { name: 'Copy draft' })).toBeTruthy();
  });

  it('preserves an actionable send rejection when the follow-up status refresh succeeds', async () => {
    sendManuallyMock.mockResolvedValue({
      current: projection().current,
      error: { code: 'not-authorized' },
      kind: 'admission-rejected',
      recovery: { kind: 'none' },
    });
    const result = renderControl();
    (await result.findByRole('button', { name: 'Send initial prompt' })).click();
    await vi.waitFor(() => expect(getProjectionMock).toHaveBeenCalledTimes(2));
    expect(result.getByText('You no longer control this task.')).toBeTruthy();
  });

  it('dispatches only the exact acknowledged draft and never sends an unsaved edit', async () => {
    const onUnsavedChange = vi.fn();
    let saveDraft!: (result: ReviseTaskInitialPromptDraftResult) => void;
    reviseDraftMock.mockImplementation(
      () =>
        new Promise<ReviseTaskInitialPromptDraftResult>((resolve) => {
          saveDraft = resolve;
        }),
    );
    const result = renderControl({ onUnsavedChange });
    const textarea = (await result.findByLabelText('Initial prompt draft')) as HTMLTextAreaElement;
    const sendButton = result.getByRole('button', { name: 'Send initial prompt' });

    expect((sendButton as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.input(textarea, { target: { value: 'Revised prompt' } });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
    const pendingUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    sendButton.click();
    expect(sendManuallyMock).not.toHaveBeenCalled();

    const saved = draft({ editRevision: 1, text: 'Revised prompt', workspaceRevision: 2 });
    saveDraft({ current: saved, kind: 'saved-manual-draft' });
    await vi.waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    const acknowledgedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(acknowledgedUnload);
    expect(acknowledgedUnload.defaultPrevented).toBe(false);
    sendButton.click();

    await vi.waitFor(() => expect(sendManuallyMock).toHaveBeenCalledOnce());
    expect(sendManuallyMock.mock.calls[0]?.[0]).toMatchObject({
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 4,
      expectedDraftFingerprint: saved.fingerprint,
      expectedEditRevision: 1,
      taskId: 'task-1',
    });
    expect(sendManuallyMock.mock.calls[0]?.[0]).not.toHaveProperty('text');
  });

  it('offers reconciliation choices without a retry when the write outcome is ambiguous', async () => {
    const ambiguousOperation = operation('manual-reconciliation-required');
    getProjectionMock.mockResolvedValue(projection({ manualSendOperation: ambiguousOperation }));
    resolveAmbiguityMock.mockResolvedValue({
      kind: 'resolved',
      projection: projection({
        delivery: { ...projection().delivery, status: 'delivered', version: 3 },
        manualSendOperation: operation('reconciled'),
      }),
      replayed: false,
    });
    const inspectTerminal = vi.fn();
    const result = renderControl({ onInspectTerminal: inspectTerminal });

    expect(await result.findByText(/write outcome is uncertain/i)).toBeTruthy();
    expect(result.queryByRole('button', { name: /send initial prompt/i })).toBeNull();
    expect(result.queryByRole('button', { name: /retry/i })).toBeNull();
    result.getByRole('button', { name: 'Inspect terminal' }).click();
    expect(inspectTerminal).toHaveBeenCalledWith('agent-1');

    result.getByRole('button', { name: 'Mark as sent' }).click();
    await vi.waitFor(() => {
      expect(resolveAmbiguityMock).toHaveBeenCalledWith(
        {
          expectedOperationVersion: 3,
          manualSendOperationId: ambiguousOperation.manualSendOperationId,
          resolution: 'observed-sent',
        },
        expect.any(AbortSignal),
      );
    });
    expect(sendManuallyMock).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation after a possible prior automatic write', async () => {
    getProjectionMock.mockResolvedValue(
      projection({ manualSendOperation: operation('confirmation-required') }),
    );
    const result = renderControl();

    const confirm = await result.findByRole('button', { name: 'Confirm send' });
    confirm.click();
    await vi.waitFor(() => expect(sendManuallyMock).toHaveBeenCalledOnce());
    expect(sendManuallyMock.mock.calls[0]?.[0]).toMatchObject({
      confirmPossiblePriorAutomaticWrite: true,
    });
  });

  it('sends a newer acknowledged edit as a fresh operation after a pre-write failure', async () => {
    const failedOperation = operation('failed-before-write');
    getProjectionMock.mockResolvedValue(projection({ manualSendOperation: failedOperation }));
    const revised = draft({
      editRevision: 1,
      text: 'Ship the newer acknowledged draft',
      workspaceRevision: 2,
    });
    reviseDraftMock.mockResolvedValue({ current: revised, kind: 'saved-manual-draft' });
    const result = renderControl();

    const textarea = (await result.findByLabelText('Initial prompt draft')) as HTMLTextAreaElement;
    expect(result.getByRole('button', { name: 'Retry safe send' })).toBeTruthy();

    await fireEvent.input(textarea, { target: { value: revised.text } });
    const send = await result.findByRole('button', { name: 'Send initial prompt' });
    await vi.waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    send.click();

    await vi.waitFor(() => expect(sendManuallyMock).toHaveBeenCalledOnce());
    expect(sendManuallyMock.mock.calls[0]?.[0]).toMatchObject({
      action: { kind: 'send' },
      confirmPossiblePriorAutomaticWrite: false,
      expectedDraftFingerprint: revised.fingerprint,
      expectedEditRevision: revised.editRevision,
      manualSendOperationId: deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: revised.fingerprint,
        acknowledgedEditRevision: revised.editRevision,
        deliveryId: 'delivery-1',
      }),
    });
    expect(sendManuallyMock.mock.calls[0]?.[0].manualSendOperationId).not.toBe(
      failedOperation.manualSendOperationId,
    );
  });

  it('disables editing and sending for peer control or a stale agent generation', async () => {
    const readOnlyResult = renderControl({ readOnly: true });
    const readOnlyDraft = (await readOnlyResult.findByLabelText(
      'Initial prompt draft',
    )) as HTMLTextAreaElement;
    expect(readOnlyDraft.readOnly).toBe(true);
    expect(
      (readOnlyResult.getByRole('button', { name: 'Send initial prompt' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    readOnlyResult.unmount();

    const staleResult = renderControl({ agentGeneration: 5 });
    const staleSend = (await staleResult.findByRole('button', {
      name: 'Send initial prompt',
    })) as HTMLButtonElement;
    expect(staleSend.disabled).toBe(true);
    expect(staleResult.getByRole('button', { name: 'Refresh agent status' })).toBeTruthy();
  });

  it('uses the backend delivery target when the selected terminal is a different agent', async () => {
    const result = renderControl({
      agentGeneration: 9,
      agentId: 'agent-2',
      getAgentGeneration: (targetAgentId) => (targetAgentId === 'agent-1' ? 4 : 9),
    });

    const send = await result.findByRole('button', { name: 'Send initial prompt' });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    send.click();

    await vi.waitFor(() => expect(sendManuallyMock).toHaveBeenCalledOnce());
    expect(sendManuallyMock.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'agent-1',
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 4,
      taskId: 'task-1',
    });
  });
});
