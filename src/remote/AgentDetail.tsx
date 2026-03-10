import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  subscribeAgent,
  unsubscribeAgent,
  onOutput,
  onScrollback,
  sendInput,
  sendKill,
  send,
  agents,
  status,
} from './ws';

const B64 = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

function b64decode(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61) end--;
  const out = new Uint8Array((end * 3) >>> 2);
  let j = 0;
  for (let i = 0; i < end; ) {
    const a = B64[b64.charCodeAt(i++)];
    const b = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const c = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const d = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    out[j++] = (triplet >>> 16) & 0xff;
    if (j < out.length) out[j++] = (triplet >>> 8) & 0xff;
    if (j < out.length) out[j++] = triplet & 0xff;
  }
  return out;
}

const KEYS: Record<number, string> = {};
[3, 4, 9, 12, 13, 26, 27].forEach((code) => {
  KEYS[code] = String.fromCharCode(code);
});

function key(code: number): string {
  return KEYS[code];
}

function haptic() {
  if ('vibrate' in navigator) navigator.vibrate(8);
}

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
}

interface QuickAction {
  label: string;
  ariaLabel: string;
  data: () => string;
  repeatable?: boolean;
}

interface QuickActionGroup {
  label: string;
  actions: QuickAction[];
}

const MIN_FONT = 6;
const MAX_FONT = 24;
const SWIPE_EDGE_PX = 28;
const SWIPE_TRIGGER_PX = 72;

