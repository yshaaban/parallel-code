import { Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
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
import { b64decode } from './base64';
import { AgentDetailControls } from './AgentDetailControls';
import { AgentDetailHeader } from './AgentDetailHeader';
import {
  AgentKillConfirmDialog,
  AgentMissingDialog,
  ScrollToBottomButton,
} from './AgentDetailOverlays';
import { attachAgentDetailTouchGestures } from './touch-gestures';

function haptic() {
  if ('vibrate' in navigator) navigator.vibrate(8);
}

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
}

export function AgentDetail(props: AgentDetailProps) {
  let detailRoot: HTMLDivElement | undefined;
  let termContainer: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let currentAgentId = '';

  const [atBottom, setAtBottom] = createSignal(true);
  const [termFontSize, setTermFontSize] = createSignal(10);
  const [agentMissing, setAgentMissing] = createSignal(false);
  const [showKillConfirm, setShowKillConfirm] = createSignal(false);
  const [statusFlashClass, setStatusFlashClass] = createSignal('');
  const [swipeOffset, setSwipeOffset] = createSignal(0);

  const agentInfo = () => agents().find((agent) => agent.agentId === props.agentId);

  let fitRaf = 0;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let missingAgentTimer: ReturnType<typeof setTimeout> | null = null;
  let restoringScrollback = false;
  let hasTerminalData = false;
  let agentMissingValue = false;
  let bufferedOutput: Uint8Array[] = [];
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

  function applyFontSize(nextSize: number) {
    setTermFontSize(nextSize);
    if (term) {
      term.options.fontSize = nextSize;
      fitAndResize();
    }
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

  function handleQuickAction(data: string): void {
    if (agentMissing()) return;
    haptic();
    sendInput(currentAgentId, data);
  }

  function handleKill() {
    haptic();
    sendKill(currentAgentId);
    setShowKillConfirm(false);
  }

  function scrollToBottom() {
    term?.scrollToBottom();
  }

  onMount(() => {
    if (!detailRoot || !termContainer) return;
    currentAgentId = props.agentId;

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
    const cleanupTouchGestures = attachAgentDetailTouchGestures({
      detailRoot,
      termContainer,
      getTerm: () => term,
      showKillConfirm,
      agentMissing,
      swipeOffset,
      setSwipeOffset,
      onBack: props.onBack,
      onHaptic: haptic,
    });

    onCleanup(() => {
      cancelAnimationFrame(fitRaf);
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      clearMissingAgentTimer();
      cleanupTouchGestures();
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
      <AgentDetailHeader
        agentStatus={agentInfo()?.status}
        connectionStatus={status()}
        onBack={props.onBack}
        onKill={() => setShowKillConfirm(true)}
        statusFlashClass={statusFlashClass()}
        taskName={agentInfo()?.taskName ?? props.taskName}
      />

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

        <AgentMissingDialog onBack={props.onBack} open={agentMissing()} />
        <AgentKillConfirmDialog
          onCancel={() => setShowKillConfirm(false)}
          onConfirm={handleKill}
          open={showKillConfirm()}
        />
      </div>

      <ScrollToBottomButton
        onScrollToBottom={scrollToBottom}
        open={!atBottom() && !agentMissing()}
      />

      <Show when={!agentMissing()}>
        <AgentDetailControls
          agentMissing={agentMissing()}
          fontSize={termFontSize()}
          onFocusInput={() => {
            setTimeout(() => term?.scrollToBottom(), 300);
          }}
          onHaptic={haptic}
          onQuickAction={handleQuickAction}
          onSendText={(text) => sendInput(currentAgentId, text)}
          onSetFontSize={applyFontSize}
        />
      </Show>
    </div>
  );
}
