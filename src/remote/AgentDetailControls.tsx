import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import { typography } from '../lib/typography';

const KEYS: Record<number, string> = {};
[3, 4, 9, 12, 13, 26, 27].forEach((code) => {
  KEYS[code] = String.fromCharCode(code);
});

const MIN_FONT = 6;
const MAX_FONT = 24;
const ACTION_BUTTON_BACKGROUND = 'rgba(17, 24, 31, 0.92)';

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
  disabled: boolean;
  disabledReason: string | null;
  fontSize: number;
  onCommandSent: () => void;
  onFocusInput: () => void;
  onHaptic: () => void;
  onQuickAction: (data: string) => void;
  onSendText: (text: string) => void;
  onSetFontSize: (nextSize: number) => void;
}

function key(code: number): string {
  return KEYS[code] ?? '';
}

function getActionButtonStyle(disabled: boolean): JSX.CSSProperties {
  return {
    background: ACTION_BUTTON_BACKGROUND,
    border: 'none',
    padding: '0.78rem 0.95rem',
    color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
    'touch-action': 'manipulation',
    'white-space': 'nowrap',
    'user-select': 'none',
    '-webkit-user-select': 'none',
    ...typography.metaStrong,
  };
}

function getFontControlStyle(disabled: boolean): JSX.CSSProperties {
  return {
    ...getActionButtonStyle(false),
    color: disabled ? '#344050' : 'var(--text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
  };
}

