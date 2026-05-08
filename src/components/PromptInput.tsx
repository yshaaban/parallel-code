import {
  Show,
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
  getAgentOutputTail,
  stripAnsi,
  onAgentReady,
  offAgentReady,
  normalizeForComparison,
  hasReadyPromptInTail,
  looksLikeQuestion,
  isTrustQuestionAutoHandled,
  isAutoTrustSettling,
  isAgentAskingQuestion,
  getTaskFocusedPanel,
  setTaskFocusedPanelState,
  setTaskFocusedPanel,
} from '../store/store';
import { sendAgentEnter, sendPrompt } from '../app/task-workflows';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { createTaskCommandLeaseSession } from '../app/task-command-lease';
import { TaskControlBanner } from './TaskControlBanner';
import { TaskControlChip } from './TaskControlChip';
import { createTaskControlVisualState } from './task-control-visual-state';

export interface PromptInputHandle {
  getText: () => string;
  setText: (value: string) => void;
}

interface PromptInputProps {
  taskId: string;
  agentId: string;
  initialPrompt?: string;
  prefillPrompt?: string;
  onPrefillConsumed?: () => void;
  onSend?: (text: string) => void;
  setTextareaRef?: (element: HTMLTextAreaElement | undefined) => void;
  onHandle?: (handle: PromptInputHandle | undefined) => void;
}

// Quiescence: how often to snapshot and how long output must be stable.
const QUIESCENCE_POLL_MS = 500;
const QUIESCENCE_THRESHOLD_MS = 1_500;
// Never auto-send before this (agent still booting).
const AUTOSEND_MIN_WAIT_MS = 500;
// After detecting the agent's prompt (❯/›), wait this long and re-verify
// it's still visible before sending.  Catches transient prompt renders
// during initialization (e.g. Claude Code renders ❯ before fully loading).
const PROMPT_RECHECK_DELAY_MS = 1_500;
// How many consecutive stability checks must pass before auto-sending.
// Each check verifies ❯ is present AND output hasn't changed since the
// previous check.  Multiple checks catch agents that render ❯ early and
// then silently load (no PTY output) — a single check can't distinguish
// "silently loading" from "truly idle at prompt".
const PROMPT_STABILITY_CHECKS = 2;
// Give up after this.
const AUTOSEND_MAX_WAIT_MS = 45_000;
// After sending, how long to poll terminal output to confirm the prompt appeared.
const PROMPT_VERIFY_TIMEOUT_MS = 5_000;
const PROMPT_VERIFY_POLL_MS = 250;

/** True when auto-send should be blocked by a question in the output.
 *  Trust-dialog questions are NOT blocking when auto-trust handles them. */
function isQuestionBlockingAutoSend(tail: string): boolean {
  if (!looksLikeQuestion(tail)) return false;
  if (isTrustQuestionAutoHandled(tail)) return false;
  return true;
}

function getPromptSendErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  return message || 'Unknown send failure';
}

