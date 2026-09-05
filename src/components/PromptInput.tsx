import {
  Show,
  Suspense,
  createMemo,
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  untrack,
  type JSX,
} from 'solid-js';
import {
  registerFocusFn,
  unregisterFocusFn,
  registerAction,
  unregisterAction,
  getLocalAgentQuestionGeneration,
  getTaskFocusedPanel,
  setActiveAgent,
  setTaskFocusedPanel,
  setTaskFocusedPanelState,
  store,
} from '../store/store';
import { sendPrompt } from '../app/task-workflows';
import { nextCoordinatorActivityHintSeq, sendCoordinatorActivityHint } from '../app/coordinator';
import {
  getPromptCanonicalAgentState,
  getPromptInputPolicy,
  type PromptInputFacts,
} from '../app/prompt-input-policy';
import {
  clearPromptQuestionAgreementObservation,
  recordPromptDispatchBlocked,
  recordPromptDraftPreservedAfterSend,
  recordPromptQuestionAgreementObservation,
} from '../app/runtime-diagnostics';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { lazyNamed } from '../lib/lazy-named';
import { createTaskCommandLeaseSession } from '../app/task-command-lease';
import { TaskControlBanner } from './TaskControlBanner';
import { TaskControlChip } from './TaskControlChip';
import { createTaskControlVisualState } from './task-control-visual-state';

const InitialPromptDeliveryControl = lazyNamed(
  () => import('./InitialPromptDeliveryControl'),
  'InitialPromptDeliveryControl',
);

export interface PromptInputHandle {
  getText: () => string;
  setText: (value: string) => void;
}

interface PromptInputProps {
  taskId: string;
  agentId: string;
  initialPromptDeliveryId?: string;
  onInitialPromptUnsavedChange?: (unsaved: boolean) => void;
  prefillPrompt?: string;
  onPrefillConsumed?: () => void;
  onSend?: (text: string) => void;
  setTextareaRef?: (element: HTMLTextAreaElement | undefined) => void;
  onHandle?: (handle: PromptInputHandle | undefined) => void;
}

function getPromptSendErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  return message || 'Unknown send failure';
}