const quickActionGroups: QuickActionGroup[] = [
  {
    label: 'Keys',
    actions: [
      { label: 'Enter', ariaLabel: 'Send Enter key', data: () => key(13) },
      { label: 'Tab', ariaLabel: 'Send Tab key', data: () => key(9) },
      { label: '⇧Tab', ariaLabel: 'Send Shift Tab key', data: () => key(27) + '[Z' },
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

  function hasPendingInput(): boolean {
    return inputText().trim().length > 0;
  }

  function canSendInput(): boolean {
    return !props.disabled && hasPendingInput();
  }

  function canUseQuickActions(): boolean {
    return !props.agentMissing && !props.disabled;
  }

  function blurActiveInput(): void {
    inputRef?.blur();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function handleSend(): void {
    if (props.agentMissing || !canSendInput()) {
      return;
    }

    const text = inputText();
    props.onHaptic();
    props.onSendText(text + key(13));
    setInputText('');
    blurActiveInput();
    props.onCommandSent();
  }

  function handleQuickAction(data: string): void {
    if (!canUseQuickActions()) {
      return;
    }

    props.onHaptic();
    props.onQuickAction(data);
  }

  function applyFontSize(nextSize: number): void {
    props.onSetFontSize(nextSize);
    showFontSizeToast(nextSize);
  }

  function decreaseFontSize(): void {
    applyFontSize(Math.max(MIN_FONT, props.fontSize - 1));
  }

  function increaseFontSize(): void {
    applyFontSize(Math.min(MAX_FONT, props.fontSize + 1));
  }

  function handleQuickActionPointerDown(event: PointerEvent, action: QuickAction): void {
    if (!action.repeatable || !canUseQuickActions()) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const button = event.currentTarget as HTMLButtonElement;
    button.setPointerCapture?.(event.pointerId);
    stopQuickActionRepeat();
    repeatDelayTimer = setTimeout(() => {
      if (!canUseQuickActions()) {
        return;
      }

      repeatTriggered = true;
      props.onHaptic();
      props.onQuickAction(action.data());
      repeatIntervalTimer = setInterval(() => {
        if (!canUseQuickActions()) {
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
      class="remote-control-dock"
      style={{
        padding:
          'var(--space-xs) var(--space-sm) max(calc(var(--space-xs) + env(safe-area-inset-bottom)), var(--space-xs))',
        display: 'grid',
        gap: 'var(--space-xs)',
        'flex-shrink': '0',
        position: 'relative',
        'z-index': '10',
      }}
    >
      <Show when={props.disabledReason}>
        <div
          role="status"
          aria-live="polite"
          class="remote-chip"
          style={{
            color: 'var(--warning)',
            background: 'rgba(255, 197, 105, 0.08)',
            border: '1px solid rgba(255, 197, 105, 0.18)',
            'justify-content': 'center',
            ...typography.metaStrong,
          }}
        >
          {props.disabledReason}
        </div>
      </Show>

      <div
        class="remote-panel remote-panel--soft"
        style={{
          padding: 'var(--space-xs)',
          'border-radius': '1.1rem',
          display: 'flex',
          gap: 'var(--space-xs)',
          'align-items': 'center',
        }}
      >
        <div
          style={{
            flex: '1',
            display: 'flex',
            gap: 'var(--space-xs)',
            'align-items': 'center',
            'min-width': '0',
          }}
        >
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
            disabled={props.disabled}
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
            onKeyDown={(event) => {
              if (event.key !== 'Enter') {
                return;
              }

              event.preventDefault();
              handleSend();
            }}
            placeholder={props.disabled ? 'Read-only until you take over…' : 'Type command...'}
            style={{
              flex: '1',
              background: 'rgba(6, 11, 15, 0.92)',
              border: '1px solid rgba(61, 92, 119, 0.28)',
              'border-radius': '1rem',
              padding: '0.82rem 0.92rem',
              color: props.disabled ? 'var(--text-muted)' : 'var(--text-primary)',
              'font-family': 'var(--font-mono)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            class="send-btn tap-feedback"
            aria-label="Send command"
            disabled={!canSendInput()}
            onClick={() => handleSend()}
            style={{
              background: canSendInput()
                ? 'linear-gradient(180deg, var(--accent) 0%, #28b8ea 100%)'
                : 'var(--bg-elevated)',
              border: 'none',
              'border-radius': '1rem',
              width: '3rem',
              height: '3rem',
              color: canSendInput() ? '#031018' : 'var(--text-muted)',
              cursor: canSendInput() ? 'pointer' : 'default',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '0',
              'flex-shrink': '0',
              'touch-action': 'manipulation',
              'box-shadow': canSendInput() ? '0 12px 24px rgba(46, 200, 255, 0.22)' : 'none',
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
      </div>

      <div class="remote-chip-scroll">
        <div style={{ display: 'flex', gap: 'var(--space-sm)', 'min-width': 'max-content' }}>
          <For each={quickActionGroups}>
            {(group) => (
              <div
                role="group"
                aria-label={`${group.label} quick actions`}
                class="remote-action-row"
              >
                <For each={group.actions}>
                  {(action) => (
                    <button
                      type="button"
                      class="quick-action-btn tap-feedback"
                      aria-label={action.ariaLabel}
                      title={action.ariaLabel}
                      disabled={props.disabled}
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
                        ...getActionButtonStyle(props.disabled),
                        'font-family': 'var(--font-mono)',
                      }}
                    >
                      {action.label}
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>

          <div style={{ position: 'relative' }}>
            <div role="group" aria-label="Terminal font size controls" class="remote-action-row">
              <Show when={fontToast()}>
                <div
                  class="font-toast"
                  role="status"
                  aria-live="polite"
                  style={{
                    position: 'absolute',
                    right: '0',
                    bottom: 'calc(100% + 0.45rem)',
                    padding: '0.45rem 0.7rem',
                    background: 'rgba(18, 24, 31, 0.96)',
                    border: '1px solid rgba(46, 200, 255, 0.16)',
                    'border-radius': '999px',
                    color: 'var(--text-primary)',
                    'white-space': 'nowrap',
                    'pointer-events': 'none',
                    'box-shadow': '0 12px 24px rgba(0, 0, 0, 0.24)',
                    ...typography.metaStrong,
                  }}
                >
                  {fontToast()}
                </div>
              </Show>

              <button
                type="button"
                class="surface-btn tap-feedback"
                aria-label="Decrease terminal font size"
                onClick={() => decreaseFontSize()}
                disabled={props.fontSize <= MIN_FONT}
                style={getFontControlStyle(props.fontSize <= MIN_FONT)}
                title="Decrease font size"
              >
                A-
              </button>
              <div
                style={{
                  'min-width': '3.2rem',
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  background: 'rgba(10, 14, 20, 0.88)',
                  color: 'var(--text-primary)',
                  'font-family': 'var(--font-mono)',
                  ...typography.metaStrong,
                }}
              >
                {props.fontSize}px
              </div>
              <button
                type="button"
                class="surface-btn tap-feedback"
                aria-label="Increase terminal font size"
                onClick={() => increaseFontSize()}
                disabled={props.fontSize >= MAX_FONT}
                style={getFontControlStyle(props.fontSize >= MAX_FONT)}
                title="Increase font size"
              >
                A+
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
