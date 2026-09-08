import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';

import {
  createManualInitialPromptSendRequest,
  createTaskInitialPromptDraftController,
  getTaskInitialPromptPresentation,
  isManualInitialPromptOperationForDraft,
  isVisibleInitialPromptDraftAcknowledged,
  reduceTaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDraftController,
  type TaskInitialPromptDraftControllerSnapshot,
} from '../app/task-initial-prompt-delivery';
import { getProductionTaskReliabilityClient } from '../app/task-reliability-production';
import {
  isTaskInitialPromptDeliveryRecoveryIssue,
  type SendTaskInitialPromptManuallyResult,
  type TaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDeliveryRecoveryIssue,
} from '../domain/task-initial-prompt-delivery';
import { createRandomId } from '../lib/random-id';
import { confirm } from '../lib/dialog';

interface InitialPromptDeliveryControlProps {
  agentGeneration: number;
  agentId: string;
  deliveryId: string;
  getAgentGeneration?: (agentId: string) => number | undefined;
  onDetailsToggle?: (expanded: boolean) => void;
  onInspectTerminal?: (agentId: string) => void;
  onUnsavedChange?: (unsaved: boolean) => void;
  readOnly?: boolean;
  retired?: boolean;
  taskId: string;
}

type StatusTone = 'neutral' | 'progress' | 'success' | 'warning';

function sendResultMessage(result: SendTaskInitialPromptManuallyResult): string | null {
  if (result.kind === 'operation') return null;
  if (result.kind === 'admission-rejected') {
    switch (result.error.code) {
      case 'rate-limited':
        return `Send is temporarily rate limited. Try again in ${Math.ceil(result.error.retryAfterMs / 1_000)}s.`;
      case 'manual-send-in-progress':
        return 'This exact send is already in progress.';
      case 'manual-reconciliation-pending':
        return 'A previous write is uncertain. Inspect the terminal before reconciling.';
      case 'not-authorized':
        return 'You no longer control this task.';
      case 'journal-unavailable':
      case 'task-removal-gate-unavailable':
        return 'Initial-prompt delivery is temporarily unavailable. The draft remains safe.';
      default:
        return 'The initial-prompt request was rejected. Refresh before trying again.';
    }
  }
  switch (result.issue.code) {
    case 'confirmation-required':
      return 'The prompt may already have been written. Inspect the terminal, then confirm once.';
    case 'agent-not-ready':
    case 'agent-question-active':
    case 'supervision-changed-before-admission':
      return 'No bytes were written. Wait until the agent is ready, then use the safe retry.';
    case 'control-unavailable':
      return 'No bytes were written because another session controls this task.';
    case 'write-outcome-ambiguous':
      return 'The write outcome is uncertain. Do not resend; inspect the terminal first.';
    case 'task-closing':
    case 'task-missing':
    case 'delivery-closed':
      return 'This task no longer accepts its initial prompt. The visible text remains available to copy.';
    default:
      return 'The prompt was not sent. The acknowledged draft remains available.';
  }
}

export function InitialPromptDeliveryControl(
  props: InitialPromptDeliveryControlProps,
): JSX.Element {
  const identity = createMemo(() => ({ taskId: props.taskId, deliveryId: props.deliveryId }));
  return (
    <Show when={identity()} keyed>
      {(identity) => (
        <InitialPromptDeliverySession
          {...props}
          taskId={identity.taskId}
          deliveryId={identity.deliveryId}
        />
      )}
    </Show>
  );
}

