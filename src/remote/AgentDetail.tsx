import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
  untrack,
} from 'solid-js';
import type { TerminalRecoveryBatchEntry } from '../ipc/types';
import type { RemoteAgentStatus } from '../domain/server-state';
import type { RemoteTaskSessionRef } from '../domain/task-catalog';
import { createBoundedByteHistory } from '../lib/bounded-byte-history';
import { createRandomId } from '../lib/random-id';
import { lazyNamed } from '../lib/lazy-named';
import {
  UNAVAILABLE_TASK_NOTES_CAPABILITY,
  type TaskNotesCapability,
} from '../app/task-notes-capability';
import { b64decode } from './base64';
import { AgentDetailControls } from './AgentDetailControls';
import { AgentDetailHeader } from './AgentDetailHeader';
import {
  AgentKillConfirmDialog,
  AgentMissingDialog,
  ScrollToBottomButton,
} from './AgentDetailOverlays';
import { formatRemoteTaskContext, isRemoteCurrentBranchTask } from './agent-presentation';
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
  onTerminalRecoveryResult,
  onTerminalStream,
  requestRemoteTerminalRecovery,
  requestRemoteTerminalStartupRecovery,
  sendKill,
  status,
  subscribeAgent,
  subscribeRemoteConnectionStatus,
  unsubscribeAgent,
} from './ws';

const TERMINAL_RECOVERY_TIMEOUT_MS = 5_000;
const TERMINAL_RECOVERY_MAX_ATTEMPTS = 3;
const TERMINAL_RECOVERY_TAIL_MAX_BYTES = 64 * 1024;
const BASE64_CHUNK_SIZE = 0x8000;
const TaskNotesView = lazyNamed(() => import('./TaskNotesView'), 'TaskNotesView');

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  const bytesWithNativeBase64 = bytes as Uint8Array & {
    toBase64?: () => string;
  };
  if (typeof bytesWithNativeBase64.toBase64 === 'function') {
    return bytesWithNativeBase64.toBase64();
  }

  let binary = '';
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(index, index + BASE64_CHUNK_SIZE);
    for (const value of chunk) {
      binary += String.fromCharCode(value);
    }
  }

  return btoa(binary);
}

function encodeRecoveryTail(bytes: Uint8Array): string | null {
  return bytes.length > 0 ? uint8ArrayToBase64(bytes) : null;
}

function haptic(): void {
  if ('vibrate' in navigator) {
    navigator.vibrate(8);
  }
}

interface AgentDetailProps {
  agentId: string;
  confirm?: (message: string) => boolean;
  taskName: string;
  taskNotesCapability?: TaskNotesCapability;
  taskSession?: RemoteTaskSessionRef;
  terminalControl?: boolean;
  terminalKill?: boolean;
  onBack: () => void;
}

function getCatalogSessionStatus(state: RemoteTaskSessionRef['state']): RemoteAgentStatus {
  return state === 'running' ? 'running' : 'exited';
}