export function AgentDetail(props: AgentDetailProps) {
  let detailRoot: HTMLDivElement | undefined;
  let termContainer: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let currentAgentId = '';

  const [inputText, setInputText] = createSignal('');
  const [atBottom, setAtBottom] = createSignal(true);
  const [termFontSize, setTermFontSize] = createSignal(10);
  const [agentMissing, setAgentMissing] = createSignal(false);
  const [showKillConfirm, setShowKillConfirm] = createSignal(false);
  const [fontToast, setFontToast] = createSignal<string | null>(null);
  const [statusFlashClass, setStatusFlashClass] = createSignal('');
  const [swipeOffset, setSwipeOffset] = createSignal(0);

  const agentInfo = () => agents().find((agent) => agent.agentId === props.agentId);
  const isRecoveringConnection = () => status() === 'connecting' || status() === 'reconnecting';
  const connectionBannerText = () => {
    if (status() === 'connecting') return 'Connecting...';
    if (status() === 'reconnecting') return 'Reconnecting...';
    return 'Disconnected - check your network';
  };

  let fitRaf = 0;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let missingAgentTimer: ReturnType<typeof setTimeout> | null = null;
  let fontToastTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatIntervalTimer: ReturnType<typeof setInterval> | null = null;
  let restoringScrollback = false;
  let hasTerminalData = false;
  let agentMissingValue = false;
  let bufferedOutput: Uint8Array[] = [];
  let repeatTriggered = false;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeTracking = false;
  let swipeConfirmed = false;

  createEffect(
    on(
      () => agentInfo()?.status,
      (next, prev) => {
        if (next && prev && next !== prev) {
          setStatusFlashClass((current) =>
            current === 'status-flash-a' ? 'status-flash-b' : 'status-flash-a',
          );
        }
      },
    ),
  );

  function updateAgentMissing(value: boolean) {
    agentMissingValue = value;
    setAgentMissing(value);
  }

  function clearFontToastTimer() {
    if (fontToastTimer) {
      clearTimeout(fontToastTimer);
      fontToastTimer = null;
    }
  }

  function showFontSizeToast(nextSize: number) {
    setFontToast(`Text ${nextSize}px`);
    clearFontToastTimer();
    fontToastTimer = setTimeout(() => {
      setFontToast(null);
      fontToastTimer = null;
    }, 900);
  }

  function applyFontSize(nextSize: number) {
    setTermFontSize(nextSize);
    if (term) {
      term.options.fontSize = nextSize;
      fitAndResize();
    }
    showFontSizeToast(nextSize);
  }

  function clearMissingAgentTimer() {
    if (missingAgentTimer) {
      clearTimeout(missingAgentTimer);
      missingAgentTimer = null;
    }
  }

  function startMissingAgentTimer() {
    clearMissingAgentTimer();
    missingAgentTimer = setTimeout(() => {
      if (hasTerminalData) return;
      const exists = agents().some((agent) => agent.agentId === currentAgentId);
      if (!exists) updateAgentMissing(true);
    }, 3000);
  }

  function markTerminalActive() {
    hasTerminalData = true;
    updateAgentMissing(false);
    clearMissingAgentTimer();
  }

  function flushBufferedOutput() {
    if (!term || bufferedOutput.length === 0) return;
    const queued = bufferedOutput;
    bufferedOutput = [];
    for (const chunk of queued) {
      term.write(chunk);
    }
  }

  function scheduleResizeSend() {
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      if (!term) return;
      send({
        type: 'resize',
        agentId: currentAgentId,
        cols: term.cols,
        rows: term.rows,
      });
    }, 100);
  }

  function fitAndResize() {
    fitAddon?.fit();
    scheduleResizeSend();
  }

  function scheduleFitAndResize() {
    cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => fitAndResize());
  }

  function stopQuickActionRepeat() {
    if (repeatDelayTimer) {
      clearTimeout(repeatDelayTimer);
      repeatDelayTimer = null;
    }
    if (repeatIntervalTimer) {
      clearInterval(repeatIntervalTimer);
      repeatIntervalTimer = null;
    }
    repeatTriggered = false;
  }

  function handleSend() {
    if (agentMissing()) return;
    const text = inputText();
    if (!text) return;
    haptic();
    sendInput(currentAgentId, text + key(13));
    setInputText('');
    inputRef?.focus();
  }

  function handleQuickAction(data: string) {
    if (agentMissing()) return;
    haptic();
    sendInput(currentAgentId, data);
  }

  function handleQuickActionPointerDown(event: PointerEvent, action: QuickAction) {
    if (!action.repeatable || agentMissing()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const button = event.currentTarget as HTMLButtonElement;
    button.setPointerCapture?.(event.pointerId);
    stopQuickActionRepeat();
    repeatDelayTimer = setTimeout(() => {
      if (agentMissing()) return;
      repeatTriggered = true;
      haptic();
      sendInput(currentAgentId, action.data());
      repeatIntervalTimer = setInterval(() => {
        if (agentMissing()) {
          stopQuickActionRepeat();
          return;
        }
        sendInput(currentAgentId, action.data());
      }, 90);
    }, 320);
  }

  function handleQuickActionPointerUp(event: PointerEvent, action: QuickAction) {
    if (!action.repeatable) return;
    const button = event.currentTarget as HTMLButtonElement;
    if (button.hasPointerCapture?.(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }

    const wasRepeating = repeatTriggered;
    stopQuickActionRepeat();
    if (!wasRepeating) {
      handleQuickAction(action.data());
    }
  }

  function handleQuickActionPointerCancel(event: PointerEvent) {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.hasPointerCapture?.(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }
    stopQuickActionRepeat();
  }

  function handleQuickActionClick(event: MouseEvent, action: QuickAction) {
    if (!action.repeatable) {
      handleQuickAction(action.data());
      return;
    }

    if (event.detail === 0) {
      handleQuickAction(action.data());
    }
  }

  function handleKill() {
    haptic();
    sendKill(currentAgentId);
    setShowKillConfirm(false);
  }

  function scrollToBottom() {
    term?.scrollToBottom();
  }

  const quickActionGroups: QuickActionGroup[] = [
    {
      label: 'Keys',
      actions: [
        { label: 'Enter', ariaLabel: 'Send Enter key', data: () => key(13) },
        { label: 'Tab', ariaLabel: 'Send Tab key', data: () => key(9) },
        { label: 'Esc', ariaLabel: 'Send Escape key', data: () => key(27) },
      ],
    },
    {
      label: 'Navigation',
      actions: [
        {
          label: '\u2191',
          ariaLabel: 'Send up arrow. Long press to repeat.',
          data: () => key(27) + '[A',
          repeatable: true,
        },
        {
          label: '\u2193',
          ariaLabel: 'Send down arrow. Long press to repeat.',
          data: () => key(27) + '[B',
          repeatable: true,
        },
        {
          label: '\u2190',
          ariaLabel: 'Send left arrow. Long press to repeat.',
          data: () => key(27) + '[D',
          repeatable: true,
        },
        {
          label: '\u2192',
          ariaLabel: 'Send right arrow. Long press to repeat.',
          data: () => key(27) + '[C',
          repeatable: true,
        },
      ],
    },
    {
      label: 'Signals',
      actions: [
        { label: 'Ctrl+C', ariaLabel: 'Send Control C', data: () => key(3) },
        { label: 'Ctrl+D', ariaLabel: 'Send Control D', data: () => key(4) },
        { label: 'Ctrl+Z', ariaLabel: 'Send Control Z', data: () => key(26) },
        { label: 'Ctrl+L', ariaLabel: 'Send Control L', data: () => key(12) },
      ],
    },
  ];

  onMount(() => {
    if (!detailRoot || !termContainer) return;
    currentAgentId = props.agentId;

    if (inputRef) {
      const enterHandler = (event: Event) => {
        const keyEvent = event as KeyboardEvent;
        if (keyEvent.key === 'Enter' || keyEvent.keyCode === 13) {
          event.preventDefault();
          handleSend();
        }
      };
      inputRef.addEventListener('keydown', enterHandler);
      onCleanup(() => {
        inputRef?.removeEventListener('keydown', enterHandler);
      });
    }

    term = new Terminal({
      fontSize: 10,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      theme: { background: '#0b0f14' },
      scrollback: 5000,
      cursorBlink: false,
      convertEol: false,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);

    term.onData((data) => {
      if (agentMissingValue) return;
      sendInput(currentAgentId, data);
    });

    term.onScroll(() => {
      if (!term) return;
      const isBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      setAtBottom(isBottom);
    });

    const cleanupScrollback = onScrollback(currentAgentId, (data, cols) => {
      markTerminalActive();
      if (term && cols > 0) {
        term.resize(cols, term.rows);
      }
      restoringScrollback = true;
      bufferedOutput = [];
      term?.clear();
      const bytes = b64decode(data);
      term?.write(bytes, () => {
        restoringScrollback = false;
        flushBufferedOutput();
        term?.scrollToBottom();
        scheduleFitAndResize();
      });
    });

    const cleanupOutput = onOutput(currentAgentId, (data) => {
      markTerminalActive();
      const bytes = b64decode(data);
      if (restoringScrollback) {
        bufferedOutput.push(bytes);
        return;
      }
      term?.write(bytes);
    });

    fitAndResize();
    subscribeAgent(currentAgentId);
    startMissingAgentTimer();

    const observer = new ResizeObserver(() => {
      scheduleFitAndResize();
    });
    observer.observe(termContainer);

    const onWindowResize = () => scheduleFitAndResize();
    window.addEventListener('resize', onWindowResize);

    const onOrientationChange = () => scheduleFitAndResize();
    window.addEventListener('orientationchange', onOrientationChange);

    let swipeShouldCancelTerminalScroll = false;
    const onSwipeStart = (event: TouchEvent) => {
      if (showKillConfirm() || agentMissing() || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.clientX > SWIPE_EDGE_PX) return;

      swipeStartX = touch.clientX;
      swipeStartY = touch.clientY;
      swipeTracking = true;
      swipeConfirmed = false;
      swipeShouldCancelTerminalScroll = false;
    };

    const onSwipeMove = (event: TouchEvent) => {
      if (!swipeTracking || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - swipeStartX;
      const deltaY = touch.clientY - swipeStartY;

      if (!swipeConfirmed) {
        if (Math.abs(deltaY) > 16 && Math.abs(deltaY) > Math.max(deltaX, 0)) {
          swipeTracking = false;
          setSwipeOffset(0);
          return;
        }
        if (deltaX > 12 && deltaX > Math.abs(deltaY)) {
          swipeConfirmed = true;
          swipeShouldCancelTerminalScroll = true;
        }
      }

      if (!swipeConfirmed) return;

      const nextOffset = Math.max(0, Math.min(deltaX, 120));
      setSwipeOffset(nextOffset);
      event.preventDefault();
    };

    const onSwipeEnd = () => {
      if (!swipeTracking) return;

      swipeTracking = false;
      swipeShouldCancelTerminalScroll = false;
      if (swipeConfirmed && swipeOffset() >= SWIPE_TRIGGER_PX) {
        haptic();
        props.onBack();
        return;
      }

      swipeConfirmed = false;
      setSwipeOffset(0);
    };

    if (window.visualViewport) {
      const onViewportResize = () => scheduleFitAndResize();
      window.visualViewport.addEventListener('resize', onViewportResize);
      onCleanup(() => window.visualViewport?.removeEventListener('resize', onViewportResize));
    }

    let touchStartY = 0;
    let touchActive = false;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        touchStartY = event.touches[0].clientY;
        touchActive = true;
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (swipeShouldCancelTerminalScroll || !touchActive || !term || event.touches.length !== 1) {
        return;
      }
      const deltaY = touchStartY - event.touches[0].clientY;
      const lineHeight = term.options.fontSize ?? 13;
      const lines = Math.trunc(deltaY / lineHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchStartY = event.touches[0].clientY;
      }
      event.preventDefault();
    };
    const onTouchEnd = () => {
      touchActive = false;
    };

    termContainer.addEventListener('touchstart', onTouchStart, { passive: true });
    termContainer.addEventListener('touchmove', onTouchMove, { passive: false });
    termContainer.addEventListener('touchend', onTouchEnd, { passive: true });

    detailRoot.addEventListener('touchstart', onSwipeStart, { capture: true, passive: true });
    detailRoot.addEventListener('touchmove', onSwipeMove, { capture: true, passive: false });
    detailRoot.addEventListener('touchend', onSwipeEnd, { capture: true, passive: true });
    detailRoot.addEventListener('touchcancel', onSwipeEnd, { capture: true, passive: true });

    onCleanup(() => {
      cancelAnimationFrame(fitRaf);
      stopQuickActionRepeat();
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      clearMissingAgentTimer();
      clearFontToastTimer();
      termContainer.removeEventListener('touchstart', onTouchStart);
      termContainer.removeEventListener('touchmove', onTouchMove);
      termContainer.removeEventListener('touchend', onTouchEnd);
      detailRoot.removeEventListener('touchstart', onSwipeStart, true);
      detailRoot.removeEventListener('touchmove', onSwipeMove, true);
      detailRoot.removeEventListener('touchend', onSwipeEnd, true);
      detailRoot.removeEventListener('touchcancel', onSwipeEnd, true);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('orientationchange', onOrientationChange);
      observer.disconnect();
      unsubscribeAgent(currentAgentId);
      cleanupScrollback();
      cleanupOutput();
      term?.dispose();
      term = undefined;
      fitAddon = undefined;
    });
  });

  return (
    <div
      ref={detailRoot}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: 'var(--bg-base)',
        position: 'relative',
        transform: swipeOffset() > 0 ? `translateX(${swipeOffset()}px)` : 'translateX(0)',
        transition: swipeOffset() > 0 ? 'none' : 'transform 0.18s ease-out',
        'will-change': 'transform',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '10px 14px',
          'border-bottom': '1px solid var(--border)',
          'flex-shrink': '0',
          position: 'relative',
          'z-index': '10',
          background: 'var(--bg-surface)',
        }}
      >
        <button
          type="button"
          class="ghost-btn tap-feedback"
          aria-label="Back to agent list"
          onClick={() => props.onBack()}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            'font-size': '14px',
            cursor: 'pointer',
            padding: '8px 6px',
            'touch-action': 'manipulation',
            display: 'flex',
            'align-items': 'center',
            gap: '4px',
            'border-radius': '10px',
          }}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 3L5 8l5 5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Back
        </button>

        <div style={{ flex: '1', 'min-width': '0', 'text-align': 'center' }}>
          <span
            style={{
              'font-size': '14px',
              'font-weight': '600',
              color: 'var(--text-primary)',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
              display: 'block',
            }}
          >
            {agentInfo()?.taskName ?? props.taskName}
          </span>
        </div>

        <div
          role="status"
          aria-live="polite"
          aria-label={`Agent status ${agentInfo()?.status ?? 'unavailable'}.`}
          style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}
        >
          <div
            aria-hidden="true"
            class={`status-indicator ${statusFlashClass()}`}
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background:
                agentInfo()?.status === 'running' ? 'var(--success)' : 'var(--text-muted)',
              'box-shadow':
                agentInfo()?.status === 'running'
                  ? '0 0 8px rgba(47, 209, 152, 0.42)'
                  : '0 0 0 rgba(47, 209, 152, 0)',
              transform: agentInfo()?.status === 'running' ? 'scale(1)' : 'scale(0.82)',
              opacity: agentInfo()?.status === 'running' ? '1' : '0.8',
            }}
          />
          <Show when={agentInfo()?.status === 'running'}>
            <button
              type="button"
              class="outline-danger-btn tap-feedback"
              aria-label="Kill running agent"
              onClick={() => setShowKillConfirm(true)}
              style={{
                background: 'none',
                border: '1px solid rgba(255, 95, 115, 0.3)',
                'border-radius': '6px',
                padding: '4px 8px',
                color: 'var(--danger)',
                'font-size': '11px',
                cursor: 'pointer',
                'touch-action': 'manipulation',
              }}
            >
              Kill
            </button>
          </Show>
        </div>
      </div>

      <Show when={status() !== 'connected'}>
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: '6px 16px',
            background: isRecoveringConnection() ? '#78350f' : '#7f1d1d',
            color: isRecoveringConnection() ? '#fde68a' : '#fca5a5',
            'font-size': '12px',
            'text-align': 'center',
            'flex-shrink': '0',
            animation: 'slideUp 0.2s ease-out',
          }}
        >
          {connectionBannerText()}
        </div>
      </Show>

      <div
        style={{
          flex: '1',
          'min-height': '0',
          padding: '4px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          ref={termContainer}
          role="region"
          aria-label={`Terminal output for ${agentInfo()?.taskName ?? props.taskName}`}
          style={{
            width: '100%',
            height: '100%',
          }}
        />

        <Show when={agentMissing()}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Agent not found"
            style={{
              position: 'absolute',
              inset: '4px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '20px',
              background: 'rgba(11, 15, 20, 0.92)',
              animation: 'fadeIn 0.3s ease-out',
            }}
          >
            <div
              style={{
                width: 'min(100%, 320px)',
                padding: '24px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                'border-radius': '16px',
                color: 'var(--text-primary)',
                'text-align': 'center',
                animation: 'slideUp 0.3s ease-out',
              }}
            >
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  margin: '0 auto 14px',
                  'border-radius': '50%',
                  background: 'rgba(255, 95, 115, 0.1)',
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                }}
              >
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <circle cx="10" cy="10" r="8" stroke="var(--danger)" stroke-width="1.5" />
                  <path
                    d="M7 7l6 6M13 7l-6 6"
                    stroke="var(--danger)"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </div>
              <p style={{ 'font-size': '15px', 'font-weight': '600', 'margin-bottom': '8px' }}>
                Agent not found
              </p>
              <p
                style={{
                  'font-size': '13px',
                  color: 'var(--text-secondary)',
                  'line-height': '1.5',
                  'margin-bottom': '18px',
                }}
              >
                This agent is no longer available.
              </p>
              <button
                type="button"
                class="accent-btn tap-feedback"
                aria-label="Back to the agent list"
                onClick={() => props.onBack()}
                style={{
                  background: 'var(--accent)',
                  border: 'none',
                  'border-radius': '10px',
                  padding: '10px 20px',
                  color: '#031018',
                  cursor: 'pointer',
                  'font-size': '13px',
                  'font-weight': '600',
                  'touch-action': 'manipulation',
                  width: '100%',
                }}
              >
                Back to agents
              </button>
            </div>
          </div>
        </Show>

        <Show when={showKillConfirm()}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Kill running agent"
            style={{
              position: 'absolute',
              inset: '4px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '20px',
              background: 'rgba(11, 15, 20, 0.92)',
              'z-index': '20',
              animation: 'fadeIn 0.2s ease-out',
            }}
          >
            <div
              style={{
                width: 'min(100%, 300px)',
                padding: '24px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                'border-radius': '16px',
                'text-align': 'center',
                animation: 'slideUp 0.2s ease-out',
              }}
            >
              <p
                style={{
                  'font-size': '15px',
                  'font-weight': '600',
                  color: 'var(--text-primary)',
                  'margin-bottom': '8px',
                }}
              >
                Kill this agent?
              </p>
              <p
                style={{
                  'font-size': '13px',
                  color: 'var(--text-secondary)',
                  'margin-bottom': '18px',
                }}
              >
                This will terminate the running process.
              </p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  class="surface-btn tap-feedback"
                  aria-label="Cancel agent kill"
                  onClick={() => setShowKillConfirm(false)}
                  style={{
                    flex: '1',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    'border-radius': '10px',
                    padding: '10px',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    'font-size': '13px',
                    'touch-action': 'manipulation',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="danger-btn tap-feedback"
                  aria-label="Confirm kill agent"
                  onClick={handleKill}
                  style={{
                    flex: '1',
                    background: 'var(--danger)',
                    border: 'none',
                    'border-radius': '10px',
                    padding: '10px',
                    color: '#fff',
                    cursor: 'pointer',
                    'font-size': '13px',
                    'font-weight': '600',
                    'touch-action': 'manipulation',
                  }}
                >
                  Kill
                </button>
              </div>
            </div>
          </div>
        </Show>
      </div>

      <Show when={!atBottom() && !agentMissing()}>
        <button
          type="button"
          class="icon-btn tap-feedback"
          aria-label="Scroll terminal to the bottom"
          onClick={scrollToBottom}
          style={{
            position: 'absolute',
            bottom: '150px',
            right: '16px',
            width: '44px',
            height: '44px',
            'border-radius': '50%',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            'font-size': '16px',
            cursor: 'pointer',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'z-index': '10',
            'touch-action': 'manipulation',
            'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 3v10M8 13l4-4M8 13l-4-4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </Show>

      <Show when={!agentMissing()}>
        <div
          style={{
            'border-top': '1px solid var(--border)',
            padding: '8px 10px max(8px, env(safe-area-inset-bottom)) 10px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            'flex-shrink': '0',
            background: 'var(--bg-surface)',
            position: 'relative',
            'z-index': '10',
          }}
        >
          <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <input
              ref={inputRef}
              class="command-input"
              type="text"
              enterkeyhint="send"
              name="xq9k_cmd"
              id="xq9k_cmd"
              aria-label="Type a command for this agent"
              autocomplete="xq9k_cmd"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
              inputmode="text"
              value={inputText()}
              onInput={(event) => {
                const value = event.currentTarget.value;
                const lastChar = value.charCodeAt(value.length - 1);
                if (lastChar === 10 || lastChar === 13) {
                  const cleanValue = value.slice(0, -1);
                  setInputText(cleanValue);
                  event.currentTarget.value = cleanValue;
                  handleSend();
                  return;
                }
                setInputText(value);
              }}
              onFocus={() => {
                setTimeout(() => term?.scrollToBottom(), 300);
              }}
              placeholder="Type command..."
              style={{
                flex: '1',
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                'border-radius': '12px',
                padding: '10px 14px',
                color: 'var(--text-primary)',
                'font-size': '14px',
                'font-family': "'JetBrains Mono', 'Courier New', monospace",
                outline: 'none',
              }}
            />
            <button
              type="button"
              class="send-btn tap-feedback"
              aria-label="Send command"
              disabled={!inputText().trim()}
              onClick={() => handleSend()}
              style={{
                background: inputText().trim() ? 'var(--accent)' : 'var(--bg-elevated)',
                border: 'none',
                'border-radius': '50%',
                width: '40px',
                height: '40px',
                color: inputText().trim() ? '#031018' : 'var(--text-muted)',
                cursor: inputText().trim() ? 'pointer' : 'default',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                padding: '0',
                'flex-shrink': '0',
                'touch-action': 'manipulation',
              }}
              title="Send command"
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 14 14" fill="none">
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

          <div
            style={{
              display: 'flex',
              gap: '6px',
              overflow: 'auto',
              '-webkit-overflow-scrolling': 'touch',
            }}
          >
            <For each={quickActionGroups}>
              {(group) => (
                <div
                  role="group"
                  aria-label={`${group.label} quick actions`}
                  style={{
                    display: 'flex',
                    gap: '1px',
                    'border-radius': '8px',
                    overflow: 'hidden',
                    'flex-shrink': '0',
                    border: '1px solid var(--border)',
                  }}
                >
                  <For each={group.actions}>
                    {(action) => (
                      <button
                        type="button"
                        class="quick-action-btn tap-feedback"
                        aria-label={action.ariaLabel}
                        title={action.ariaLabel}
                        onClick={(event) => handleQuickActionClick(event, action)}
                        onPointerDown={(event) => handleQuickActionPointerDown(event, action)}
                        onPointerUp={(event) => handleQuickActionPointerUp(event, action)}
                        onPointerCancel={(event) => handleQuickActionPointerCancel(event)}
                        onPointerLeave={(event) => {
                          if (!action.repeatable) return;
                          handleQuickActionPointerCancel(event);
                        }}
                        style={{
                          background: 'var(--bg-elevated)',
                          border: 'none',
                          padding: '9px 12px',
                          color: 'var(--text-secondary)',
                          'font-size': '12px',
                          'font-family': "'JetBrains Mono', 'Courier New', monospace",
                          cursor: 'pointer',
                          'touch-action': 'manipulation',
                          'white-space': 'nowrap',
                          'user-select': 'none',
                          '-webkit-user-select': 'none',
                        }}
                      >
                        {action.label}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>

            <div
              role="group"
              aria-label="Terminal font size controls"
              style={{
                display: 'flex',
                gap: '1px',
                'border-radius': '8px',
                overflow: 'hidden',
                'flex-shrink': '0',
                'margin-left': 'auto',
                border: '1px solid var(--border)',
                position: 'relative',
              }}
            >
              <Show when={fontToast()}>
                <div
                  class="font-toast"
                  role="status"
                  aria-live="polite"
                  style={{
                    position: 'absolute',
                    right: '0',
                    bottom: 'calc(100% + 8px)',
                    padding: '6px 10px',
                    background: 'rgba(18, 24, 31, 0.96)',
                    border: '1px solid rgba(46, 200, 255, 0.16)',
                    'border-radius': '999px',
                    color: 'var(--text-primary)',
                    'font-size': '11px',
                    'font-family': "'JetBrains Mono', 'Courier New', monospace",
                    'white-space': 'nowrap',
                    'pointer-events': 'none',
                    'box-shadow': '0 12px 24px rgba(0, 0, 0, 0.24)',
                  }}
                >
                  {fontToast()}
                </div>
              </Show>

              <button
                type="button"
                class="surface-btn tap-feedback"
                aria-label="Decrease terminal font size"
                onClick={() => {
                  const nextSize = Math.max(MIN_FONT, termFontSize() - 1);
                  applyFontSize(nextSize);
                }}
                disabled={termFontSize() <= MIN_FONT}
                style={{
                  background: 'var(--bg-elevated)',
                  border: 'none',
                  'border-radius': '0',
                  padding: '9px 12px',
                  'font-size': '12px',
                  'font-family': "'JetBrains Mono', 'Courier New', monospace",
                  'font-weight': '700',
                  color: termFontSize() <= MIN_FONT ? '#344050' : 'var(--text-secondary)',
                  cursor: termFontSize() <= MIN_FONT ? 'default' : 'pointer',
                  'touch-action': 'manipulation',
                }}
                title="Decrease font size"
              >
                A-
              </button>
              <button
                type="button"
                class="surface-btn tap-feedback"
                aria-label="Increase terminal font size"
                onClick={() => {
                  const nextSize = Math.min(MAX_FONT, termFontSize() + 1);
                  applyFontSize(nextSize);
                }}
                disabled={termFontSize() >= MAX_FONT}
                style={{
                  background: 'var(--bg-elevated)',
                  border: 'none',
                  'border-radius': '0',
                  padding: '9px 12px',
                  'font-size': '12px',
                  'font-family': "'JetBrains Mono', 'Courier New', monospace",
                  'font-weight': '700',
                  color: termFontSize() >= MAX_FONT ? '#344050' : 'var(--text-secondary)',
                  cursor: termFontSize() >= MAX_FONT ? 'default' : 'pointer',
                  'touch-action': 'manipulation',
                }}
                title="Increase font size"
              >
                A+
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
