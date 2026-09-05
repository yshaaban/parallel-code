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
import type {
  SendTaskInitialPromptManuallyResult,
  TaskInitialPromptDeliveryProjection,
} from '../domain/task-initial-prompt-delivery';
import { createRandomId } from '../lib/random-id';

interface InitialPromptDeliveryControlProps {
  agentGeneration: number;
  agentId: string;
  deliveryId: string;
  getAgentGeneration?: (agentId: string) => number | undefined;
  onInspectTerminal?: (agentId: string) => void;
  onUnsavedChange?: (unsaved: boolean) => void;
  readOnly?: boolean;
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
  let controller: TaskInitialPromptDraftController | null = null;
  let controllerAgentId: string | null = null;
  let disposed = false;
  const abort = new AbortController();

  function ensureController(next: TaskInitialPromptDeliveryProjection): void {
    const targetAgentId = next.delivery.agentId;
    if (controllerAgentId && controllerAgentId !== targetAgentId) {
      setNotice('The initial-prompt target changed unexpectedly. Refresh before continuing.');
      return;
    }
    if (!controller && next.currentDraft) {
      controllerAgentId = targetAgentId;
      controller = createTaskInitialPromptDraftController({
        createEditOperationId: createRandomId,
        deliveryId,
        initialDraft: next.currentDraft,
        onChange: setDraftState,
        submit: (request) => client.initialPromptDelivery.reviseDraft(request, abort.signal),
        taskId,
      });
      setDraftState(controller.getSnapshot());
      return;
    }
    controller?.acknowledge(next.currentDraft);
    if (controller) setDraftState(controller.getSnapshot());
  }

  function applyProjection(incoming: TaskInitialPromptDeliveryProjection): void {
    if (incoming.delivery.deliveryId !== deliveryId) return;
    if (incoming.delivery.taskId !== taskId) {
      setNotice(
        'The initial-prompt task identity changed unexpectedly. Refresh before continuing.',
      );
      setLoading(false);
      return;
    }
    const current = untrack(projection);
    if (current && current.delivery.agentId !== incoming.delivery.agentId) {
      setNotice('The initial-prompt target changed unexpectedly. Refresh before continuing.');
      setLoading(false);
      return;
    }
    const reduced = reduceTaskInitialPromptDeliveryProjection(current, incoming);
    setProjection(reduced);
    ensureController(reduced);
    setLoading(false);
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    setLoading(true);
    try {
      const capabilities = await client.refreshCapabilities(abort.signal);
      if (capabilities.kind !== 'active' || !capabilities.initialPromptDelivery.enabled) {
        setNotice('Initial-prompt controls are still starting. The draft remains safe.');
        return;
      }
      const next = await client.initialPromptDelivery.getProjection({ deliveryId }, abort.signal);
      if (disposed) return;
      if (next) applyProjection(next);
      else setNotice('Initial-prompt status is temporarily unavailable.');
    } catch (error) {
      if (!abort.signal.aborted) {
        setNotice(error instanceof Error ? error.message : 'Initial-prompt status is unavailable.');
      }
    } finally {
      if (!disposed) setLoading(false);
    }
  }