export function AgentDetail(props: AgentDetailProps): JSX.Element {
  let detailRoot: HTMLDivElement | undefined;
  let notesTab: HTMLButtonElement | undefined;
  let termContainer: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let terminalTab: HTMLButtonElement | undefined;
  let fitAddon: FitAddon | undefined;
  let currentAgentId = '';
  let currentTaskId: string | null = null;
  let notesNavigationPending = false;

  const [atBottom, setAtBottom] = createSignal(true);
  const [termFontSize, setTermFontSize] = createSignal(10);
  const [agentMissing, setAgentMissing] = createSignal(false);
  const [showKillConfirm, setShowKillConfirm] = createSignal(false);
  const [statusFlashClass, setStatusFlashClass] = createSignal('');
  const [swipeOffset, setSwipeOffset] = createSignal(0);
  const [takeoverBusy, setTakeoverBusy] = createSignal(false);
  const [forceTakeover, setForceTakeover] = createSignal(false);
  const [statusNotice, setStatusNotice] = createSignal<string | null>(null);
  const [activeView, setActiveView] = createSignal<'terminal' | 'notes'>('terminal');

  const terminalId = createMemo(() => props.taskSession?.sessionId ?? props.agentId);
  const selectedAgent = createMemo(() => {
    const agentId = props.taskSession?.agentId ?? props.agentId;
    return agents().find((agent) => agent.agentId === agentId);
  });
  const taskId = createMemo(() => props.taskSession?.taskId ?? selectedAgent()?.taskId ?? null);
  const selectedAgentStatus = createMemo(() =>
    props.taskSession ? getCatalogSessionStatus(props.taskSession.state) : selectedAgent()?.status,
  );
  const selectedTaskName = createMemo(() => selectedAgent()?.taskName ?? props.taskName);
  const selectedTaskContextLine = createMemo(() => {
    const taskMeta = selectedAgent()?.taskMeta;
    return formatRemoteTaskContext(
      taskMeta?.branchName ?? null,
      taskMeta?.folderName ?? null,
      isRemoteCurrentBranchTask(taskMeta),
      taskMeta?.worktreeOwnership ?? null,
      taskMeta?.projectMode ?? null,
    );
  });
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
  const readOnly = createMemo(
    () =>
      props.terminalControl === false ||
      Boolean(controlOwnerStatus() && !controlOwnerStatus()?.isSelf),
  );
  const takeOverLabel = createMemo(() => (forceTakeover() ? 'Force Take Over' : 'Take Over'));
  const notesAvailable = createMemo(
    () =>
      (props.taskNotesCapability ?? UNAVAILABLE_TASK_NOTES_CAPABILITY).read && taskId() !== null,
  );

  createEffect(() => {
    if (!notesAvailable() && activeView() === 'notes') showTerminal();
  });

  function showTerminal(): void {
    setActiveView('terminal');
    requestAnimationFrame(() => {
      const target = term;
      if (target) refreshTerminalViewport(target);
      scheduleFitAndResize();
    });
  }

  function selectDetailView(view: 'terminal' | 'notes'): void {
    if (view === 'terminal') showTerminal();
    else setActiveView('notes');
  }

  function handleDetailTabKeyDown(event: KeyboardEvent): void {
    let nextView: 'terminal' | 'notes' | null = null;
    if (event.key === 'ArrowRight' || event.key === 'End') nextView = 'notes';
    if (event.key === 'ArrowLeft' || event.key === 'Home') nextView = 'terminal';
    if (!nextView) return;
    event.preventDefault();
    selectDetailView(nextView);
    requestAnimationFrame(() => (nextView === 'terminal' ? terminalTab : notesTab)?.focus());
  }

  function requestBack(): void {
    const activeTaskId = getActiveTaskId();
    const confirmDiscard = props.confirm ?? ((message: string) => window.confirm(message));
    const onBack = props.onBack;
    if (!notesAvailable() || !activeTaskId) {
      onBack();
      return;
    }
    if (notesNavigationPending) return;
    notesNavigationPending = true;
    void import('./TaskNotesView')
      .then(async (runtime) => {
        if (
          !(await runtime.confirmRemoteTaskNotesLeave(
            activeTaskId,
            'Discard the unsaved notes draft and choose another task?',
            confirmDiscard,
          ))
        ) {
          return;
        }
        onBack();
      })
      .catch(() => {
        setStatusNotice(
          'Notes draft status could not be checked. Try again before leaving the task.',
        );
      })
      .finally(() => {
        notesNavigationPending = false;
      });
  }

  function getActiveTaskId(): string | null {
    return taskId() ?? currentTaskId;
  }

  function getReadOnlyReason(): string | null {
    if (!readOnly()) {
      return null;
    }

    if (props.terminalControl === false) {
      return 'This secure session has read-only terminal access.';
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

  let fitRaf: number | null = null;
  let settleFitRaf: number | null = null;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let missingAgentTimer: ReturnType<typeof setTimeout> | null = null;
  let commandScrollTimer: ReturnType<typeof setTimeout> | null = null;
  let focusScrollTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let takeoverRequestId = 0;
  let activeRecoveryRequestId: string | null = null;
  let disposed = false;
  let restoringScrollback = false;
  let terminalRestoreGeneration = 0;
  let hasTerminalData = false;
  let agentMissingValue = false;
  let bufferedOutput: Uint8Array[] = [];
  let renderedOutputCursor: number | null = 0;
  const renderedTail = createBoundedByteHistory(TERMINAL_RECOVERY_TAIL_MAX_BYTES);

  createEffect(
    on(selectedAgentStatus, (next, prev) => {
      if (next && prev && next !== prev) {
        setStatusFlashClass((current) =>
          current === 'status-flash-a' ? 'status-flash-b' : 'status-flash-a',
        );
      }
    }),
  );

  createEffect(() => {
    const currentControlOwnerStatus = controlOwnerStatus();
    if (term) {
      term.options.disableStdin = readOnly();
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
    const currentAgent = selectedAgent();
    if (!currentAgentId) {
      return;
    }

    if (props.taskSession || currentAgent) {
      updateAgentMissing(false);
      return;
    }

    if (hasTerminalData) {
      updateAgentMissing(true);
    }
  });

  createEffect(
    on(taskId, (nextTaskId, previousTaskId) => {
      currentTaskId = nextTaskId;
      if (!previousTaskId || previousTaskId === nextTaskId) {
        return;
      }

      takeoverRequestId += 1;
      setTakeoverBusy(false);
      setStatusNotice(null);
      setForceTakeover(false);
      clearDelayedScrollTimers();
      clearResizeDebounceTimer();
      scheduleFitAndResize();
      void releaseRemoteTaskCommand(previousTaskId);
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
    if (props.taskSession) return;
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

  function recordLiveTerminalBytes(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }

    if (renderedOutputCursor !== null) {
      renderedOutputCursor += bytes.length;
    }
    renderedTail.append(bytes);
  }

  function recordDeltaRecovery(
    entry: TerminalRecoveryBatchEntry,
    recovery: Extract<TerminalRecoveryBatchEntry['recovery'], { kind: 'delta' }>,
    delta: Uint8Array,
  ): void {
    if (recovery.source === 'tail' && recovery.overlapBytes > 0) {
      const overlap = renderedTail.getTailBytes(recovery.overlapBytes);
      const nextTail = new Uint8Array(overlap.length + delta.length);
      nextTail.set(overlap, 0);
      nextTail.set(delta, overlap.length);
      renderedTail.replace(nextTail);
    } else {
      renderedTail.append(delta);
    }

    renderedOutputCursor = entry.outputCursor;
  }

  function getTerminalRecoveryRequestMetadata(): {
    outputCursor: number | null;
    renderedTail: string | null;
  } {
    const bufferedBytes = concatenateBufferedOutput();
    if (bufferedBytes.length === 0) {
      return {
        outputCursor: renderedOutputCursor,
        renderedTail: encodeRecoveryTail(renderedTail.getBytes()),
      };
    }

    const requestTail = createBoundedByteHistory(TERMINAL_RECOVERY_TAIL_MAX_BYTES);
    requestTail.replace(renderedTail.getBytes());
    requestTail.append(bufferedBytes);
    return {
      outputCursor:
        renderedOutputCursor === null ? null : renderedOutputCursor + bufferedBytes.length,
      renderedTail: encodeRecoveryTail(requestTail.getBytes()),
    };
  }

  function writeLiveTerminalBytes(
    bytes: Uint8Array,
    target: Terminal | undefined = term,
    onRendered?: () => void,
  ): void {
    target?.write(bytes, onRendered);
    recordLiveTerminalBytes(bytes);
  }

  function flushBufferedOutput(target: Terminal | undefined = term, onRendered?: () => void): void {
    if (!target) {
      return;
    }
    if (bufferedOutput.length === 0) {
      onRendered?.();
      return;
    }

    const queued = bufferedOutput;
    bufferedOutput = [];
    for (let index = 0; index < queued.length; index += 1) {
      const chunk = queued[index];
      if (!chunk) {
        continue;
      }
      writeLiveTerminalBytes(chunk, target, index === queued.length - 1 ? onRendered : undefined);
    }
  }

  function concatenateBufferedOutput(): Uint8Array {
    if (bufferedOutput.length === 0) {
      return new Uint8Array(0);
    }

    const totalBytes = bufferedOutput.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of bufferedOutput) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  function clearTerminalRecoveryTimer(): void {
    if (terminalRecoveryTimer === null) {
      return;
    }

    clearTimeout(terminalRecoveryTimer);
    terminalRecoveryTimer = null;
  }

  function beginTerminalRestore(options?: { dropBufferedOutput?: boolean }): void {
    terminalRestoreGeneration += 1;
    restoringScrollback = true;
    if (options?.dropBufferedOutput) {
      bufferedOutput = [];
    }
  }

  function beginTrackedTerminalRestore(
    requestId: string,
    options?: {
      dropBufferedOutput?: boolean;
      onWatchdogTimeout?: () => boolean;
    },
  ): void {
    activeRecoveryRequestId = requestId;
    beginTerminalRestore(options);
    armTerminalRecoveryWatchdog(requestId, options?.onWatchdogTimeout);
  }

  function armTerminalRecoveryWatchdog(
    requestId: string,
    onWatchdogTimeout: (() => boolean) | undefined,
  ): void {
    clearTerminalRecoveryTimer();
    terminalRecoveryTimer = setTimeout(() => {
      terminalRecoveryTimer = null;
      if (activeRecoveryRequestId !== requestId) {
        return;
      }

      if (onWatchdogTimeout && !onWatchdogTimeout()) {
        finishTrackedTerminalRestore(requestId);
        return;
      }

      if (activeRecoveryRequestId === requestId) {
        armTerminalRecoveryWatchdog(requestId, onWatchdogTimeout);
      }
    }, TERMINAL_RECOVERY_TIMEOUT_MS);
  }

  function finishTerminalRestore(): void {
    terminalRestoreGeneration += 1;
    restoringScrollback = false;
    flushBufferedOutput();
    term?.scrollToBottom();
    scheduleFitAndResize();
  }

  function finishTrackedTerminalRestore(requestId: string): void {
    if (activeRecoveryRequestId !== requestId) {
      return;
    }

    activeRecoveryRequestId = null;
    clearTerminalRecoveryTimer();
    finishTerminalRestore();
  }

  function isCurrentTerminalRestore(
    target: Terminal,
    targetAgentId: string,
    restoreGeneration: number,
  ): boolean {
    return (
      !disposed &&
      term === target &&
      currentAgentId === targetAgentId &&
      terminalRestoreGeneration === restoreGeneration
    );
  }

  function finishAcceptedTerminalRestore(options: {
    onRendered?: () => void;
    requestId?: string;
    restoreGeneration: number;
    targetAgentId: string;
    targetTerm: Terminal;
  }): void {
    const { onRendered, requestId, restoreGeneration, targetAgentId, targetTerm } = options;
    if (
      !isCurrentTerminalRestore(targetTerm, targetAgentId, restoreGeneration) ||
      (requestId !== undefined && activeRecoveryRequestId !== requestId)
    ) {
      return;
    }

    onRendered?.();
    if (requestId !== undefined) {
      activeRecoveryRequestId = null;
      clearTerminalRecoveryTimer();
    }
    restoringScrollback = false;

    let presentationSettled = false;
    flushBufferedOutput(targetTerm, () => {
      if (presentationSettled) {
        return;
      }
      presentationSettled = true;
      if (!isCurrentTerminalRestore(targetTerm, targetAgentId, restoreGeneration)) {
        return;
      }

      targetTerm.scrollToBottom();
      refreshTerminalViewport(targetTerm);
      scheduleFitAndResize();
    });
  }

  function writeTerminalRecoveryPayload(
    requestId: string,
    payload: Uint8Array,
    options: {
      clear?: boolean;
      onRendered?: () => void;
      reset?: boolean;
    } = {},
  ): void {
    const targetTerm = term;
    if (!targetTerm) {
      finishTrackedTerminalRestore(requestId);
      return;
    }

    const targetAgentId = currentAgentId;
    terminalRestoreGeneration += 1;
    const restoreGeneration = terminalRestoreGeneration;

    if (options.reset) {
      targetTerm.reset();
    } else if (options.clear) {
      targetTerm.clear();
    }

    let writeCompleted = false;
    targetTerm.write(payload, () => {
      if (writeCompleted) {
        return;
      }
      writeCompleted = true;
      finishAcceptedTerminalRestore({
        onRendered: options.onRendered,
        requestId,
        restoreGeneration,
        targetAgentId,
        targetTerm,
      });
    });
  }

  function requestTrackedTerminalRecovery(sendRequest: (requestId: string) => boolean): void {
    const requestId = createRandomId();
    let attempts = 0;

    function sendCurrentRequest(): boolean {
      attempts += 1;
      return sendRequest(requestId);
    }

    beginTrackedTerminalRestore(requestId, {
      onWatchdogTimeout: () => attempts < TERMINAL_RECOVERY_MAX_ATTEMPTS && sendCurrentRequest(),
    });
    if (!sendCurrentRequest()) {
      finishTrackedTerminalRestore(requestId);
    }
  }

  function applyTerminalRecoveryEntry(entry: TerminalRecoveryBatchEntry): void {
    if (entry.agentId !== currentAgentId) {
      return;
    }
    if (entry.requestId !== activeRecoveryRequestId) {
      return;
    }

    markTerminalActive();
    if (term && entry.cols > 0 && entry.rows > 0) {
      term.resize(entry.cols, entry.rows);
    }

    switch (entry.recovery.kind) {
      case 'noop':
        renderedOutputCursor = entry.outputCursor;
        finishTrackedTerminalRestore(entry.requestId);
        return;
      case 'delta': {
        const recovery = entry.recovery;
        const delta = b64decode(recovery.data);
        writeTerminalRecoveryPayload(entry.requestId, delta, {
          onRendered: () => recordDeltaRecovery(entry, recovery, delta),
        });
        return;
      }
      case 'snapshot':
        beginTerminalRestore({ dropBufferedOutput: true });
        {
          const snapshot = entry.recovery.data ? b64decode(entry.recovery.data) : new Uint8Array(0);
          writeTerminalRecoveryPayload(entry.requestId, snapshot, {
            clear: true,
            onRendered: () => {
              renderedTail.replace(snapshot);
              renderedOutputCursor = entry.outputCursor;
            },
          });
        }
        return;
      case 'terminal-state': {
        const terminalState = b64decode(entry.recovery.data);
        beginTerminalRestore({ dropBufferedOutput: true });
        writeTerminalRecoveryPayload(entry.requestId, terminalState, {
          onRendered: () => {
            renderedTail.replace(new Uint8Array(0));
            renderedOutputCursor = entry.outputCursor;
          },
          reset: true,
        });
        return;
      }
    }
  }

  function requestTerminalRecovery(): void {
    const { outputCursor, renderedTail: currentRenderedTail } =
      getTerminalRecoveryRequestMetadata();
    requestTrackedTerminalRecovery((requestId) =>
      requestRemoteTerminalRecovery({
        agentId: currentAgentId,
        outputCursor,
        renderedTail: currentRenderedTail,
        requestId,
        snapshotByteLimit: null,
      }),
    );
  }

  function requestTerminalStartupRecovery(): void {
    if (!currentAgentId) {
      return;
    }

    requestTrackedTerminalRecovery((requestId) =>
      requestRemoteTerminalStartupRecovery({
        agentId: currentAgentId,
        requestId,
        role: 'selected',
        visibleTerminalCount: 1,
      }),
    );
  }

  function clearResizeDebounceTimer(): void {
    if (resizeDebounceTimer) {
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = null;
    }
  }

  function scheduleResizeSend(): void {
    clearResizeDebounceTimer();
    if (props.terminalControl === false) return;
    const activeAgentId = currentAgentId;
    const activeTaskId = getActiveTaskId();

    resizeDebounceTimer = setTimeout(() => {
      resizeDebounceTimer = null;
      if (!term || !activeTaskId) {
        return;
      }

      if (currentAgentId !== activeAgentId || getActiveTaskId() !== activeTaskId) {
        return;
      }

      sendRemoteAgentResize(activeAgentId, activeTaskId, term.cols, term.rows);
    }, 100);
  }

  function refreshTerminalViewport(target: Terminal): void {
    if (target.rows <= 0) {
      return;
    }

    try {
      target.refresh(0, target.rows - 1);
    } catch {
      // Repaint is cosmetic and may race terminal disposal.
    }
  }

  function fitAndResize(options?: { refresh?: boolean }): void {
    fitAddon?.fit();
    if (options?.refresh) {
      const target = term;
      if (target) {
        refreshTerminalViewport(target);
      }
    }
    scheduleResizeSend();
  }

  function cancelFitFrames(): void {
    if (fitRaf !== null) {
      cancelAnimationFrame(fitRaf);
      fitRaf = null;
    }
    if (settleFitRaf !== null) {
      cancelAnimationFrame(settleFitRaf);
      settleFitRaf = null;
    }
  }

  function scheduleFitAndResize(options?: { refresh?: boolean }): void {
    cancelFitFrames();
    fitRaf = requestAnimationFrame(() => {
      fitRaf = null;
      fitAndResize(options);
      settleFitRaf = requestAnimationFrame(() => {
        settleFitRaf = null;
        fitAndResize(options);
      });
    });
  }

  function scheduleCommandScrollToBottom(): void {
    if (commandScrollTimer) {
      clearTimeout(commandScrollTimer);
    }
    commandScrollTimer = setTimeout(() => {
      commandScrollTimer = null;
      term?.scrollToBottom();
    }, 180);
  }

  function scheduleFocusScrollToBottom(): void {
    if (focusScrollTimer) {
      clearTimeout(focusScrollTimer);
    }
    focusScrollTimer = setTimeout(() => {
      focusScrollTimer = null;
      term?.scrollToBottom();
    }, 300);
  }

  function clearDelayedScrollTimers(): void {
    if (commandScrollTimer) {
      clearTimeout(commandScrollTimer);
      commandScrollTimer = null;
    }
    if (focusScrollTimer) {
      clearTimeout(focusScrollTimer);
      focusScrollTimer = null;
    }
  }

  async function handleTerminalInput(data: string): Promise<void> {
    if (agentMissing() || props.terminalControl === false) {
      return;
    }

    const activeTaskId = getActiveTaskId();
    if (!activeTaskId) {
      return;
    }

    const sent = await sendRemoteAgentInput(currentAgentId, activeTaskId, data).catch(() => false);
    if (getActiveTaskId() !== activeTaskId) {
      return;
    }

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
    if (props.terminalKill === false) return;
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
    const requestId = ++takeoverRequestId;
    setTakeoverBusy(true);
    const result = await requestRemoteTaskTakeover(currentTaskIdValue, forceTakeover()).catch(
      () => 'transport-unavailable' as const,
    );
    if (requestId !== takeoverRequestId || taskId() !== currentTaskIdValue) {
      return;
    }

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
    currentAgentId = terminalId();
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
      activeRecoveryRequestId = null;
      clearTerminalRecoveryTimer();
      beginTerminalRestore({ dropBufferedOutput: true });
      const targetTerm = term;
      if (!targetTerm) {
        finishTerminalRestore();
        return;
      }
      targetTerm.clear();
      const bytes = b64decode(data);
      const targetAgentId = currentAgentId;
      terminalRestoreGeneration += 1;
      const restoreGeneration = terminalRestoreGeneration;
      let writeCompleted = false;
      targetTerm.write(bytes, () => {
        if (writeCompleted) {
          return;
        }
        writeCompleted = true;
        finishAcceptedTerminalRestore({
          onRendered: () => {
            renderedTail.replace(bytes);
            renderedOutputCursor = null;
          },
          restoreGeneration,
          targetAgentId,
          targetTerm,
        });
      });
    });

    const cleanupTerminalStream = onTerminalStream(currentAgentId, (event) => {
      if (event.type === 'RecoveryRequired') {
        requestTerminalRecovery();
      }
    });

    const cleanupTerminalRecovery = onTerminalRecoveryResult((entry) => {
      applyTerminalRecoveryEntry(entry);
    });

    const cleanupOutput = onOutput(currentAgentId, (data) => {
      markTerminalActive();
      const bytes = b64decode(data);
      if (restoringScrollback) {
        bufferedOutput.push(bytes);
        return;
      }
      writeLiveTerminalBytes(bytes);
    });

    fitAndResize();
    subscribeAgent(currentAgentId, { terminalProtocol: 'structured' });
    const cleanupConnectionStatus = subscribeRemoteConnectionStatus((connectionStatus) => {
      if (connectionStatus === 'connected') {
        requestTerminalStartupRecovery();
        return;
      }

      activeRecoveryRequestId = null;
      clearTerminalRecoveryTimer();
      finishTerminalRestore();
    });
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
      onBack: requestBack,
      onHaptic: haptic,
    });

    onCleanup(() => {
      disposed = true;
      terminalRestoreGeneration += 1;
      takeoverRequestId += 1;
      setTakeoverBusy(false);
      cancelFitFrames();
      clearResizeDebounceTimer();
      clearDelayedScrollTimers();
      clearMissingAgentTimer();
      cleanupTouchGestures();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('orientationchange', onOrientationChange);
      observer.disconnect();
      unsubscribeAgent(currentAgentId);
      cleanupScrollback();
      cleanupTerminalStream();
      cleanupTerminalRecovery();
      cleanupOutput();
      cleanupConnectionStatus();
      activeRecoveryRequestId = null;
      clearTerminalRecoveryTimer();
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
        agentId={terminalId()}
        agentStatus={selectedAgentStatus()}
        {...(props.taskSession ? { backAriaLabel: 'Back to task details', backLabel: 'Task' } : {})}
        canKill={props.terminalKill !== false}
        connectionStatus={status()}
        contextLine={selectedTaskContextLine()}
        lastActivityAt={getAgentLastActivityAt(terminalId())}
        onBack={requestBack}
        onKill={() => setShowKillConfirm(true)}
        onTakeOver={() => {
          void handleTakeOver();
        }}
        ownerIsSelf={ownerStatus()?.isSelf ?? false}
        ownerLabel={ownerStatus()?.label ?? null}
        ownershipNotice={statusNotice()}
        showTakeOver={props.terminalControl !== false && readOnly()}
        statusFlashClass={statusFlashClass()}
        takeOverBusy={takeoverBusy()}
        takeOverLabel={takeOverLabel()}
        taskName={selectedTaskName()}
      />

      <Show when={notesAvailable()}>
        <div
          role="tablist"
          aria-label="Task detail view"
          aria-orientation="horizontal"
          onKeyDown={handleDetailTabKeyDown}
          style={{
            display: 'grid',
            'grid-template-columns': '1fr 1fr',
            gap: '2px',
            margin: '0 var(--space-sm) var(--space-xs)',
            padding: '2px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            'border-radius': '0.75rem',
          }}
        >
          <button
            aria-controls="remote-terminal-panel"
            id="remote-terminal-tab"
            ref={terminalTab}
            type="button"
            role="tab"
            aria-selected={activeView() === 'terminal'}
            tabindex={activeView() === 'terminal' ? 0 : -1}
            onClick={showTerminal}
            style={{ 'min-height': '44px', 'border-radius': '0.6rem' }}
          >
            Terminal
          </button>
          <button
            aria-controls="remote-task-notes-panel"
            id="remote-task-notes-tab"
            ref={notesTab}
            type="button"
            role="tab"
            aria-selected={activeView() === 'notes'}
            tabindex={activeView() === 'notes' ? 0 : -1}
            onClick={() => setActiveView('notes')}
            style={{ 'min-height': '44px', 'border-radius': '0.6rem' }}
          >
            Notes
          </button>
        </div>
      </Show>

      <div
        style={{
          flex: '1',
          'min-height': '0',
          padding: '0 var(--space-sm) var(--space-xs)',
          position: 'relative',
          overflow: activeView() === 'terminal' ? 'hidden' : 'auto',
        }}
      >
        <div
          aria-labelledby="remote-terminal-tab"
          class="remote-panel remote-terminal-shell"
          data-testid="remote-terminal-shell"
          id="remote-terminal-panel"
          role="tabpanel"
          style={{
            display: activeView() === 'terminal' ? 'block' : 'none',
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
              aria-label={`Terminal output for ${selectedTaskName()}`}
              style={{
                width: '100%',
                height: '100%',
                padding: '0.25rem',
              }}
            />

            <AgentMissingDialog onBack={requestBack} open={agentMissing()} />
            <AgentKillConfirmDialog
              onCancel={() => setShowKillConfirm(false)}
              onConfirm={handleKill}
              open={showKillConfirm()}
            />
          </div>
        </div>
        <Show when={notesAvailable() && activeView() === 'notes'}>
          <div aria-labelledby="remote-task-notes-tab" id="remote-task-notes-panel" role="tabpanel">
            <Suspense
              fallback={
                <div
                  role="status"
                  style={{ padding: 'var(--space-md)', color: 'var(--text-muted)' }}
                >
                  Loading notes…
                </div>
              }
            >
              <TaskNotesView
                canWrite={(props.taskNotesCapability ?? UNAVAILABLE_TASK_NOTES_CAPABILITY).write}
                taskId={taskId() ?? ''}
                taskName={selectedTaskName()}
                onChooseAnotherTask={requestBack}
              />
            </Suspense>
          </div>
        </Show>
      </div>

      <Show when={activeView() === 'terminal'}>
        <ScrollToBottomButton
          onScrollToBottom={scrollToBottom}
          open={!atBottom() && !agentMissing()}
        />
      </Show>

      <Show when={activeView() === 'terminal' && !agentMissing()}>
        <AgentDetailControls
          agentMissing={agentMissing()}
          disabled={readOnly()}
          disabledReason={getReadOnlyReason()}
          fontSize={termFontSize()}
          onCommandSent={scheduleCommandScrollToBottom}
          onFocusInput={scheduleFocusScrollToBottom}
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