export function PromptInput(props: PromptInputProps): JSX.Element {
  const taskId = untrack(() => props.taskId);
  const agentId = untrack(() => props.agentId);
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [takingOver, setTakingOver] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [autoSentInitialPrompt, setAutoSentInitialPrompt] = createSignal<string | null>(null);
  let cleanupAutoSend: (() => void) | undefined;
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
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;

    const ip = props.initialPrompt?.trim();
    if (!ip) return;

    updatePromptText(ip);
    if (autoSentInitialPrompt() === ip) return;

    const spawnedAt = Date.now();
    let quiescenceTimer: number | undefined;
    let pendingSendTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRawTail = '';
    let lastNormalized = '';
    let stableSince = Date.now();
    let cancelled = false;

    function cleanup() {
      cancelled = true;
      offAgentReady(agentId);
      if (pendingSendTimer) {
        clearTimeout(pendingSendTimer);
        pendingSendTimer = undefined;
      }
      if (quiescenceTimer !== undefined) {
        clearInterval(quiescenceTimer);
        quiescenceTimer = undefined;
      }
    }
    cleanupAutoSend = cleanup;

    function trySend() {
      if (cancelled) return;
      // Don't tear down the auto-send mechanism if we can't send yet —
      // the quiescence timer needs to stay alive to retry after settling.
      if (isAutoTrustSettling(agentId)) return;
      cleanup();
      void handleSend('auto');
    }

    // --- FAST PATH: event from markAgentOutput ---
    // Fires when a known prompt pattern (❯, ›) is detected in PTY output.
    // The callback is one-shot (deleted after firing in markAgentOutput),
    // so we re-register when a question guard blocks to keep the fast path alive.
    function onReady() {
      if (cancelled) return;
      if (isQuestionBlockingAutoSend(getAgentOutputTail(agentId))) {
        onAgentReady(agentId, onReady);
        return;
      }

      // Start a series of stability checks.  Some agents (e.g. Claude Code)
      // render ❯ before fully initializing — the marker persists while the
      // agent silently loads (no PTY output).  A single stability check
      // can't catch this, so we require PROMPT_STABILITY_CHECKS consecutive
      // checks to pass (output unchanged + ❯ still present in each).
      if (!pendingSendTimer) {
        startStabilityChecks();
      }
    }

    function startStabilityChecks() {
      let checksRemaining = PROMPT_STABILITY_CHECKS;
      const elapsed = Date.now() - spawnedAt;
      const firstDelay = Math.max(PROMPT_RECHECK_DELAY_MS, AUTOSEND_MIN_WAIT_MS - elapsed);

      function scheduleCheck(delay: number) {
        const snapshot = normalizeForComparison(getAgentOutputTail(agentId));
        pendingSendTimer = setTimeout(() => {
          pendingSendTimer = undefined;
          if (cancelled) return;
          const tail = getAgentOutputTail(agentId);
          if (isQuestionBlockingAutoSend(tail)) {
            onAgentReady(agentId, onReady);
            return;
          }
          const normalized = normalizeForComparison(tail);
          if (!hasReadyPromptInTail(tail) || normalized !== snapshot) {
            // Prompt gone or output changed — re-register for next detection.
            onAgentReady(agentId, onReady);
            return;
          }
          checksRemaining--;
          if (checksRemaining <= 0) {
            trySend();
          } else {
            scheduleCheck(PROMPT_RECHECK_DELAY_MS);
          }
        }, delay);
      }

      scheduleCheck(firstDelay);
    }

    onAgentReady(agentId, onReady);

    // --- SLOW PATH: quiescence fallback ---
    // Polls every 500ms.  When a prompt marker (❯/›) is visible, kicks off
    // the same stability checks as the fast path (needed when the agent is
    // idle and no new PTY data would trigger the fast-path callback).
    // For agents without recognizable prompt markers, falls through to pure
    // quiescence (1.5s of stable output).
    quiescenceTimer = window.setInterval(() => {
      if (cancelled) return;
      const elapsed = Date.now() - spawnedAt;

      if (elapsed > AUTOSEND_MAX_WAIT_MS) {
        cleanup();
        return;
      }
      if (elapsed < AUTOSEND_MIN_WAIT_MS) return;
      // After auto-trust acceptance, wait for the agent to fully initialize.
      if (isAutoTrustSettling(agentId)) return;

      const tail = getAgentOutputTail(agentId);
      if (!tail) return;

      // If a prompt marker is visible, use the fast path's stability checks
      // instead of pure quiescence — they verify ❯ persists AND output is stable.
      // Kick off the checks directly rather than just re-registering a callback,
      // because the agent may be idle (no new PTY data to trigger the callback).
      if (hasReadyPromptInTail(tail)) {
        if (!pendingSendTimer) startStabilityChecks();
        return;
      }

      // Skip expensive normalization if raw tail hasn't changed.
      if (tail === lastRawTail) {
        if (stableSince > 0 && Date.now() - stableSince >= QUIESCENCE_THRESHOLD_MS) {
          if (!isQuestionBlockingAutoSend(tail)) {
            trySend();
          } else {
            stableSince = Date.now();
          }
        }
        return;
      }
      lastRawTail = tail;

      const normalized = normalizeForComparison(tail);

      if (normalized !== lastNormalized) {
        lastNormalized = normalized;
        stableSince = Date.now();
        return;
      }

      if (Date.now() - stableSince < QUIESCENCE_THRESHOLD_MS) return;

      // Output stable long enough — check it's not a question.
      if (isQuestionBlockingAutoSend(tail)) {
        stableSince = Date.now();
        return;
      }

      trySend();
    }, QUIESCENCE_POLL_MS);
  });

  createEffect(() => {
    const pf = props.prefillPrompt?.trim();
    if (!pf) return;
    updatePromptText(pf);
    untrack(() => props.onPrefillConsumed?.());
  });

  // When the agent shows a question/dialog, focus the terminal so the user
  // can interact with the TUI directly.
  const questionActive = () => isAgentAskingQuestion(props.agentId);
  const isPromptDisabled = createMemo(() => questionActive() || isPeerControlled());
  createEffect(() => {
    if (questionActive() && getTaskFocusedPanel(props.taskId) === 'prompt') {
      setTaskFocusedPanel(props.taskId, 'ai-terminal');
    }
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
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;
    sendAbortController?.abort();
    promptLeaseSession.cleanup();
    props.setTextareaRef?.(undefined);
    props.onHandle?.(undefined);
  });

  function stopAutoSendTracking(): void {
    cleanupAutoSend?.();
    cleanupAutoSend = undefined;
  }

  function updatePromptText(value: string): void {
    setText(value);
    setSendError(null);
  }

  async function waitForPromptAppearance(
    agentId: string,
    prompt: string,
    preSendTail: string,
    signal: AbortSignal,
  ): Promise<void> {
    const snippet = stripAnsi(prompt).slice(0, 40);
    if (!snippet) return;
    // If the snippet was already visible before send, skip verification
    // to avoid false positives.
    if (stripAnsi(preSendTail).includes(snippet)) return;

    const deadline = Date.now() + PROMPT_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) return;
      const tail = stripAnsi(getAgentOutputTail(agentId));
      if (tail.includes(snippet)) return;
      await new Promise((r) => setTimeout(r, PROMPT_VERIFY_POLL_MS));
    }
  }

  let sendAbortController: AbortController | undefined;

  async function handleSend(mode: 'manual' | 'auto' = 'manual') {
    if (sending()) return;
    if (mode === 'manual' && isPeerControlled()) {
      controlVisualState.expandBanner();
      return;
    }
    // Block sends while the agent is showing a question/dialog.
    // For auto-sends, use a fresh tail-buffer check instead of the reactive
    // signal — the signal may be stale (updated by throttled analysis) while
    // the callers (onReady, quiescence timer) already verified with fresh data.
    if (mode === 'auto') {
      if (isQuestionBlockingAutoSend(getAgentOutputTail(agentId))) return;
      if (isAutoTrustSettling(agentId)) return;
    } else {
      if (questionActive()) return;
    }
    if (mode === 'manual') {
      stopAutoSendTracking();
    }

    const val = text().trim();
    if (!val) {
      if (mode === 'auto') return;
      setSendError(null);
      void sendAgentEnter(taskId, agentId, { confirmTakeover: false })
        .then((sent) => {
          if (!sent) {
            setSendError('Prompt was not sent because another client controls this task.');
            controlVisualState.expandBanner();
            return;
          }

          setSendError(null);
        })
        .catch((error: unknown) => {
          console.error('Failed to send prompt enter:', error);
          setSendError(`Prompt send failed: ${getPromptSendErrorMessage(error)}`);
          controlVisualState.expandBanner();
        });
      return;
    }

    sendAbortController?.abort();
    sendAbortController = new AbortController();
    const { signal } = sendAbortController;

    setSending(true);
    setSendError(null);
    try {
      // Snapshot tail before send for verification comparison.
      const preSendTail = getAgentOutputTail(agentId);
      const sent = await sendPrompt(taskId, agentId, val, {
        confirmTakeover: false,
      });
      if (!sent || signal.aborted) {
        if (!signal.aborted && mode === 'manual') {
          setSendError('Prompt was not sent because another client controls this task.');
          controlVisualState.expandBanner();
        }
        return;
      }

      stopAutoSendTracking();
      if (mode === 'auto') {
        await waitForPromptAppearance(agentId, val, preSendTail, signal);
      }

      if (props.initialPrompt?.trim()) {
        setAutoSentInitialPrompt(props.initialPrompt.trim());
      }
      props.onSend?.(val);
      setText('');
      setSendError(null);
    } catch (e) {
      console.error('Failed to send prompt:', e);
      setSendError(`Prompt send failed: ${getPromptSendErrorMessage(e)}`);
      if (mode === 'manual') {
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
    try {
      const acquired = await promptLeaseSession.takeOver();
      if (acquired) {
        setSendError(null);
        setTaskFocusedPanelState(props.taskId, 'prompt');
        textareaRef?.focus();
      }
    } finally {
      setTakingOver(false);
    }
  }

  function getPromptPlaceholder(): string {
    if (questionActive()) {
      return 'Agent is waiting for input in terminal…';
    }

    if (isPeerControlled()) {
      return 'Another browser session is controlling this task…';
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
      <div style={{ position: 'relative', flex: '1', display: 'flex' }}>
        <textarea
          class="prompt-textarea"
          ref={(el) => {
            textareaRef = el;
            props.setTextareaRef?.(el);
          }}
          rows={3}
          value={text()}
          disabled={isPromptDisabled()}
          onInput={(e) => updatePromptText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
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
            outline: 'none',
            opacity: isPromptDisabled() ? '0.5' : '1',
          }}
        />
        <button
          class="prompt-send-btn"
          type="button"
          disabled={!text().trim() || isPromptDisabled()}
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
            cursor: text().trim() ? 'pointer' : 'default',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            padding: '0',
            transition: 'background 0.15s, color 0.15s',
          }}
          title="Send prompt"
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
        </button>
      </div>
    </div>
  );
}
