import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';

const KEYS: Record<number, string> = {};
[3, 4, 9, 12, 13, 26, 27].forEach((code) => {
  KEYS[code] = String.fromCharCode(code);
});

const MIN_FONT = 6;
const MAX_FONT = 24;

interface QuickAction {
  ariaLabel: string;
  data: () => string;
  label: string;
  repeatable?: boolean;
}

interface QuickActionGroup {
  actions: QuickAction[];
  label: string;
}

interface AgentDetailControlsProps {
  agentMissing: boolean;
  fontSize: number;
  onFocusInput: () => void;
  onHaptic: () => void;
  onQuickAction: (data: string) => void;
  onSendText: (text: string) => void;
  onSetFontSize: (nextSize: number) => void;
}

function key(code: number): string {
  return KEYS[code];
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

export function AgentDetailControls(props: AgentDetailControlsProps): JSX.Element {
  let inputRef: HTMLInputElement | undefined;

  const [fontToast, setFontToast] = createSignal<string | null>(null);
  const [inputText, setInputText] = createSignal('');

  let fontToastTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatIntervalTimer: ReturnType<typeof setInterval> | null = null;
  let repeatTriggered = false;

  function clearFontToastTimer(): void {
    if (!fontToastTimer) {
      return;
    }
    clearTimeout(fontToastTimer);
    fontToastTimer = null;
  }

  function showFontSizeToast(nextSize: number): void {
    setFontToast(`Text ${nextSize}px`);
    clearFontToastTimer();
    fontToastTimer = setTimeout(() => {
      setFontToast(null);
      fontToastTimer = null;
    }, 900);
  }

  function stopQuickActionRepeat(): void {
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

  function handleSend(): void {
    if (props.agentMissing) {
      return;
    }

    const text = inputText();
    if (!text) {
      return;
    }

    props.onHaptic();
    props.onSendText(text + key(13));
    setInputText('');
    inputRef?.focus();
  }

  function handleQuickAction(data: string): void {
    if (props.agentMissing) {
      return;
    }

    props.onHaptic();
    props.onQuickAction(data);
  }

  function applyFontSize(nextSize: number): void {
    props.onSetFontSize(nextSize);
    showFontSizeToast(nextSize);
  }

  function handleQuickActionPointerDown(event: PointerEvent, action: QuickAction): void {
    if (!action.repeatable || props.agentMissing) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const button = event.currentTarget as HTMLButtonElement;
    button.setPointerCapture?.(event.pointerId);
    stopQuickActionRepeat();
    repeatDelayTimer = setTimeout(() => {
      if (props.agentMissing) {
        return;
      }

      repeatTriggered = true;
      props.onHaptic();
      props.onQuickAction(action.data());
      repeatIntervalTimer = setInterval(() => {
        if (props.agentMissing) {
          stopQuickActionRepeat();
          return;
        }

        props.onQuickAction(action.data());
      }, 90);
    }, 320);
  }

  function handleQuickActionPointerUp(event: PointerEvent, action: QuickAction): void {
    if (!action.repeatable) {
      return;
    }

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

  function handleQuickActionPointerCancel(event: PointerEvent): void {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.hasPointerCapture?.(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }
    stopQuickActionRepeat();
  }

  function handleQuickActionClick(event: MouseEvent, action: QuickAction): void {
    if (!action.repeatable) {
      handleQuickAction(action.data());
      return;
    }

    if (event.detail === 0) {
      handleQuickAction(action.data());
    }
  }

  onCleanup(() => {
    stopQuickActionRepeat();
    clearFontToastTimer();
  });

  return (
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
          onFocus={() => props.onFocusInput()}
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
                      if (!action.repeatable) {
                        return;
                      }
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
              const nextSize = Math.max(MIN_FONT, props.fontSize - 1);
              applyFontSize(nextSize);
            }}
            disabled={props.fontSize <= MIN_FONT}
            style={{
              background: 'var(--bg-elevated)',
              border: 'none',
              'border-radius': '0',
              padding: '9px 12px',
              'font-size': '12px',
              'font-family': "'JetBrains Mono', 'Courier New', monospace",
              'font-weight': '700',
              color: props.fontSize <= MIN_FONT ? '#344050' : 'var(--text-secondary)',
              cursor: props.fontSize <= MIN_FONT ? 'default' : 'pointer',
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
              const nextSize = Math.min(MAX_FONT, props.fontSize + 1);
              applyFontSize(nextSize);
            }}
            disabled={props.fontSize >= MAX_FONT}
            style={{
              background: 'var(--bg-elevated)',
              border: 'none',
              'border-radius': '0',
              padding: '9px 12px',
              'font-size': '12px',
              'font-family': "'JetBrains Mono', 'Courier New', monospace",
              'font-weight': '700',
              color: props.fontSize >= MAX_FONT ? '#344050' : 'var(--text-secondary)',
              cursor: props.fontSize >= MAX_FONT ? 'default' : 'pointer',
              'touch-action': 'manipulation',
            }}
            title="Increase font size"
          >
            A+
          </button>
        </div>
      </div>
    </div>
  );
}