function InitialPromptDeliverySession(props: InitialPromptDeliveryControlProps): JSX.Element {
  const agentId = untrack(() => props.agentId);
  const deliveryId = untrack(() => props.deliveryId);
  const taskId = untrack(() => props.taskId);
  const client = getProductionTaskReliabilityClient();
  const [projection, setProjection] = createSignal<TaskInitialPromptDeliveryProjection | null>(
    null,
  );
  const [draftState, setDraftState] = createSignal<TaskInitialPromptDraftControllerSnapshot | null>(
    null,
  );
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [statusError, setStatusError] = createSignal<string | null>(null);
  const [statusAvailable, setStatusAvailable] = createSignal(false);
  const [recoveryIssue, setRecoveryIssue] =
    createSignal<TaskInitialPromptDeliveryRecoveryIssue | null>(null);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  let controller: TaskInitialPromptDraftController | null = null;
  let controllerAgentId: string | null = null;
  let disposed = false;
  let statusRevision = 0;
  let backendEpoch = 0;
  const abort = new AbortController();

  function ensureController(next: TaskInitialPromptDeliveryProjection): void {
    const targetAgentId = next.delivery.agentId;
    if (controllerAgentId && controllerAgentId !== targetAgentId) {
      setNotice('The initial-prompt target changed unexpectedly. Refresh before continuing.');
      return;
    }
    const local = controller?.getSnapshot();
    if (
      !untrack(() => props.retired) &&
      !next.currentDraft &&
      local?.acknowledged &&
      local.visibleText === local.acknowledged.text &&
      !local.inFlight &&
      !local.conflict &&
      !local.saveError
    ) {
      controller = null;
      controllerAgentId = null;
      setDraftState(null);
      setDetailsOpen(false);
      return;
    }
    if (!controller && next.currentDraft) {
      controllerAgentId = targetAgentId;
      controller = createTaskInitialPromptDraftController({
        createEditOperationId: createRandomId,
        deliveryId,
        initialDraft: next.currentDraft,
        onChange: (next) => {
          if (!disposed) setDraftState(next);
        },
        submit: (request) => {
          if (disposed || !editable())
            return Promise.reject(
              new Error('Draft saving is temporarily unavailable. Your text remains local.'),
            );
          return client.initialPromptDelivery.reviseDraft(request, abort.signal);
        },
        taskId,
      });
      setDraftState(controller.getSnapshot());
      return;
    }
    controller?.acknowledge(next.currentDraft);
    if (controller) setDraftState(controller.getSnapshot());
  }

  function applyProjection(incoming: TaskInitialPromptDeliveryProjection): boolean {
    if (disposed || incoming.delivery.deliveryId !== deliveryId) return false;
    if (incoming.delivery.taskId !== taskId) {
      setStatusAvailable(false);
      setStatusError(
        'The initial-prompt task identity changed unexpectedly. Refresh before continuing.',
      );
      setLoading(false);
      return false;
    }
    const current = untrack(projection);
    if (current && current.delivery.agentId !== incoming.delivery.agentId) {
      setStatusAvailable(false);
      setStatusError('The initial-prompt target changed unexpectedly. Refresh before continuing.');
      setLoading(false);
      return false;
    }
    const reduced = reduceTaskInitialPromptDeliveryProjection(current, incoming);
    setProjection(reduced);
    ensureController(reduced);
    setRecoveryIssue(null);
    setStatusError(null);
    setStatusAvailable(true);
    setLoading(false);
    return true;
  }

  async function refresh(preserveNotice = false): Promise<void> {
    if (disposed) return;
    const revision = ++statusRevision;
    const isCurrent = () => !disposed && revision === statusRevision;
    setLoading(true);
    try {
      const capabilities = await client.refreshCapabilities(abort.signal);
      if (!isCurrent()) return;
      if (capabilities.kind !== 'active' || !capabilities.initialPromptDelivery.enabled) {
        setStatusAvailable(false);
        setStatusError('Initial-prompt controls are still starting. The draft remains safe.');
        return;
      }
      const next = await client.initialPromptDelivery.getProjection({ deliveryId }, abort.signal);
      if (!isCurrent()) return;
      if (next && isTaskInitialPromptDeliveryRecoveryIssue(next)) {
        setStatusAvailable(false);
        if (next.deliveryId === deliveryId && next.taskId === taskId) {
          setRecoveryIssue(next);
          setStatusError(
            'This saved prompt cannot be matched safely to its original delivery. Inspect the terminal or copy the saved text; sending is disabled.',
          );
        } else
          setStatusError(
            'Initial-prompt history does not match this task. Refresh before continuing.',
          );
        return;
      }
      if (next) {
        if (!preserveNotice) setNotice(null);
        applyProjection(next);
      } else {
        setStatusAvailable(false);
        setStatusError(
          'Delivery history is unavailable. Refresh status or inspect the terminal before sending.',
        );
      }
    } catch {
      if (isCurrent()) {
        setStatusAvailable(false);
        setStatusError(
          'Initial-prompt status is unavailable. Refresh or inspect the terminal before sending.',
        );
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  onMount(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.kind === 'initial-prompt-delivery-changed') {
        if (event.projection.delivery.deliveryId !== deliveryId) return;
        ++statusRevision;
        applyProjection(event.projection);
      } else if (event.kind === 'task-reliability-capabilities-invalidated') {
        ++backendEpoch;
        ++statusRevision;
        setLoading(false);
        setStatusAvailable(false);
        setStatusError('The backend restarted. Refresh to restore initial-prompt controls.');
      }
    });
    void refresh();
    onCleanup(unsubscribe);
  });

  onCleanup(() => {
    disposed = true;
    abort.abort();
    props.onUnsavedChange?.(false);
  });

  const acknowledgedDraft = createMemo(() => {
    const local = draftState();
    return local ? local.acknowledged : (projection()?.currentDraft ?? null);
  });
  const presentation = createMemo(() => {
    const current = projection();
    return current
      ? getTaskInitialPromptPresentation({ ...current, currentDraft: acknowledgedDraft() })
      : null;
  });
  const tone = createMemo<StatusTone>(() => presentation()?.tone ?? 'neutral');
  const acknowledgedForSend = createMemo(() => {
    const current = projection();
    const draft = draftState();
    return Boolean(
      current &&
      draft &&
      isVisibleInitialPromptDraftAcknowledged({
        agentId: current.delivery.agentId,
        draft: draft.acknowledged,
        taskId,
        visibleText: draft.visibleText,
      }),
    );
  });
  const needsConfirmation = createMemo(() => {
    const operation = projection()?.manualSendOperation;
    return Boolean(
      operation?.phase === 'confirmation-required' &&
      isManualInitialPromptOperationForDraft(operation, acknowledgedDraft()),
    );
  });
  const observedAgentGeneration = createMemo(() => {
    const targetAgentId = projection()?.delivery.agentId;
    if (!targetAgentId) return undefined;
    return (
      props.getAgentGeneration?.(targetAgentId) ??
      (targetAgentId === agentId ? props.agentGeneration : undefined)
    );
  });
  const generationMatches = createMemo(() => {
    const targetGeneration = projection()?.delivery.targetGeneration;
    const observedGeneration = observedAgentGeneration();
    return (
      observedGeneration !== undefined &&
      (targetGeneration === undefined || targetGeneration === observedGeneration)
    );
  });
  const sendAllowed = createMemo(() => {
    const action = presentation()?.action;
    const draft = draftState();
    return Boolean(
      action &&
      (action.kind === 'send' || action.kind === 'retry-proven-not-sent') &&
      presentation()?.actionAllowed &&
      generationMatches() &&
      acknowledgedForSend() &&
      statusAvailable() &&
      !loading() &&
      !props.retired &&
      !props.readOnly &&
      !draft?.conflict &&
      !draft?.inFlight &&
      !busy(),
    );
  });

  const hasUnacknowledgedDraft = createMemo(() => {
    const draft = draftState();
    return Boolean(
      draft &&
      (props.retired ||
        draft.inFlight ||
        draft.trailingEditQueued ||
        draft.conflict ||
        draft.saveError ||
        draft.visibleText !== draft.acknowledged?.text),
    );
  });
  const expanded = () => detailsOpen() || hasUnacknowledgedDraft();
  const visibleDraft = () => draftState()?.visibleText ?? recoveryIssue()?.savedDraft ?? '';
  const hasDraft = () => Boolean(draftState() || recoveryIssue()?.savedDraft);
  const editable = () =>
    !props.retired &&
    !props.readOnly &&
    statusAvailable() &&
    generationMatches() &&
    acknowledgedDraft() !== null;
  const summary = () => {
    if (props.retired) return 'Local prompt edit needs recovery';
    if (statusError())
      return recoveryIssue() ? 'Saved prompt needs recovery' : 'Initial prompt unavailable';
    if (loading()) return 'Checking initial prompt…';
    if (presentation()?.action.kind === 'inspect-and-copy')
      return 'Initial prompt · Delivery uncertain';
    if (projection()?.delivery.priorDeliveryUnknown) return 'Initial prompt · Delivery unknown';
    if (presentation()?.tone === 'success') return 'Initial prompt sent';
    if (presentation()?.action.kind === 'none') return presentation()?.message;
    return presentation()?.tone === 'progress'
      ? 'Initial prompt · Waiting for agent'
      : 'Initial prompt · Needs review';
  };

  createEffect(() => props.onUnsavedChange?.(hasUnacknowledgedDraft()));

  createEffect(() => {
    if (!hasUnacknowledgedDraft()) return;
    const preventDataLoss = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventDataLoss);
    onCleanup(() => window.removeEventListener('beforeunload', preventDataLoss));
  });

  async function sendInitialPrompt(): Promise<void> {
    const current = projection();
    const draft = draftState()?.acknowledged;
    const action = presentation()?.action;
    const expectedAgentGeneration = current?.delivery.targetGeneration ?? observedAgentGeneration();
    if (
      !current ||
      !draft ||
      expectedAgentGeneration === undefined ||
      !sendAllowed() ||
      !action ||
      (action.kind !== 'send' && action.kind !== 'retry-proven-not-sent')
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    const epoch = backendEpoch;
    try {
      const result = await client.initialPromptDelivery.sendManually(
        createManualInitialPromptSendRequest({
          action:
            action.kind === 'retry-proven-not-sent'
              ? { failedAttempt: action.failedAttempt, kind: action.kind }
              : { kind: 'send' },
          agentId: current.delivery.agentId,
          confirmPossiblePriorAutomaticWrite: needsConfirmation(),
          draft,
          deliveryId,
          expectedAgentGeneration,
          taskId,
        }),
        abort.signal,
      );
      if (
        disposed ||
        epoch !== backendEpoch ||
        expectedAgentGeneration !== observedAgentGeneration()
      )
        return;
      setNotice(sendResultMessage(result));
      await refresh(true);
    } catch {
      if (!abort.signal.aborted && epoch === backendEpoch) {
        setNotice(
          'The send result is unavailable. Inspect the terminal and refresh before trying again.',
        );
        setStatusAvailable(false);
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function resolveAmbiguity(
    resolution: 'observed-sent' | 'abandon-to-terminal',
  ): Promise<void> {
    const operation = projection()?.manualSendOperation;
    if (operation?.phase !== 'manual-reconciliation-required' || busy() || !editable() || loading())
      return;
    setBusy(true);
    setNotice(null);
    const epoch = backendEpoch;
    try {
      const result = await client.initialPromptDelivery.resolveAmbiguity(
        {
          expectedOperationVersion: operation.version,
          manualSendOperationId: operation.manualSendOperationId,
          resolution,
        },
        abort.signal,
      );
      if (
        disposed ||
        epoch !== backendEpoch ||
        operation.expectedAgentGeneration !== observedAgentGeneration()
      )
        return;
      if (result.kind === 'resolved') applyProjection(result.projection);
      else {
        setNotice('The prompt status changed before reconciliation. Review the latest status.');
        if (result.current) applyProjection(result.current);
      }
    } catch {
      if (!abort.signal.aborted && epoch === backendEpoch) {
        setNotice('Reconciliation is unavailable. Inspect the terminal and refresh its status.');
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function copyDraft(): Promise<void> {
    const text = visibleDraft();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (!disposed) setNotice('Initial prompt copied.');
    } catch {
      if (!disposed) {
        setDetailsOpen(true);
        setNotice('Copy was unavailable. Select the visible draft and copy it manually.');
      }
    }
  }

  function updateDraft(value: string): void {
    if (!controller || !editable()) return;
    controller.setVisibleText(value);
    setDraftState(controller.getSnapshot());
    void controller.flush();
  }

  async function retrySaveDraft(): Promise<void> {
    if (!controller || !editable() || draftState()?.conflict) return;
    const currentController = controller;
    await currentController.flush();
    if (!disposed && currentController === controller)
      setDraftState(currentController.getSnapshot());
  }

  async function discardRetiredDraft(): Promise<void> {
    const currentController = controller;
    const text = visibleDraft();
    if (!props.retired || !currentController) return;
    const approved = await confirm(
      'Discard this local initial-prompt edit? Copy it first if you still need it.',
      {
        title: 'Discard local draft?',
        kind: 'warning',
        okLabel: 'Discard draft',
        cancelLabel: 'Keep draft',
      },
    );
    if (
      !approved ||
      disposed ||
      !props.retired ||
      controller !== currentController ||
      visibleDraft() !== text
    )
      return;
    abort.abort();
    controller = null;
    setDraftState(null);
  }

  const statusId = `initial-prompt-delivery-status-${deliveryId}`;

  return (
    <section class="initial-prompt-delivery" aria-label="Initial prompt delivery">
      <div class="initial-prompt-delivery__heading">
        <span
          id={statusId}
          class="initial-prompt-delivery__state"
          data-tone={props.retired || statusError() ? 'warning' : tone()}
          role="status"
          aria-live="polite"
        >
          {summary()}
        </span>
        <div class="initial-prompt-delivery__actions">
          <Show when={hasDraft()}>
            <button
              type="button"
              class="compact-action"
              aria-expanded={expanded()}
              aria-controls={`${statusId}-details`}
              disabled={hasUnacknowledgedDraft()}
              onClick={() => {
                const expanded = !detailsOpen();
                setDetailsOpen(expanded);
                props.onDetailsToggle?.(expanded);
              }}
            >
              {expanded()
                ? 'Hide draft'
                : recoveryIssue()
                  ? 'View saved draft'
                  : editable()
                    ? 'Review draft'
                    : 'View draft'}
            </button>
          </Show>
          <Show when={!statusAvailable() || (projection() && !generationMatches())}>
            <button
              type="button"
              class="compact-action"
              disabled={loading()}
              onClick={() => void refresh()}
            >
              {projection() && !generationMatches() ? 'Refresh agent status' : 'Refresh status'}
            </button>
          </Show>
          <Show when={!hasDraft() && props.onInspectTerminal}>
            <button
              type="button"
              class="compact-action"
              onClick={() => props.onInspectTerminal?.(agentId)}
            >
              Inspect terminal
            </button>
          </Show>
        </div>
      </div>

      <div id={`${statusId}-details`} class="initial-prompt-delivery__details" hidden={!expanded()}>
        <div class="initial-prompt-delivery__notice" data-tone={statusError() ? 'warning' : tone()}>
          {props.retired
            ? 'The saved initial prompt was cleared or replaced. Your local edit is preserved here. Copy it, then discard this recovery draft to continue composing.'
            : hasDraft()
              ? (statusError() ?? presentation()?.message)
              : null}
        </div>
        <Show when={hasDraft()}>
          <textarea
            class="initial-prompt-delivery__draft prompt-textarea"
            aria-label="Initial prompt draft"
            aria-describedby={statusId}
            aria-readonly={!editable()}
            readOnly={!editable()}
            value={visibleDraft()}
            onInput={(event) => updateDraft(event.currentTarget.value)}
            rows={2}
          />
        </Show>
        <Show when={draftState()}>
          {(draft) => (
            <>
              <Show when={!props.retired && (draft().inFlight || draft().trailingEditQueued)}>
                <div class="initial-prompt-delivery__save-state" role="status" aria-live="polite">
                  Saving draft…
                </div>
              </Show>
              <Show when={!props.retired && draft().saveError}>
                {(message) => (
                  <div class="initial-prompt-delivery__notice" data-tone="warning" role="status">
                    {message()}
                    <div class="initial-prompt-delivery__recovery-actions">
                      <Show when={!draft().conflict}>
                        <button
                          type="button"
                          class="compact-action"
                          disabled={!editable() || draft().inFlight}
                          onClick={() => void retrySaveDraft()}
                        >
                          Retry save
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={!props.retired && draft().conflict}>
                <div
                  class="initial-prompt-delivery__conflict"
                  role="group"
                  aria-label="Draft conflict"
                >
                  <span>Another session saved a different draft.</span>
                  <button
                    type="button"
                    class="compact-action"
                    onClick={() => controller?.useCurrent()}
                  >
                    Use current
                  </button>
                  <button
                    type="button"
                    class="compact-action"
                    disabled={!editable()}
                    onClick={() => void controller?.replaceConflictWithMine()}
                  >
                    Replace with mine
                  </button>
                </div>
              </Show>
            </>
          )}
        </Show>

        <div class="initial-prompt-delivery__actions">
          <Show when={props.onInspectTerminal}>
            <button
              type="button"
              class="compact-action"
              onClick={() => {
                const targetAgentId = projection()?.delivery.agentId ?? agentId;
                if (targetAgentId) props.onInspectTerminal?.(targetAgentId);
              }}
            >
              Inspect terminal
            </button>
          </Show>
          <Show when={visibleDraft()}>
            <button type="button" class="compact-action" onClick={() => void copyDraft()}>
              Copy draft
            </button>
          </Show>
          <Show when={props.retired && draftState()}>
            <button type="button" class="compact-action" onClick={() => void discardRetiredDraft()}>
              Discard local draft
            </button>
          </Show>
          <Show when={!props.retired && presentation()?.action.kind === 'inspect-and-copy'}>
            <button
              type="button"
              class="compact-action"
              disabled={busy() || !editable() || loading()}
              onClick={() => void resolveAmbiguity('observed-sent')}
            >
              Mark as sent
            </button>
            <button
              type="button"
              class="compact-action"
              disabled={busy() || !editable() || loading()}
              onClick={() => void resolveAmbiguity('abandon-to-terminal')}
            >
              Keep unsent
            </button>
          </Show>
          <Show
            when={
              !props.retired &&
              (presentation()?.action.kind === 'send' ||
                presentation()?.action.kind === 'retry-proven-not-sent')
            }
          >
            <button
              type="button"
              class="compact-action compact-action--primary"
              aria-busy={busy() ? 'true' : undefined}
              aria-describedby={statusId}
              disabled={!sendAllowed()}
              onClick={() => void sendInitialPrompt()}
            >
              {busy()
                ? 'Sending…'
                : needsConfirmation()
                  ? 'Confirm send'
                  : presentation()?.action.kind === 'retry-proven-not-sent'
                    ? 'Retry safe send'
                    : 'Send initial prompt'}
            </button>
          </Show>
        </div>
      </div>
      <Show when={notice()}>
        {(message) => (
          <div
            class="initial-prompt-delivery__notice"
            data-tone="warning"
            role="status"
            aria-live="polite"
          >
            {message()}
          </div>
        )}
      </Show>
      <Show when={!expanded() && statusError() && !hasDraft()}>
        <div class="initial-prompt-delivery__notice" data-tone="warning">
          {statusError()}
        </div>
      </Show>
    </section>
  );
}
