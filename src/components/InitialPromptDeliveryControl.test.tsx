import { fireEvent, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
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
import type { TaskReliabilityRuntimeEvent } from '../domain/task-reliability-runtime';

const {
  confirmMock,
  getProjectionMock,
  refreshCapabilitiesMock,
  resolveAmbiguityMock,
  reviseDraftMock,
  sendManuallyMock,
  subscribeMock,
} = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  getProjectionMock: vi.fn(),
  refreshCapabilitiesMock: vi.fn(),
  resolveAmbiguityMock: vi.fn(),
  reviseDraftMock: vi.fn(),
  sendManuallyMock: vi.fn(),
  subscribeMock: vi.fn((_listener: (event: TaskReliabilityRuntimeEvent) => void) => vi.fn()),
}));

vi.mock('../lib/dialog', () => ({ confirm: confirmMock }));

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

async function openDraft(result: ReturnType<typeof renderControl>): Promise<void> {
  (
    await result.findByRole('button', { name: /^(Review draft|View draft|View saved draft)$/ })
  ).click();
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
    await openDraft(result);
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
    await openDraft(result);
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
      'Initial-prompt status is unavailable. Refresh or inspect the terminal before sending.';
    getProjectionMock.mockRejectedValueOnce(new Error('Internal error'));
    const inspectTerminal = vi.fn();
    const result = renderControl({ onInspectTerminal: inspectTerminal });
    expect(await result.findByText(message)).toBeTruthy();
    expect(result.queryByRole('button', { name: 'Send initial prompt' })).toBeNull();
    result.getByRole('button', { name: 'Inspect terminal' }).click();
    expect(inspectTerminal).toHaveBeenCalledWith('agent-1');
    result.getByRole('button', { name: 'Refresh status' }).click();
    await openDraft(result);
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
    await openDraft(result);
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
    await openDraft(result);
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
    await openDraft(result);
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
    await openDraft(result);

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
    await openDraft(result);

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
    await openDraft(result);

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
    await openDraft(readOnlyResult);
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
    await openDraft(staleResult);
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
    await openDraft(result);

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

  it('starts compact and retains the same editor and selection through disclosure and fresh projections', async () => {
    const onDetailsToggle = vi.fn();
    const result = renderControl({ onDetailsToggle });
    const review = await result.findByRole('button', { name: 'Review draft' });
    expect(result.queryByRole('textbox')).toBeNull();
    expect(result.queryByRole('button', { name: 'Send initial prompt' })).toBeNull();
    expect(onDetailsToggle).not.toHaveBeenCalled();
    review.click();
    expect(onDetailsToggle).toHaveBeenLastCalledWith(true);
    const editor = result.getByRole('textbox') as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(1, 3);
    subscribeMock.mock.calls[0]?.[0]({
      kind: 'initial-prompt-delivery-changed',
      projection: projection(),
      serverInstanceId: 'server-1',
      cutoverEpoch: 'epoch-1',
    });
    expect(result.getByRole('textbox')).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(1);
    expect(onDetailsToggle).toHaveBeenCalledOnce();
    result.getByRole('button', { name: 'Hide draft' }).click();
    expect(onDetailsToggle).toHaveBeenLastCalledWith(false);
    expect(result.queryByRole('textbox')).toBeNull();
    await openDraft(result);
    expect(result.getByRole('textbox')).toBe(editor);
    expect(onDetailsToggle.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('retires a sent acknowledged draft without inventing unsaved changes or hiding a local edit', async () => {
    const unsaved = vi.fn();
    const result = renderControl({ onUnsavedChange: unsaved });
    await openDraft(result);
    const complete = projection({
      currentDraft: null,
      delivery: { ...projection().delivery, status: 'delivered', version: 3 },
    });
    subscribeMock.mock.calls[0]?.[0]({
      kind: 'initial-prompt-delivery-changed',
      projection: complete,
      serverInstanceId: 'server-1',
      cutoverEpoch: 'epoch-1',
    });
    expect(result.getByText('Initial prompt sent')).toBeTruthy();
    expect(result.queryByRole('textbox')).toBeNull();
    expect(result.queryByRole('button', { name: /draft/i })).toBeNull();
    expect(unsaved).toHaveBeenLastCalledWith(false);
    result.unmount();

    reviseDraftMock.mockImplementation(() => new Promise(() => {}));
    const editing = renderControl({ onUnsavedChange: unsaved });
    await openDraft(editing);
    const editor = editing.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: 'Keep my local revision' } });
    subscribeMock.mock.calls.at(-1)?.[0]({
      kind: 'initial-prompt-delivery-changed',
      projection: complete,
      serverInstanceId: 'server-1',
      cutoverEpoch: 'epoch-1',
    });
    expect(editing.getByRole('textbox')).toBe(editor);
    expect(editor.value).toBe('Keep my local revision');
    expect(editor.readOnly).toBe(true);
    expect(unsaved).toHaveBeenLastCalledWith(true);
    expect(
      (editing.getByRole('button', { name: 'Hide draft' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(editing.getByRole('button', { name: 'Copy draft' })).toBeTruthy();
  });

  it('preserves retired local edits through late save acknowledgements until explicit confirmed discard', async () => {
    let completeSave!: (result: ReviseTaskInitialPromptDraftResult) => void;
    reviseDraftMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }),
    );
    const unsaved = vi.fn();
    const [retired, setRetired] = createSignal(false);
    const result = render(() => (
      <InitialPromptDeliveryControl
        taskId="task-1"
        deliveryId="delivery-1"
        agentId="agent-1"
        agentGeneration={4}
        retired={retired()}
        onUnsavedChange={unsaved}
      />
    ));
    await openDraft(result);
    const editor = result.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: 'Keep this local edit' } });
    editor.focus();
    editor.setSelectionRange(2, 6);
    setRetired(true);
    expect(result.getByRole('textbox')).toBe(editor);
    expect(editor.readOnly).toBe(true);
    expect(editor.value).toBe('Keep this local edit');
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(2);
    expect(result.queryByRole('button', { name: 'Send initial prompt' })).toBeNull();
    expect(result.getByRole('button', { name: 'Copy draft' })).toBeTruthy();
    completeSave({
      kind: 'saved-manual-draft',
      current: draft({ editRevision: 1, text: 'Keep this local edit' }),
    });
    await Promise.resolve();
    await Promise.resolve();
    subscribeMock.mock.calls.at(-1)?.[0]({
      kind: 'initial-prompt-delivery-changed',
      projection: projection({
        currentDraft: null,
        delivery: { ...projection().delivery, status: 'delivered', version: 3 },
      }),
      serverInstanceId: 'server-1',
      cutoverEpoch: 'epoch-1',
    });
    expect(editor.value).toBe('Keep this local edit');
    expect(unsaved).toHaveBeenLastCalledWith(true);
    confirmMock.mockResolvedValueOnce(false);
    result.getByRole('button', { name: 'Discard local draft' }).click();
    await Promise.resolve();
    expect(unsaved).toHaveBeenLastCalledWith(true);
    expect(editor.value).toBe('Keep this local edit');
    confirmMock.mockResolvedValueOnce(true);
    result.getByRole('button', { name: 'Discard local draft' }).click();
    await vi.waitFor(() => expect(unsaved).toHaveBeenLastCalledWith(false));
    expect(result.queryByRole('textbox')).toBeNull();
    expect(reviseDraftMock.mock.calls[0]?.[1].aborted).toBe(true);
    expect(sendManuallyMock).not.toHaveBeenCalled();
  });

  it('shows a mismatched saved draft only for read-only recovery with no send or edit authority', async () => {
    getProjectionMock.mockResolvedValue({
      kind: 'recovery-unavailable',
      reason: 'legacy-draft-identity-mismatch',
      deliveryId: 'delivery-1',
      taskId: 'task-1',
      serverInstanceId: 'server-1',
      savedDraft: 'Preserve this exact text',
    });
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    });
    const result = renderControl({ onInspectTerminal: vi.fn() });
    expect(await result.findByText('Saved prompt needs recovery')).toBeTruthy();
    await openDraft(result);
    const editor = result.getByRole('textbox') as HTMLTextAreaElement;
    expect(editor.value).toBe('Preserve this exact text');
    expect(editor.readOnly).toBe(true);
    expect(result.queryByRole('button', { name: /send|replace/i })).toBeNull();
    result.getByRole('button', { name: 'Copy draft' }).click();
    expect(copy).toHaveBeenCalledWith('Preserve this exact text');
    fireEvent.input(editor, { target: { value: 'Changed' } });
    expect(reviseDraftMock).not.toHaveBeenCalled();
    expect(sendManuallyMock).not.toHaveBeenCalled();
  });

  it('revokes authority on restart and ignores the pending refresh until explicitly refreshed', async () => {
    let complete!: (value: TaskInitialPromptDeliveryProjection) => void;
    getProjectionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const result = renderControl();
    await vi.waitFor(() => expect(getProjectionMock).toHaveBeenCalledOnce());
    subscribeMock.mock.calls[0]?.[0]({
      kind: 'task-reliability-capabilities-invalidated',
      serverInstanceId: 'server-2',
    });
    complete(projection());
    await vi.waitFor(() => expect(result.getByText('Initial prompt unavailable')).toBeTruthy());
    expect(result.queryByRole('button', { name: 'Review draft' })).toBeNull();
    result.getByRole('button', { name: 'Refresh status' }).click();
    await openDraft(result);
    const send = result.getByRole('button', { name: 'Send initial prompt' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    subscribeMock.mock.calls[0]?.[0]({
      kind: 'task-reliability-capabilities-invalidated',
      serverInstanceId: 'server-2',
    });
    expect(send.disabled).toBe(true);
    expect((result.getByRole('textbox') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('does not let a late refresh failure hide newer live status or its send authority', async () => {
    let fail!: (error: Error) => void;
    getProjectionMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const result = renderControl();
    await vi.waitFor(() => expect(getProjectionMock).toHaveBeenCalledOnce());
    subscribeMock.mock.calls[0]?.[0]({
      kind: 'initial-prompt-delivery-changed',
      projection: projection(),
      serverInstanceId: 'server-1',
      cutoverEpoch: 'epoch-1',
    });
    await openDraft(result);
    fail(new Error('Internal error'));
    await Promise.resolve();
    expect(
      (result.getByRole('button', { name: 'Send initial prompt' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(result.queryByText('Initial prompt unavailable')).toBeNull();
    expect(result.queryByText('Internal error')).toBeNull();
  });

  it('isolates pending requests and local editors when the task and delivery change', async () => {
    let completeOld!: (value: TaskInitialPromptDeliveryProjection) => void;
    getProjectionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeOld = resolve;
        }),
    );
    const [taskId, setTaskId] = createSignal('task-1');
    const result = render(() => (
      <InitialPromptDeliveryControl
        taskId={taskId()}
        deliveryId={taskId() === 'task-1' ? 'delivery-1' : 'delivery-2'}
        agentId="agent-1"
        agentGeneration={4}
      />
    ));
    await vi.waitFor(() => expect(getProjectionMock).toHaveBeenCalledOnce());
    getProjectionMock.mockResolvedValue(
      projection({
        delivery: { ...projection().delivery, deliveryId: 'delivery-2', taskId: 'task-2' },
        currentDraft: draft({ text: 'Second task' }),
      }),
    );
    setTaskId('task-2');
    await openDraft(result);
    completeOld(projection());
    await Promise.resolve();
    expect((result.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Second task');
    expect(getProjectionMock.mock.calls[0]?.[1].aborted).toBe(true);
    expect(reviseDraftMock).not.toHaveBeenCalled();
  });
});
