import { onMount, onCleanup, createSignal, Show, For } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  subscribeAgent,
  unsubscribeAgent,
  onOutput,
  onScrollback,
  sendInput,
  send,
  agents,
  status,
} from './ws';

// Base64 decode (same approach as desktop)
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

// Build control characters at runtime via lookup — avoids Vite stripping \r during build
const KEYS: Record<number, string> = {};
[3, 4, 9, 12, 13, 26, 27].forEach((c) => {
  KEYS[c] = String.fromCharCode(c);
});
function key(c: number): string {
  return KEYS[c];
}

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
}

export function AgentDetail(props: AgentDetailProps) {
  let termContainer: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let currentAgentId = '';
  const [inputText, setInputText] = createSignal('');
  const [atBottom, setAtBottom] = createSignal(true);
  const [termFontSize, setTermFontSize] = createSignal(10);
  const [agentMissing, setAgentMissing] = createSignal(false);

  const MIN_FONT = 6;
  const MAX_FONT = 24;

  const agentInfo = () => agents().find((a) => a.agentId === props.agentId);
  const isRecoveringConnection = () => status() === 'connecting' || status() === 'reconnecting';
  const connectionBannerText = () => {
    if (status() === 'connecting') return 'Connecting...';
    if (status() === 'reconnecting') return 'Reconnecting...';
    return 'Disconnected — check your network';
  };

  let fitRaf = 0;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let missingAgentTimer: ReturnType<typeof setTimeout> | null = null;
  let restoringScrollback = false;
  let hasTerminalData = false;
  let bufferedOutput: Uint8Array[] = [];
  let agentMissingValue = false;

  function updateAgentMissing(value: boolean) {
    agentMissingValue = value;
    setAgentMissing(value);
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

  onMount(() => {
    if (!termContainer) return;
    currentAgentId = props.agentId;

    if (inputRef) {
      const enterHandler = (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' || ke.keyCode === 13) {
          e.preventDefault();
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

    if (window.visualViewport) {
      const onViewportResize = () => scheduleFitAndResize();
      window.visualViewport.addEventListener('resize', onViewportResize);
      onCleanup(() => window.visualViewport?.removeEventListener('resize', onViewportResize));
    }

    // Manual touch scrolling for mobile — xterm.js doesn't handle this well
    let touchStartY = 0;
    let touchActive = false;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchActive = true;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touchActive || !term || e.touches.length !== 1) return;
      const dy = touchStartY - e.touches[0].clientY;
      const lineHeight = term.options.fontSize ?? 13;
      const lines = Math.trunc(dy / lineHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchStartY = e.touches[0].clientY;
      }
      e.preventDefault();
    };
    const onTouchEnd = () => {
      touchActive = false;
    };
    termContainer.addEventListener('touchstart', onTouchStart, { passive: true });
    termContainer.addEventListener('touchmove', onTouchMove, { passive: false });
    termContainer.addEventListener('touchend', onTouchEnd, { passive: true });

    onCleanup(() => {
      cancelAnimationFrame(fitRaf);
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      clearMissingAgentTimer();
      termContainer.removeEventListener('touchstart', onTouchStart);
      termContainer.removeEventListener('touchmove', onTouchMove);
      termContainer.removeEventListener('touchend', onTouchEnd);
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

  function handleSend() {
    if (agentMissing()) return;
    const text = inputText();
    if (!text) return;
    sendInput(currentAgentId, text + key(13));
    setInputText('');
    inputRef?.focus();
  }

  function handleQuickAction(data: string) {
    if (agentMissing()) return;
    sendInput(currentAgentId, data);
  }

  function scrollToBottom() {
    term?.scrollToBottom();
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: '#0b0f14',
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: '10px 14px',
          'border-bottom': '1px solid #223040',
          'flex-shrink': '0',
          position: 'relative',
          'z-index': '10',
          background: '#12181f',
        }}
      >
        <button
          onClick={() => props.onBack()}
          style={{
            background: 'none',
            border: 'none',
            color: '#2ec8ff',
            'font-size': '16px',
            cursor: 'pointer',
            padding: '8px 10px',
            'touch-action': 'manipulation',
          }}
        >
          &#8592; Back
        </button>
        <span
          style={{
            'font-size': '14px',
            'font-weight': '500',
            color: '#d7e4f0',
            flex: '1',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}
        >
          {agentInfo()?.taskName ?? props.taskName}
        </span>
        <div
          style={{
            width: '8px',
            height: '8px',
            'border-radius': '50%',
            background: agentInfo()?.status === 'running' ? '#2fd198' : '#678197',
          }}
        />
      </div>

      <Show when={status() !== 'connected'}>
        <div
          style={{
            padding: '6px 16px',
            background: isRecoveringConnection() ? '#78350f' : '#7f1d1d',
            color: isRecoveringConnection() ? '#fde68a' : '#fca5a5',
            'font-size': '12px',
            'text-align': 'center',
            'flex-shrink': '0',
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
          style={{
            width: '100%',
            height: '100%',
          }}
        />
        <Show when={agentMissing()}>
          <div
            style={{
              position: 'absolute',
              inset: '4px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '20px',
              background: 'rgba(11, 15, 20, 0.92)',
            }}
          >
            <div
              style={{
                width: 'min(100%, 320px)',
                padding: '18px',
                background: '#12181f',
                border: '1px solid #223040',
                'border-radius': '14px',
                color: '#d7e4f0',
                'text-align': 'center',
              }}
            >
              <p style={{ 'font-size': '15px', 'font-weight': '600', 'margin-bottom': '8px' }}>
                Agent not found or has exited
              </p>
              <p
                style={{
                  'font-size': '13px',
                  color: '#9bb0c3',
                  'line-height': '1.5',
                  'margin-bottom': '14px',
                }}
              >
                This agent is no longer available from the remote server.
              </p>
              <button
                onClick={() => props.onBack()}
                style={{
                  background: '#2ec8ff',
                  border: 'none',
                  'border-radius': '10px',
                  padding: '10px 14px',
                  color: '#031018',
                  cursor: 'pointer',
                  'font-size': '13px',
                  'font-weight': '600',
                  'touch-action': 'manipulation',
                }}
              >
                Back to agents
              </button>
            </div>
          </div>
        </Show>
      </div>

      <Show when={!atBottom() && !agentMissing()}>
        <button
          onClick={scrollToBottom}
          style={{
            position: 'absolute',
            bottom: '140px',
            right: '16px',
            width: '40px',
            height: '40px',
            'border-radius': '50%',
            background: '#12181f',
            border: '1px solid #223040',
            color: '#d7e4f0',
            'font-size': '16px',
            cursor: 'pointer',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'z-index': '10',
            'touch-action': 'manipulation',
          }}
        >
          &#8595;
        </button>
      </Show>

      <Show when={!agentMissing()}>
        <div
          style={{
            'border-top': '1px solid #223040',
            padding: '8px 10px max(8px, env(safe-area-inset-bottom)) 10px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
            'flex-shrink': '0',
            background: '#12181f',
            position: 'relative',
            'z-index': '10',
          }}
        >
          <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <input
              ref={inputRef}
              type="text"
              enterkeyhint="send"
              name="xq9k_cmd"
              id="xq9k_cmd"
              autocomplete="xq9k_cmd"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
              inputmode="text"
              value={inputText()}
              onInput={(e) => {
                const val = e.currentTarget.value;
                const last = val.charCodeAt(val.length - 1);
                if (last === 10 || last === 13) {
                  const clean = val.slice(0, -1);
                  setInputText(clean);
                  e.currentTarget.value = clean;
                  handleSend();
                  return;
                }
                setInputText(val);
              }}
              placeholder="Type command..."
              style={{
                flex: '1',
                background: '#10161d',
                border: '1px solid #223040',
                'border-radius': '12px',
                padding: '10px 14px',
                color: '#d7e4f0',
                'font-size': '14px',
                'font-family': "'JetBrains Mono', 'Courier New', monospace",
                outline: 'none',
                transition: 'border-color 0.16s ease',
              }}
            />
            <button
              type="button"
              disabled={!inputText().trim()}
              onClick={() => handleSend()}
              style={{
                background: inputText().trim() ? '#2ec8ff' : '#1a2430',
                border: 'none',
                'border-radius': '50%',
                width: '40px',
                height: '40px',
                color: inputText().trim() ? '#031018' : '#678197',
                cursor: inputText().trim() ? 'pointer' : 'default',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                padding: '0',
                'flex-shrink': '0',
                'touch-action': 'manipulation',
                transition: 'background 0.15s, color 0.15s',
              }}
              title="Send"
            >
              <svg width="18" height="18" viewBox="0 0 14 14" fill="none">
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

          <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
            <For
              each={[
                { label: 'Enter', data: () => key(13) },
                { label: 'Tab', data: () => key(9) },
                { label: 'Esc', data: () => key(27) },
                { label: '\u2191', data: () => key(27) + '[A' },
                { label: '\u2193', data: () => key(27) + '[B' },
                { label: 'Ctrl+C', data: () => key(3) },
                { label: 'Ctrl+D', data: () => key(4) },
                { label: 'Ctrl+Z', data: () => key(26) },
                { label: 'Ctrl+L', data: () => key(12) },
              ]}
            >
              {(action) => (
                <button
                  onClick={() => handleQuickAction(action.data())}
                  style={{
                    background: '#1a2430',
                    border: '1px solid #223040',
                    'border-radius': '8px',
                    padding: '10px 16px',
                    color: '#9bb0c3',
                    'font-size': '13px',
                    'font-family': "'JetBrains Mono', 'Courier New', monospace",
                    cursor: 'pointer',
                    'touch-action': 'manipulation',
                    transition: 'background 0.16s ease',
                  }}
                >
                  {action.label}
                </button>
              )}
            </For>
            <div style={{ 'margin-left': 'auto', display: 'flex', gap: '6px' }}>
              <button
                onClick={() => {
                  const next = Math.max(MIN_FONT, termFontSize() - 1);
                  setTermFontSize(next);
                  if (term) {
                    term.options.fontSize = next;
                    fitAndResize();
                  }
                }}
                disabled={termFontSize() <= MIN_FONT}
                style={{
                  background: '#1a2430',
                  border: '1px solid #223040',
                  'border-radius': '8px',
                  padding: '10px 14px',
                  color: termFontSize() <= MIN_FONT ? '#344050' : '#9bb0c3',
                  'font-size': '13px',
                  'font-weight': '700',
                  'font-family': "'JetBrains Mono', 'Courier New', monospace",
                  cursor: termFontSize() <= MIN_FONT ? 'default' : 'pointer',
                  'touch-action': 'manipulation',
                  transition: 'background 0.16s ease',
                }}
                title="Decrease font size"
              >
                A-
              </button>
              <button
                onClick={() => {
                  const next = Math.min(MAX_FONT, termFontSize() + 1);
                  setTermFontSize(next);
                  if (term) {
                    term.options.fontSize = next;
                    fitAndResize();
                  }
                }}
                disabled={termFontSize() >= MAX_FONT}
                style={{
                  background: '#1a2430',
                  border: '1px solid #223040',
                  'border-radius': '8px',
                  padding: '10px 14px',
                  color: termFontSize() >= MAX_FONT ? '#344050' : '#9bb0c3',
                  'font-size': '13px',
                  'font-weight': '700',
                  'font-family': "'JetBrains Mono', 'Courier New', monospace",
                  cursor: termFontSize() >= MAX_FONT ? 'default' : 'pointer',
                  'touch-action': 'manipulation',
                  transition: 'background 0.16s ease',
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
