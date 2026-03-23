import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
  untrack,
} from 'solid-js';
import { b64decode } from './base64';
import { AgentDetailControls } from './AgentDetailControls';
import { AgentDetailHeader } from './AgentDetailHeader';
import {
  AgentKillConfirmDialog,
  AgentMissingDialog,
  ScrollToBottomButton,
} from './AgentDetailOverlays';
import { formatRemoteTaskContext } from './agent-presentation';
import {
  getRemoteTaskControllerOwnerStatus,
  getRemoteTaskOwnerStatus,
} from './remote-collaboration';
import {
  releaseRemoteTaskCommand,
  requestRemoteTaskTakeover,
  sendRemoteAgentInput,
  sendRemoteAgentResize,
} from './remote-task-command';
import { attachAgentDetailTouchGestures } from './touch-gestures';
import {
  agents,
  getAgentLastActivityAt,
  onOutput,
  onScrollback,
  sendKill,
  status,
  subscribeAgent,
  unsubscribeAgent,
} from './ws';

function haptic(): void {
  if ('vibrate' in navigator) {
    navigator.vibrate(8);
  }
}

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
}

export function AgentDetail(props: AgentDetailProps): JSX.Element {
  let detailRoot: HTMLDivElement | undefined;
  let termContainer: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let currentAgentId = '';
  let currentTaskId: string | null = null;

  const [atBottom, setAtBottom] = createSignal(true);
  const [termFontSize, setTermFontSize] = createSignal(10);
  const [agentMissing, setAgentMissing] = createSignal(false);
  const [showKillConfirm, setShowKillConfirm] = createSignal(false);
  const [statusFlashClass, setStatusFlashClass] = createSignal('');
  const [swipeOffset, setSwipeOffset] = createSignal(0);
  const [takeoverBusy, setTakeoverBusy] = createSignal(false);
  const [forceTakeover, setForceTakeover] = createSignal(false);
  const [statusNotice, setStatusNotice] = createSignal<string | null>(null);

  const agentInfo = () => agents().find((agent) => agent.agentId === props.agentId);
  const taskId = createMemo(() => agentInfo()?.taskId ?? null);
  const ownerStatus = createMemo(() => {
    const activeTaskId = taskId();
    if (!activeTaskId) {
      return null;
    }

    return getRemoteTaskOwnerStatus(activeTaskId);
  });
  const controlOwnerStatus = createMemo(() => {
    const activeTaskId = taskId();
    if (!activeTaskId) {
      return null;
    }

    return getRemoteTaskControllerOwnerStatus(activeTaskId);
  });
  const readOnly = createMemo(() => Boolean(controlOwnerStatus() && !controlOwnerStatus()?.isSelf));
  const takeOverLabel = createMemo(() => (forceTakeover() ? 'Force Take Over' : 'Take Over'));

  function getActiveTaskId(): string | null {
    return taskId() ?? currentTaskId;
  }

  function getReadOnlyReason(): string | null {
    if (!readOnly()) {
      return null;
    }

    return `${ownerStatus()?.label ?? 'Another session'} controls this terminal.`;
  }

  function showConnectionUnavailableNotice(): void {
    const currentControlOwnerStatus = controlOwnerStatus();
    if (currentControlOwnerStatus && !currentControlOwnerStatus.isSelf) {
      return;
    }

    setStatusNotice('Connection unavailable. Try again.');
  }

  function applyTakeOverResult(
    result: Awaited<ReturnType<typeof requestRemoteTaskTakeover>> | 'transport-unavailable',
  ): void {
    switch (result) {
      case 'acquired':
        setForceTakeover(false);
        setStatusNotice('You now control this terminal.');
        scheduleFitAndResize();
        return;
      case 'denied':
        setForceTakeover(false);
        setStatusNotice('The other session kept control.');
        return;
      case 'force-required':
        setForceTakeover(true);
        setStatusNotice('No response yet. Force takeover if you need control now.');
        return;
      case 'transport-unavailable':
        setStatusNotice('Connection unavailable. Try again.');
        return;
    }
  }

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

  createEffect(() => {
    const currentControlOwnerStatus = controlOwnerStatus();
    if (term) {
      term.options.disableStdin = Boolean(
        currentControlOwnerStatus && !currentControlOwnerStatus.isSelf,
      );
    }

    if (!currentControlOwnerStatus || currentControlOwnerStatus.isSelf) {
      setForceTakeover(false);
      if (currentControlOwnerStatus?.isSelf) {
        setStatusNotice(null);
        scheduleFitAndResize();
      }
    }
  });

  createEffect(() => {
    const currentAgent = agentInfo();
    if (!currentAgentId) {
      return;
    }

    if (currentAgent) {
      updateAgentMissing(false);
      return;
    }

    if (hasTerminalData) {
      updateAgentMissing(true);
    }
  });

  createEffect(
    on(taskId, (nextTaskId, previousTaskId) => {
      if (!previousTaskId || previousTaskId === nextTaskId) {
        return;
      }

      currentTaskId = nextTaskId;
      void releaseRemoteTaskCommand(previousTaskId);
      setStatusNotice(null);
      setForceTakeover(false);
    }),
  );

  function updateAgentMissing(value: boolean): void {
    agentMissingValue = value;
    setAgentMissing(value);
  }

  function applyFontSize(nextSize: number): void {
    setTermFontSize(nextSize);
    if (term) {
      term.options.fontSize = nextSize;
      scheduleFitAndResize({ refresh: true });
    }
  }

  function clearMissingAgentTimer(): void {
    if (missingAgentTimer) {
      clearTimeout(missingAgentTimer);
      missingAgentTimer = null;
    }
  }

  function startMissingAgentTimer(): void {
    clearMissingAgentTimer();
    missingAgentTimer = setTimeout(() => {
      if (hasTerminalData) {
        return;
      }
      const exists = agents().some((agent) => agent.agentId === currentAgentId);
      if (!exists) {
        updateAgentMissing(true);
      }
    }, 3000);
  }

  function markTerminalActive(): void {
    hasTerminalData = true;
    updateAgentMissing(false);
    clearMissingAgentTimer();
  }

  function flushBufferedOutput(): void {
    if (!term || bufferedOutput.length === 0) {
      return;
    }

    const queued = bufferedOutput;
    bufferedOutput = [];
    for (const chunk of queued) {
      term.write(chunk);
    }
  }

  function scheduleResizeSend(): void {
    if (resizeDebounceTimer) {
      clearTimeout(resizeDebounceTimer);
    }
    resizeDebounceTimer = setTimeout(() => {
      if (!term) {
        return;
      }

      const activeTaskId = getActiveTaskId();
      if (!activeTaskId) {
        return;
      }

      sendRemoteAgentResize(currentAgentId, activeTaskId, term.cols, term.rows);
    }, 100);
  }

  function refreshTerminalViewport(): void {
    if (!term) {
      return;
    }

    term.refresh(0, Math.max(term.rows - 1, 0));
  }

  function fitAndResize(options?: { refresh?: boolean }): void {
    fitAddon?.fit();
    if (options?.refresh) {
      refreshTerminalViewport();
    }
    scheduleResizeSend();
  }

  function scheduleFitAndResize(options?: { refresh?: boolean }): void {
    cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => {
      fitAndResize(options);
      requestAnimationFrame(() => {
        fitAndResize(options);
      });
    });
  }

  async function handleTerminalInput(data: string): Promise<void> {
    if (agentMissing()) {
      return;
    }

    const activeTaskId = getActiveTaskId();
    if (!activeTaskId) {
      return;
    }

    const sent = await sendRemoteAgentInput(currentAgentId, activeTaskId, data).catch(() => false);
    if (sent) {
      setStatusNotice(null);
      return;
    }

    showConnectionUnavailableNotice();
  }

  function handleQuickAction(data: string): void {
    if (agentMissing()) {
      return;
    }
    haptic();
    void handleTerminalInput(data);
  }

  function handleKill(): void {
    haptic();
    sendKill(currentAgentId);
    setShowKillConfirm(false);
  }

  async function handleTakeOver(): Promise<void> {
    const currentTaskIdValue = taskId();
    if (!currentTaskIdValue) {
      return;
    }

    haptic();
    setTakeoverBusy(true);
    const result = await requestRemoteTaskTakeover(currentTaskIdValue, forceTakeover()).catch(
      () => 'transport-unavailable' as const,
    );
    setTakeoverBusy(false);
    applyTakeOverResult(result);
  }

  function scrollToBottom(): void {
    term?.scrollToBottom();
  }

  onMount(() => {
    if (!detailRoot || !termContainer) {
      return;
    }
    currentAgentId = props.agentId;
    currentTaskId = taskId();

    term = new Terminal({
      fontSize: 10,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      theme: { background: '#0b0f14' },
      scrollback: 5000,
      cursorBlink: false,
      convertEol: false,
      disableStdin: readOnly(),
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);

    term.onData((data) => {
      if (agentMissingValue) {
        return;
      }

      untrack(() => {
        void handleTerminalInput(data);
      });
    });

    term.onScroll(() => {
      if (!term) {
        return;
      }
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
      if (resizeDebounceTimer) {
        clearTimeout(resizeDebounceTimer);
      }
      clearMissingAgentTimer();
      cleanupTouchGestures();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('orientationchange', onOrientationChange);
      observer.disconnect();
      unsubscribeAgent(currentAgentId);
      cleanupScrollback();
      cleanupOutput();
      if (currentTaskId) {
        void releaseRemoteTaskCommand(currentTaskId);
      }
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
        agentId={props.agentId}
        agentStatus={agentInfo()?.status}
        connectionStatus={status()}
        contextLine={formatRemoteTaskContext(
          agentInfo()?.taskMeta?.branchName ?? null,
          agentInfo()?.taskMeta?.folderName ?? null,
          agentInfo()?.taskMeta?.directMode === true,
        )}
        lastActivityAt={getAgentLastActivityAt(props.agentId)}
        onBack={props.onBack}
        onKill={() => setShowKillConfirm(true)}
        onTakeOver={() => {
          void handleTakeOver();
        }}
        ownerIsSelf={ownerStatus()?.isSelf ?? false}
        ownerLabel={ownerStatus()?.label ?? null}
        ownershipNotice={statusNotice()}
        showTakeOver={readOnly()}
        statusFlashClass={statusFlashClass()}
        takeOverBusy={takeoverBusy()}
        takeOverLabel={takeOverLabel()}
        taskName={agentInfo()?.taskName ?? props.taskName}
      />

      <div
        style={{
          flex: '1',
          'min-height': '0',
          padding: '0 var(--space-sm) var(--space-xs)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          class="remote-panel remote-terminal-shell"
          data-testid="remote-terminal-shell"
          style={{
            height: '100%',
            padding: 'var(--space-3xs)',
            'border-radius': '1.35rem',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              overflow: 'hidden',
              'border-radius': '1rem',
              background: 'rgba(4, 9, 14, 0.92)',
              border: '1px solid rgba(48, 69, 89, 0.65)',
            }}
          >
            <div
              ref={termContainer}
              role="region"
              aria-label={`Terminal output for ${agentInfo()?.taskName ?? props.taskName}`}
              style={{
                width: '100%',
                height: '100%',
                padding: '0.25rem',
              }}
            />

            <AgentMissingDialog onBack={props.onBack} open={agentMissing()} />
            <AgentKillConfirmDialog
              onCancel={() => setShowKillConfirm(false)}
              onConfirm={handleKill}
              open={showKillConfirm()}
            />
          </div>
        </div>
      </div>

      <ScrollToBottomButton
        onScrollToBottom={scrollToBottom}
        open={!atBottom() && !agentMissing()}
      />

      <Show when={!agentMissing()}>
        <AgentDetailControls
          agentMissing={agentMissing()}
          disabled={readOnly()}
          disabledReason={getReadOnlyReason()}
          fontSize={termFontSize()}
          onCommandSent={() => {
            setTimeout(() => term?.scrollToBottom(), 180);
          }}
          onFocusInput={() => {
            setTimeout(() => term?.scrollToBottom(), 300);
          }}
          onHaptic={haptic}
          onQuickAction={handleQuickAction}
          onSendText={(text) => {
            void handleTerminalInput(text);
          }}
          onSetFontSize={applyFontSize}
        />
      </Show>
    </div>
  );
}