export function PromptInput(props: PromptInputProps): JSX.Element {
  const taskId = untrack(() => props.taskId);
  const agentId = untrack(() => props.agentId);
  const [text, setText] = createSignal('');
  const [draftRevision, setDraftRevision] = createSignal(0);
  const [composing, setComposing] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [takingOver, setTakingOver] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  let promptDraftHintTimer: ReturnType<typeof setTimeout> | undefined;
  let takeOverGeneration = 0;
  const promptLeaseSession = createTaskCommandLeaseSession(taskId, 'send a prompt', {
    confirmTakeover: false,
  });
  const controlVisualState = createTaskControlVisualState({
    fallbackAction: 'send a prompt',
    isActive: () => getTaskFocusedPanel(taskId) === 'prompt',
    taskId,
  });
  const isPeerControlled = createMemo(() => Boolean(controlVisualState.status()));
  const readOnlyBorder = createMemo(() => theme.warning ?? '#d4a017');

  createEffect(() => {
    const pf = props.prefillPrompt?.trim();
    if (!pf) return;
    updatePromptText(pf);
    untrack(() => props.onPrefillConsumed?.());
  });

  function getQuestionFacts(): Pick<
    PromptInputFacts,
    'canonicalAgentState' | 'canonicalGeneration' | 'localQuestionGeneration'
  > {
    const canonicalGeneration = store.agents[agentId]?.generation ?? 0;
    const localQuestionGeneration = getLocalAgentQuestionGeneration(agentId, canonicalGeneration);
    return {
      canonicalAgentState: getPromptCanonicalAgentState(
        store.agentSupervision[agentId]?.state,
        store.agents[agentId]?.status,
        {
          canonicalGeneration,
          ...(store.agentSupervision[agentId]?.generation !== undefined
            ? { supervisionGeneration: store.agentSupervision[agentId].generation }
            : {}),
        },
      ),
      canonicalGeneration,
      ...(localQuestionGeneration !== undefined ? { localQuestionGeneration } : {}),
    };
  }

  function getPolicyFacts(composingOverride = composing()): PromptInputFacts {
    const questionFacts = getQuestionFacts();
    return {
      ...questionFacts,
      composing: composingOverride,
      control: isPeerControlled() ? 'peer' : 'local',
      hasText: text().trim().length > 0,
      sendInFlight: sending(),
    };
  }

  const promptPolicy = createMemo(() => getPromptInputPolicy(getPolicyFacts()));
  const questionActive = () => promptPolicy().dispatchBlock === 'agent-question';
  const explanationId = `prompt-input-explanation-${agentId}`;
  let observedQuestionGeneration: number | undefined;

  createEffect(() => {
    const facts = getQuestionFacts();
    if (
      observedQuestionGeneration !== undefined &&
      observedQuestionGeneration !== facts.canonicalGeneration
    ) {
      clearPromptQuestionAgreementObservation(agentId, observedQuestionGeneration);
    }
    observedQuestionGeneration = facts.canonicalGeneration;
    recordPromptQuestionAgreementObservation({
      agentId,
      canonicalQuestionActive: facts.canonicalAgentState === 'awaiting-input',
      generation: facts.canonicalGeneration,
      localQuestionActive: facts.localQuestionGeneration === facts.canonicalGeneration,
    });
  });

  let textareaRef: HTMLTextAreaElement | undefined;

  onMount(() => {
    props.onHandle?.({ getText: text, setText: updatePromptText });
    const focusKey = `${props.taskId}:prompt`;
    const actionKey = `${props.taskId}:send-prompt`;
    registerFocusFn(focusKey, () => textareaRef?.focus());
    registerAction(actionKey, () => handleSend());
    onCleanup(() => {
      unregisterFocusFn(focusKey);
      unregisterAction(actionKey);
    });
  });

  onCleanup(() => {
    takeOverGeneration += 1;
    setTakingOver(false);
    sendAbortController?.abort();
    if (promptDraftHintTimer !== undefined) {
      clearTimeout(promptDraftHintTimer);
      promptDraftHintTimer = undefined;
    }
    promptLeaseSession.cleanup();
    if (observedQuestionGeneration !== undefined) {
      clearPromptQuestionAgreementObservation(agentId, observedQuestionGeneration);
    }
    props.setTextareaRef?.(undefined);
    props.onHandle?.(undefined);
  });

  function updatePromptText(value: string): void {
    if (value === untrack(text)) {
      return;
    }
    setText(value);
    setDraftRevision((revision) => revision + 1);
    setSendError(null);
    schedulePromptDraftHint(value);
  }

  function sendPromptActivityHint(
    kind: 'manual-prompt-sent' | 'prompt-draft',
    ttlMs: number,
    blocked = true,
  ): void {
    if (store.tasks[taskId]?.coordinatorRole !== 'subtask') {
      return;
    }

    void sendCoordinatorActivityHint({
      agentGeneration: store.agents[agentId]?.generation ?? 0,
      blocked,
      clientId: getRuntimeClientId(),
      kind,
      seq: nextCoordinatorActivityHintSeq(),
      taskId,
      ...(ttlMs > 0 ? { ttlMs } : {}),
    }).catch(() => {});
  }

  function clearPromptDraftActivityHint(): void {
    sendPromptActivityHint('prompt-draft', 0, false);
  }

  function schedulePromptDraftHint(value: string): void {
    if (promptDraftHintTimer !== undefined) {
      clearTimeout(promptDraftHintTimer);
      promptDraftHintTimer = undefined;
    }
    if (value.trim().length === 0) {
      clearPromptDraftActivityHint();
      return;
    }

    promptDraftHintTimer = setTimeout(() => {
      promptDraftHintTimer = undefined;
      if (text().trim().length > 0) {
        sendPromptActivityHint('prompt-draft', 5_000);
      }
    }, 300);
  }

  let sendAbortController: AbortController | undefined;

  async function handleSend(): Promise<void> {
    if (sending()) {
      recordPromptDispatchBlocked('send-in-flight');
      return;
    }
    const policy = getPromptInputPolicy(getPolicyFacts());
    if (!policy.dispatchAllowed) {
      if (policy.dispatchBlock) {
        recordPromptDispatchBlocked(policy.dispatchBlock);
      }
      if (policy.dispatchBlock === 'peer-controlled') {
        controlVisualState.expandBanner();
      }
      return;
    }
    sendPromptActivityHint('manual-prompt-sent', 1_500);

    const dispatchedDraft = text();
    const dispatchedRevision = draftRevision();
    const val = dispatchedDraft.trim();
    if (!val) {
      return;
    }

    sendAbortController?.abort();
    sendAbortController = new AbortController();
    const { signal } = sendAbortController;

    setSending(true);
    setSendError(null);
    try {
      const sent = await sendPrompt(taskId, agentId, val, {
        confirmTakeover: false,
      });
      if (!sent || signal.aborted) {
        if (!signal.aborted) {
          recordPromptDispatchBlocked('peer-controlled');
          setSendError('Prompt was not sent because another client controls this task.');
          controlVisualState.expandBanner();
        }
        return;
      }

      props.onSend?.(val);
      if (text() === dispatchedDraft && draftRevision() === dispatchedRevision) {
        setText('');
        setDraftRevision((revision) => revision + 1);
        clearPromptDraftActivityHint();
      } else {
        recordPromptDraftPreservedAfterSend();
      }
      setSendError(null);
    } catch (e) {
      console.error('Failed to send prompt:', e);
      if (!signal.aborted) {
        setSendError(`Prompt send failed: ${getPromptSendErrorMessage(e)}`);
        controlVisualState.expandBanner();
      }
    } finally {
      setSending(false);
    }
  }

  async function handleTakeOver(): Promise<void> {
    if (takingOver()) {
      return;
    }

    setTakingOver(true);
    const generation = ++takeOverGeneration;
    try {
      const acquired = await promptLeaseSession.takeOver();
      if (!acquired || generation !== takeOverGeneration) {
        return;
      }

      setSendError(null);
      setTaskFocusedPanelState(taskId, 'prompt');
      textareaRef?.focus();
    } finally {
      if (generation === takeOverGeneration) {
        setTakingOver(false);
      }
    }
  }

  function getPromptPlaceholder(): string {
    if (promptPolicy().readOnlyReason === 'peer-controlled') {
      return 'Another browser session is controlling this task…';
    }

    if (questionActive()) {
      return 'Draft an answer while you respond in the terminal…';
    }

    return 'Send a prompt... (Enter to send, Shift+Enter for newline)';
  }

  return (
    <div
      class="focusable-panel prompt-input-panel"
      style={{
        display: 'flex',
        height: '100%',
        padding: '4px 6px',
        'border-radius': '12px',
        'flex-direction': 'column',
        gap: '8px',
        'box-shadow': isPeerControlled()
          ? `inset 0 0 0 1px color-mix(in srgb, ${readOnlyBorder()} 60%, ${theme.border})`
          : undefined,
      }}
    >
      <Show when={controlVisualState.isBannerVisible() && controlVisualState.status()}>
        {(status) => (
          <TaskControlBanner
            busy={takingOver()}
            message={status().message}
            onDismiss={controlVisualState.dismissBanner}
            onTakeOver={() => {
              void handleTakeOver();
            }}
            takeOverLabel="Take Over Prompt"
          />
        )}
      </Show>
      <Show when={!controlVisualState.isBannerVisible() && controlVisualState.status()}>
        {(status) => (
          <TaskControlChip
            busy={takingOver()}
            label={status().label}
            onTakeOver={() => {
              void handleTakeOver();
            }}
            takeOverLabel="Take Over Prompt"
          />
        )}
      </Show>
      <Show when={props.initialPromptDeliveryId} keyed>
        {(deliveryId) => (
          <Suspense
            fallback={
              <section class="initial-prompt-delivery" aria-label="Initial prompt delivery">
                <span class="initial-prompt-delivery__state" role="status" aria-live="polite">
                  Loading initial prompt status…
                </span>
              </section>
            }
          >
            <InitialPromptDeliveryControl
              agentGeneration={store.agents[agentId]?.generation ?? 0}
              agentId={agentId}
              deliveryId={deliveryId}
              getAgentGeneration={(targetAgentId) => store.agents[targetAgentId]?.generation}
              onInspectTerminal={(targetAgentId) => {
                setActiveAgent(targetAgentId);
                setTaskFocusedPanel(taskId, 'ai-terminal');
              }}
              onUnsavedChange={props.onInitialPromptUnsavedChange}
              readOnly={isPeerControlled()}
              taskId={taskId}
            />
          </Suspense>
        )}
      </Show>
      <Show when={!props.initialPromptDeliveryId}>
        <>
          <Show when={sendError()}>
            {(message) => (
              <div
                role="status"
                aria-live="polite"
                style={{
                  color: theme.error,
                  background: `color-mix(in srgb, ${theme.error} 8%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${theme.error} 20%, transparent)`,
                  'border-radius': '8px',
                  padding: '5px 8px',
                  'font-size': sf(11),
                  'line-height': '1.35',
                }}
              >
                {message()}
              </div>
            )}
          </Show>
          <Show when={promptPolicy().explanation}>
            {(explanation) => (
              <div
                id={explanationId}
                role="status"
                aria-live="polite"
                style={{
                  color: theme.fgMuted,
                  'font-size': sf(11),
                  'line-height': '1.35',
                  padding: '0 4px',
                }}
              >
                {explanation() === 'peer-controlled'
                  ? 'Another session controls this prompt. Take over to edit or send.'
                  : explanation() === 'answer-in-terminal'
                    ? 'Answer the question in the terminal; you can draft here while you work.'
                    : 'Sending this draft; new edits will be preserved.'}
              </div>
            )}
          </Show>
          <div style={{ position: 'relative', flex: '1', display: 'flex' }}>
            <textarea
              class="prompt-textarea"
              ref={(el) => {
                textareaRef = el;
                props.setTextareaRef?.(el);
              }}
              rows={3}
              value={text()}
              readOnly={!promptPolicy().editable}
              aria-readonly={!promptPolicy().editable ? 'true' : undefined}
              aria-describedby={promptPolicy().explanation ? explanationId : undefined}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onInput={(e) => updatePromptText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) {
                  return;
                }

                const keyPolicy = getPromptInputPolicy(
                  getPolicyFacts(e.isComposing || composing()),
                );
                if (keyPolicy.enterAction === 'send') {
                  e.preventDefault();
                  void handleSend();
                } else if (keyPolicy.enterAction === 'ignore' && !e.isComposing && !composing()) {
                  e.preventDefault();
                }
              }}
              placeholder={getPromptPlaceholder()}
              style={{
                flex: '1',
                background: theme.bgInput,
                border: isPeerControlled()
                  ? `1px solid color-mix(in srgb, ${readOnlyBorder()} 60%, ${theme.border})`
                  : `1px solid ${theme.border}`,
                'border-radius': '12px',
                padding: '6px 36px 6px 10px',
                color: theme.fg,
                'font-size': sf(12),
                'font-family': "'JetBrains Mono', monospace",
                resize: 'none',
                // The draft dims while a send is in flight but is only cleared on
                // success, so a failed send restores the text at full strength.
                opacity: !promptPolicy().editable ? '0.5' : sending() ? '0.6' : '1',
              }}
            />
            <button
              class="prompt-send-btn"
              type="button"
              aria-busy={sending() ? 'true' : undefined}
              aria-describedby={promptPolicy().explanation ? explanationId : undefined}
              disabled={!promptPolicy().dispatchAllowed}
              onClick={() => handleSend()}
              style={{
                position: 'absolute',
                right: '6px',
                bottom: '6px',
                width: '24px',
                height: '24px',
                'border-radius': '50%',
                border: 'none',
                background: text().trim() ? theme.accent : theme.bgHover,
                color: text().trim() ? theme.accentText : theme.fgSubtle,
                cursor: promptPolicy().dispatchAllowed ? 'pointer' : 'default',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                padding: '0',
                transition: 'background 0.15s, color 0.15s',
              }}
              title={sending() ? 'Sending prompt…' : 'Send prompt'}
            >
              <Show
                when={!sending()}
                fallback={
                  <span
                    class="inline-spinner"
                    aria-hidden="true"
                    style={{ width: '12px', height: '12px' }}
                  />
                }
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M7 12V2M7 2L3 6M7 2l4 4"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </Show>
            </button>
          </div>
        </>
      </Show>
    </div>
  );
}