  onMount(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.kind === 'initial-prompt-delivery-changed') {
        applyProjection(event.projection);
      } else if (event.kind === 'task-reliability-capabilities-invalidated') {
        setNotice('The backend restarted. Refresh to restore initial-prompt controls.');
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
      (draft.inFlight ||
        draft.trailingEditQueued ||
        draft.conflict ||
        draft.saveError ||
        draft.visibleText !== draft.acknowledged?.text),
    );
  });

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
      setNotice(sendResultMessage(result));
      await refresh();
    } catch (error) {
      if (!abort.signal.aborted) {
        setNotice(error instanceof Error ? error.message : 'Initial prompt could not be sent.');
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function resolveAmbiguity(
    resolution: 'observed-sent' | 'abandon-to-terminal',
  ): Promise<void> {
    const operation = projection()?.manualSendOperation;
    if (operation?.phase !== 'manual-reconciliation-required' || busy()) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await client.initialPromptDelivery.resolveAmbiguity(
        {
          expectedOperationVersion: operation.version,
          manualSendOperationId: operation.manualSendOperationId,
          resolution,
        },
        abort.signal,
      );
      if (result.kind === 'resolved') applyProjection(result.projection);
      else {
        setNotice('The prompt status changed before reconciliation. Review the latest status.');
        if (result.current) applyProjection(result.current);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        setNotice(error instanceof Error ? error.message : 'Reconciliation failed.');
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function copyDraft(): Promise<void> {
    const text = draftState()?.visibleText ?? projection()?.currentDraft?.text ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Initial prompt copied.');
    } catch {
      setNotice('Copy was unavailable. Select the visible draft and copy it manually.');
    }
  }

  function updateDraft(value: string): void {
    if (!controller || props.readOnly) return;
    controller.setVisibleText(value);
    setDraftState(controller.getSnapshot());
    void controller.flush();
  }

  async function retrySaveDraft(): Promise<void> {
    if (!controller || props.readOnly || draftState()?.conflict) return;
    await controller.flush();
    setDraftState(controller.getSnapshot());
  }

  const statusId = `initial-prompt-delivery-status-${deliveryId}`;

  return (
    <section class="initial-prompt-delivery" aria-label="Initial prompt delivery">
      <div class="initial-prompt-delivery__heading">
        <span>Initial prompt</span>
        <span
          id={statusId}
          class="initial-prompt-delivery__state"
          data-tone={tone()}
          role="status"
          aria-live="polite"
        >
          {loading() ? 'Loading status…' : (presentation()?.message ?? 'Status unavailable')}
        </span>
      </div>

      <Show when={draftState()}>
        {(draft) => (
          <>
            <textarea
              class="initial-prompt-delivery__draft prompt-textarea"
              aria-label="Initial prompt draft"
              aria-describedby={statusId}
              aria-readonly={props.readOnly ? 'true' : undefined}
              readOnly={props.readOnly}
              value={draft().visibleText}
              onInput={(event) => updateDraft(event.currentTarget.value)}
              rows={2}
            />
            <Show when={draft().inFlight || draft().trailingEditQueued}>
              <div class="initial-prompt-delivery__save-state" role="status" aria-live="polite">
                Saving draft…
              </div>
            </Show>
            <Show when={draft().saveError}>
              {(message) => (
                <div class="initial-prompt-delivery__notice" data-tone="warning" role="status">
                  {message()}
                  <div class="initial-prompt-delivery__recovery-actions">
                    <Show when={!draft().conflict}>
                      <button
                        type="button"
                        class="btn-secondary"
                        disabled={props.readOnly || draft().inFlight}
                        onClick={() => void retrySaveDraft()}
                      >
                        Retry save
                      </button>
                    </Show>
                    <button type="button" class="btn-secondary" onClick={() => void copyDraft()}>
                      Copy draft
                    </button>
                  </div>
                </div>
              )}
            </Show>
            <Show when={draft().conflict}>
              <div
                class="initial-prompt-delivery__conflict"
                role="group"
                aria-label="Draft conflict"
              >
                <span>Another session saved a different draft.</span>
                <button
                  type="button"
                  class="btn-secondary"
                  onClick={() => controller?.useCurrent()}
                >
                  Use current
                </button>
                <button
                  type="button"
                  class="btn-secondary"
                  disabled={props.readOnly}
                  onClick={() => void controller?.replaceConflictWithMine()}
                >
                  Replace with mine
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>

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

      <div class="initial-prompt-delivery__actions">
        <Show when={presentation()?.action.kind === 'inspect-and-copy'}>
          <button
            type="button"
            class="btn-secondary"
            onClick={() => {
              const targetAgentId = projection()?.delivery.agentId;
              if (targetAgentId) props.onInspectTerminal?.(targetAgentId);
            }}
          >
            Inspect terminal
          </button>
          <button type="button" class="btn-secondary" onClick={() => void copyDraft()}>
            Copy draft
          </button>
          <button
            type="button"
            class="btn-secondary"
            disabled={busy()}
            onClick={() => void resolveAmbiguity('observed-sent')}
          >
            Mark as sent
          </button>
          <button
            type="button"
            class="btn-secondary"
            disabled={busy()}
            onClick={() => void resolveAmbiguity('abandon-to-terminal')}
          >
            Keep unsent
          </button>
        </Show>
        <Show
          when={
            presentation()?.action.kind === 'send' ||
            presentation()?.action.kind === 'retry-proven-not-sent'
          }
        >
          <button
            type="button"
            class="btn-primary initial-prompt-delivery__send"
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
        <Show when={!projection() && !loading()}>
          <button type="button" class="btn-secondary" onClick={() => void refresh()}>
            Refresh status
          </button>
        </Show>
        <Show when={projection() && !generationMatches()}>
          <button type="button" class="btn-secondary" onClick={() => void refresh()}>
            Refresh agent status
          </button>
        </Show>
      </div>
    </section>
  );
}
