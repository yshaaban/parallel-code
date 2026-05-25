import {
  Show,
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';

import { getTerminalFontFamily } from '../lib/fonts';
import { getTerminalTheme } from '../lib/theme';
import { markDirty } from '../lib/terminalFitManager';
import { assertNever } from '../lib/assert-never';
import { theme } from '../lib/theme';
import {
  getTerminalExperimentSwitchPostInputReadyEchoGraceMs,
  getTerminalExperimentSwitchTargetWindowMs,
  getTerminalPerformanceExperimentConfig,
} from '../lib/terminal-performance-experiments';
import {
  isRendererRuntimeDiagnosticsEnabled,
  recordTerminalStartupFitExecution,
  recordTerminalStartupFitSchedule,
  recordTerminalPresentationBlockedInput,
  recordTerminalPresentationTransition,
  recordTerminalStartupLogicalReady,
  recordTerminalStartupLogicalToPaintReadyDelay,
  recordTerminalStartupPaintReady,
  recordTerminalStartupRenderEvent,
  recordTerminalStartupWrite,
} from '../app/runtime-diagnostics';
import { syncFocusedTypingTaskCommandLease } from '../app/task-command-lease-session';
import { isPanelResizeDragging } from '../app/panel-resize-drag';
import { setTaskFocusedPanelState, store } from '../store/store';
import { loadTaskCommandControllers } from '../store/task-command-controllers';
import { clearTerminalStartupEntry, setTerminalStartupPhase } from '../store/terminal-startup';
import {
  clearTerminalStartupPaintCoordinationEntry,
  getGlobalTerminalStartupPaintCoordinationSnapshot,
  setTerminalStartupPaintCoordinationEntry,
  subscribeTerminalStartupPaintCoordinationChanges,
} from '../app/terminal-startup-paint';
import { TaskControlBanner } from './TaskControlBanner';
import { TaskControlChip } from './TaskControlChip';
import { createTaskControlVisualState } from './task-control-visual-state';
import {
  notifyTerminalAttachPolicyChanged,
  registerTerminalAttachCandidate,
} from '../app/terminal-attach-scheduler';
import {
  armFocusedTerminalOutputPreemption,
  requestTerminalOutputDrain,
} from '../app/terminal-output-scheduler';
import { markBrowserStartupSelectedTerminalReady } from '../app/browser-startup';
import { emitStartupBreadcrumb } from '../app/startup-breadcrumbs';
import { subscribeTerminalPrewarm } from '../app/terminal-prewarm';
import { subscribeTerminalDenseOverloadChanges } from '../app/terminal-dense-overload';
import {
  clearTerminalRecentHiddenCandidate,
  reserveTerminalRecentHiddenCandidate,
  subscribeTerminalRecentHiddenReservationChanges,
} from '../app/terminal-recent-hidden-reservation';
import {
  getTerminalAnomalyTerminalSnapshot,
  isTerminalAnomalyMonitorEnabled,
  registerTerminalAnomalyMonitorTerminal,
  subscribeTerminalAnomalyMonitorChanges,
  type TerminalAnomalyLifecycleState,
  type TerminalAnomalySeverity,
  type TerminalAnomalySnapshot,
} from '../app/terminal-anomaly-monitor';
import {
  getTerminalSurfaceTier,
  registerTerminalSurfaceTier,
  subscribeTerminalSurfaceTierChanges,
  type TerminalSurfaceTier,
} from '../app/terminal-surface-tiering';
import {
  beginTerminalSwitchWindow,
  cancelTerminalSwitchWindow,
  isTerminalSwitchTarget,
  isTerminalSwitchWindowOwner,
  isTerminalSwitchWindowTargetRecoveryActive,
  markTerminalSwitchWindowFirstPaint,
  markTerminalSwitchWindowInputReady,
  markTerminalSwitchWindowRecoverySettled,
  markTerminalSwitchWindowRecoveryStarted,
  subscribeTerminalSwitchWindowChanges,
} from '../app/terminal-switch-window';
import {
  beginTerminalSwitchEchoGrace,
  cancelTerminalSwitchEchoGrace,
} from '../app/terminal-switch-echo-grace';
import { getVisibleTerminalCount, registerTerminalVisibility } from '../app/terminal-visible-set';
import { startLoadedTerminalSession } from './terminal-view/terminal-session-loader';
import type { TerminalAttachMilestone, TerminalSession } from './terminal-view/terminal-session';
import type {
  TerminalPresentationMode,
  TerminalViewProps,
  TerminalViewStatus,
} from './terminal-view/types';
import { getTerminalOutputPriority } from '../lib/terminal-output-priority';

let nextTerminalViewInstanceId = 1;

function isElementVisibleInViewport(element: Element): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';

function getTerminalFocusElement(root: HTMLElement | undefined): HTMLElement | null {
  if (!root) {
    return null;
  }

  return root.querySelector<HTMLElement>(TERMINAL_INPUT_SELECTOR);
}

function isTerminalDomFocused(element: HTMLElement | undefined): boolean {
  if (typeof document === 'undefined' || !element) {
    return false;
  }

  const activeElement = document.activeElement;
  const terminalFocusElement = getTerminalFocusElement(element);
  return (
    activeElement instanceof HTMLElement &&
    terminalFocusElement instanceof HTMLElement &&
    terminalFocusElement.contains(activeElement)
  );
}

function hasDocumentFocus(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }

  return typeof document.hasFocus !== 'function' || document.hasFocus();
}

function hasBlockingDialogOpen(): boolean {
  return (
    store.showNewTaskDialog ||
    store.showHelpDialog ||
    store.showSettingsDialog ||
    store.markdownViewer !== null
  );
}

function getRoundedPerformanceNow(): number {
  return Math.round(performance.now() * 100) / 100;
}

type TerminalAttachTraceStatus =
  | TerminalViewStatus
  | 'channel-ready'
  | 'fit-ready'
  | 'queued'
  | 'recovering'
  | 'spawned'
  | 'spawning';

interface TerminalAttachTraceEntry {
  agentId: string;
  attachBoundAtMs: number | null;
  attachFitReadyAtMs: number | null;
  attachQueuedAtMs: number;
  attachStartedAtMs: number | null;
  channelReadyAtMs: number | null;
  key: string;
  paintReadyAtMs: number | null;
  readyAtMs: number | null;
  recoverySettledAtMs: number | null;
  recoveryStartedAtMs: number | null;
  selectedInteractiveAtMs: number | null;
  spawnRequestedAtMs: number | null;
  spawnResolvedAtMs: number | null;
  status: TerminalAttachTraceStatus;
  taskId: string;
}

declare global {
  interface Window {
    __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, TerminalAttachTraceEntry>;
  }
}

function shouldRecordTerminalAttachTrace(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ !== undefined;
}

function beginTerminalAttachTraceEntry(
  key: string,
  taskId: string,
  agentId: string,
): TerminalAttachTraceEntry | null {
  if (!shouldRecordTerminalAttachTrace()) {
    return null;
  }

  const traceStore = window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ ?? {};
  const nextEntry: TerminalAttachTraceEntry = {
    agentId,
    attachBoundAtMs: null,
    attachFitReadyAtMs: null,
    attachQueuedAtMs: getRoundedPerformanceNow(),
    attachStartedAtMs: null,
    channelReadyAtMs: null,
    key,
    paintReadyAtMs: null,
    readyAtMs: null,
    recoverySettledAtMs: null,
    recoveryStartedAtMs: null,
    selectedInteractiveAtMs: null,
    spawnRequestedAtMs: null,
    spawnResolvedAtMs: null,
    status: 'queued',
    taskId,
  };
  traceStore[key] = nextEntry;
  window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ = traceStore;
  return nextEntry;
}

function updateTerminalAttachTrace(
  key: string,
  updater: (entry: TerminalAttachTraceEntry) => void,
): void {
  if (!shouldRecordTerminalAttachTrace()) {
    return;
  }

  const traceStore = window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__;
  const existingEntry = traceStore?.[key];
  if (!existingEntry) {
    return;
  }

  updater(existingEntry);
}

function recordTerminalAttachMilestone(key: string, milestone: TerminalAttachMilestone): void {
  const atMs = getRoundedPerformanceNow();
  updateTerminalAttachTrace(key, (entry) => {
    switch (milestone) {
      case 'channel-ready':
        entry.channelReadyAtMs = atMs;
        entry.status = 'channel-ready';
        return;
      case 'attach-fit-ready':
        entry.attachFitReadyAtMs = atMs;
        entry.status = 'fit-ready';
        return;
      case 'spawn-requested':
        entry.spawnRequestedAtMs = atMs;
        entry.status = 'spawning';
        return;
      case 'spawn-resolved':
        entry.spawnResolvedAtMs = atMs;
        entry.status = 'spawned';
        return;
      case 'attach-recovery-started':
        entry.recoveryStartedAtMs = atMs;
        entry.status = 'recovering';
        return;
      case 'attach-recovery-settled':
        entry.recoverySettledAtMs = atMs;
        return;
      default:
        assertNever(milestone, 'Unhandled terminal attach milestone');
    }
  });
}

function clearScheduledSwitchWindowCompletion(completionFrame: number | undefined): void {
  if (completionFrame === undefined) {
    return;
  }

  cancelAnimationFrame(completionFrame);
}

function isRestoringTerminalStatus(status: TerminalViewStatus): boolean {
  switch (status) {
    case 'attaching':
    case 'restoring':
      return true;
    case 'binding':
    case 'error':
    case 'ready':
      return false;
    default:
      return assertNever(status, 'Unhandled terminal view status');
  }
}

function syncTerminalStartupPhaseForStatus(
  terminalStartupKey: string,
  status: TerminalViewStatus,
  ownerId?: number,
): void {
  switch (status) {
    case 'binding':
      return;
    case 'attaching':
      setTerminalStartupPhase(terminalStartupKey, 'attaching', ownerId);
      return;
    case 'restoring':
      setTerminalStartupPhase(terminalStartupKey, 'restoring', ownerId);
      return;
    case 'ready':
    case 'error':
      clearTerminalStartupEntry(terminalStartupKey, ownerId);
      return;
    default:
      return assertNever(status, 'Unhandled terminal startup status');
  }
}

function getTerminalLoadingLabel(status: TerminalViewStatus): string | null {
  switch (status) {
    case 'binding':
    case 'attaching':
    case 'restoring':
      return 'Preparing terminal…';
    case 'ready':
    case 'error':
      return null;
    default:
      return assertNever(status, 'Unhandled terminal loading status');
  }
}

type LoadingPresentationMode = Extract<TerminalPresentationMode, { kind: 'loading' }>;

interface TerminalAnomalyPresentation {
  count: number;
  kinds: string | null;
  label: string | null;
  severity: TerminalAnomalySeverity | null;
}

const EMPTY_TERMINAL_ANOMALY_PRESENTATION: TerminalAnomalyPresentation = {
  count: 0,
  kinds: null,
  label: null,
  severity: null,
};

function getLoadingPresentationMode(
  mode: TerminalPresentationMode,
): LoadingPresentationMode | null {
  if (mode.kind !== 'loading') {
    return null;
  }

  return mode;
}

function shouldMaskTerminalPresentationMode(mode: TerminalPresentationMode): boolean {
  switch (mode.kind) {
    case 'live':
    case 'error':
      return false;
    case 'loading':
      return true;
    default:
      return assertNever(mode, 'Unhandled terminal presentation mode');
  }
}

function getTerminalAnomalyPresentation(
  anomalies: readonly TerminalAnomalySnapshot[],
): TerminalAnomalyPresentation {
  if (anomalies.length === 0) {
    return EMPTY_TERMINAL_ANOMALY_PRESENTATION;
  }

  const kinds: string[] = [];
  const labels: string[] = [];
  let severity: TerminalAnomalySeverity = 'warning';

  for (const anomaly of anomalies) {
    kinds.push(anomaly.key);
    labels.push(anomaly.label);
    if (anomaly.severity === 'error') {
      severity = 'error';
    }
  }

  return {
    count: anomalies.length,
    kinds: kinds.join(','),
    label: labels.join(' · '),
    severity,
  };
}

export function TerminalView(props: TerminalViewProps): JSX.Element {
  const terminalInstanceId = nextTerminalViewInstanceId;
  nextTerminalViewInstanceId += 1;
  let shellRef!: HTMLDivElement;
  let containerRef!: HTMLDivElement;
  let session: TerminalSession | undefined;
  let attachRegistration: ReturnType<typeof registerTerminalAttachCandidate> | undefined;
  let prewarmCleanup: (() => void) | undefined;
  let switchWindowFirstPaintRaf: number | undefined;
  let switchWindowCompletionPending = false;
  let switchWindowCompletionRaf: number | undefined;
  let surfaceTierCleanup: (() => void) | undefined;
  let anomalyMonitorCleanup: (() => void) | undefined;
  let anomalyMonitorRegistration:
    | ReturnType<typeof registerTerminalAnomalyMonitorTerminal>
    | undefined;
  let denseOverloadCleanup: (() => void) | undefined;
  let recentHiddenReservationCleanup: (() => void) | undefined;
  let sessionDormancyTimer: number | undefined;
  let takeOverGeneration = 0;
  let sessionStartGeneration = 0;
  let pendingRecoveryFocusRestore = false;
  let terminalAttachInProgress = false;
  let terminalAttachQueued = false;
  let terminalAttachUnregisterPending = false;
  let lastRecordedPresentationMode: TerminalPresentationMode['kind'] | null = null;
  let sessionStartedOnce = false;
  let sessionStartupMeasurementGeneration = 0;
  let activeSessionStartupMeasurementGeneration = 0;
  let lastLogicalReadyMeasurementGeneration = 0;
  let lastPaintReadyMeasurementGeneration = 0;
  let lastLogicalReadyDurationMs: number | null = null;
  let lastLogicalReadyDurationGeneration = 0;
  let sessionStartupMeasurementStartedAtMs: number | null = null;
  let selectedInteractiveBreadcrumbEmitted = false;
  let terminalSessionLoadFailed = false;
  let isFocusedNow = false;
  let isSelectedNow = false;
  let isVisibleNow = false;
  let terminalVisibilityRegistration: ReturnType<typeof registerTerminalVisibility> | undefined;
  let terminalSurfaceTierRegistration: ReturnType<typeof registerTerminalSurfaceTier> | undefined;
  const taskId = untrack(() => props.taskId);
  const agentId = untrack(() => props.agentId);
  const managesTaskSwitchWindowLifecycle = untrack(
    () => props.manageTaskSwitchWindowLifecycle !== false,
  );
  const terminalStartupKey = `${taskId}:${agentId}`;
  const switchWindowOwnerId = managesTaskSwitchWindowLifecycle ? terminalStartupKey : taskId;
  const isInitiallyFocused = untrack(() => props.isFocused === true);
  const isInitiallyCommandTarget = untrack(() => props.isCommandTarget !== false);
  isFocusedNow = isInitiallyFocused;
  isSelectedNow = untrack(() => store.activeTaskId === taskId && isInitiallyCommandTarget);
  isVisibleNow = isInitiallyFocused;
  let previouslyFocused = isFocusedNow;
  let previouslySelected = isSelectedNow;
  let previouslyVisible = typeof IntersectionObserver !== 'function';
  const [sessionStatus, setSessionStatus] = createSignal<TerminalViewStatus>('binding');
  const [sessionDormant, setSessionDormant] = createSignal(false);
  const [renderHibernating, setRenderHibernating] = createSignal(false);
  const [restoreBlocked, setRestoreBlocked] = createSignal(false);
  const [resizeTransactionActive, setResizeTransactionActive] = createSignal(false);
  const [paintReady, setPaintReady] = createSignal(false);
  const [surfaceTierVersion, setSurfaceTierVersion] = createSignal(0);
  const [switchWindowVersion, setSwitchWindowVersion] = createSignal(0);
  const [anomalyMonitorVersion, setAnomalyMonitorVersion] = createSignal(0);
  const [takingOver, setTakingOver] = createSignal(false);
  const [domFocusWithin, setDomFocusWithin] = createSignal(false);
  const [documentFocusVersion, setDocumentFocusVersion] = createSignal(0);
  const [isVisible, setIsVisible] = createSignal(isInitiallyFocused);
  const [sessionVersion, setSessionVersion] = createSignal(0);
  const surfaceTier = createMemo<TerminalSurfaceTier>(() => {
    surfaceTierVersion();
    const registeredTier = getTerminalSurfaceTier(terminalStartupKey);
    if (registeredTier !== 'cold-hidden' || !shouldPinSelectedSurfaceTier()) {
      return registeredTier;
    }

    return shouldUseInteractiveSurfaceTier() ? 'interactive-live' : 'handoff-live';
  });
  const isCurrentTerminalSwitchTarget = createMemo(() => {
    switchWindowVersion();
    return isTerminalSwitchTarget(taskId, switchWindowOwnerId);
  });
  const attachPriority = createMemo(() => {
    if (props.isFocused === true) {
      return 0;
    }

    if (isActiveCommandTarget()) {
      return 1;
    }

    if (isVisible()) {
      return 2;
    }

    return 3;
  });
  const outputPriority = createMemo(() =>
    getTerminalOutputPriority({
      isActiveTask: isActiveCommandTarget(),
      isFocused: props.isFocused === true,
      isRestoring: isRestoringTerminalStatus(sessionStatus()),
      isSwitchTarget: isCurrentTerminalSwitchTarget(),
      isVisible: isVisible(),
    }),
  );
  const controlVisualState = createTaskControlVisualState({
    fallbackAction: 'type in the terminal',
    isActive: () => props.isFocused === true,
    taskId,
  });
  const hasPeerController = createMemo(() => Boolean(controlVisualState.status()));
  const terminalAnomalySnapshot = createMemo(() => {
    anomalyMonitorVersion();
    return getTerminalAnomalyTerminalSnapshot(terminalStartupKey);
  });
  const terminalAnomalyPresentation = createMemo(() =>
    getTerminalAnomalyPresentation(terminalAnomalySnapshot()?.anomalies ?? []),
  );

  function bumpAnomalyMonitorVersion(): void {
    setAnomalyMonitorVersion((version) => version + 1);
  }

  function isActiveCommandTarget(): boolean {
    return store.activeTaskId === props.taskId && props.isCommandTarget !== false;
  }

  function getCurrentTerminalAnomalyLifecycleState(): TerminalAnomalyLifecycleState {
    return {
      cursorBlink: shouldBlinkTerminalCursor(),
      hasPeerController: hasPeerController(),
      isFocused: isTerminalFocused(),
      isSelected: isActiveCommandTarget(),
      isVisible: isVisible(),
      liveRenderReady: isLiveRenderReady(),
      presentationMode: presentationMode().kind,
      renderHibernating: renderHibernating(),
      restoreBlocked: restoreBlocked(),
      sessionDormant: sessionDormant(),
      status: sessionStatus(),
      surfaceTier: surfaceTier(),
    };
  }

  async function handleTakeOver(): Promise<void> {
    const currentSession = session;
    if (!currentSession || takingOver()) {
      return;
    }

    const generation = ++takeOverGeneration;
    setTakingOver(true);
    try {
      const acquired = await currentSession.requestInputTakeover();
      if (!acquired || generation !== takeOverGeneration || session !== currentSession) {
        return;
      }

      setTaskFocusedPanelState(taskId, 'ai-terminal');
      syncFocusedTypingTaskCommandLease(taskId, 'ai-terminal');
      void loadTaskCommandControllers();
      currentSession.term.focus();
    } finally {
      if (generation === takeOverGeneration) {
        setTakingOver(false);
      }
    }
  }

  function clearSessionDormancyTimer(): void {
    if (sessionDormancyTimer === undefined) {
      return;
    }

    window.clearTimeout(sessionDormancyTimer);
    sessionDormancyTimer = undefined;
  }

  function clearPendingSwitchWindowCompletion(): void {
    switchWindowCompletionPending = false;
    clearScheduledSwitchWindowCompletion(switchWindowCompletionRaf);
    switchWindowCompletionRaf = undefined;
  }

  function clearPendingSwitchWindowFirstPaint(): void {
    clearScheduledSwitchWindowCompletion(switchWindowFirstPaintRaf);
    switchWindowFirstPaintRaf = undefined;
  }

  function bumpSurfaceTierVersion(): void {
    setSurfaceTierVersion((version) => version + 1);
  }

  function bumpSwitchWindowVersion(): void {
    setSwitchWindowVersion((version) => version + 1);
    bumpSurfaceTierVersion();
  }

  function cancelSwitchWindowState(): void {
    clearPendingSwitchWindowFirstPaint();
    clearPendingSwitchWindowCompletion();
    if (!managesTaskSwitchWindowLifecycle) {
      return;
    }

    cancelTerminalSwitchEchoGrace(taskId);
    cancelTerminalSwitchWindow(taskId, switchWindowOwnerId);
  }

  function startSwitchWindowForSelection(): void {
    if (!shouldManageTaskSwitchWindow()) {
      return;
    }

    const experimentConfig = getTerminalPerformanceExperimentConfig();
    const switchTargetWindowMs =
      getTerminalExperimentSwitchTargetWindowMs(getVisibleTerminalCount());
    switchWindowCompletionPending = switchTargetWindowMs > 0;
    beginTerminalSwitchWindow(
      taskId,
      switchTargetWindowMs,
      experimentConfig.switchWindowSettleDelayMs,
      switchWindowOwnerId,
      getSwitchWindowOwnerPriority(),
    );
  }

  function beginSwitchWindowEchoGraceIfNeeded(): void {
    const switchPostInputReadyEchoGraceMs = getSwitchPostInputReadyEchoGraceMs();
    if (switchPostInputReadyEchoGraceMs <= 0) {
      return;
    }

    beginTerminalSwitchEchoGrace(taskId, switchPostInputReadyEchoGraceMs);
  }

  function markSwitchWindowInputReady(): void {
    if (!ownsTaskSwitchWindow()) {
      return;
    }

    markTerminalSwitchWindowFirstPaint(taskId, switchWindowOwnerId);
    switchWindowCompletionPending = false;
    markTerminalSwitchWindowInputReady(taskId, switchWindowOwnerId);
    beginSwitchWindowEchoGraceIfNeeded();
  }

  function shouldReportTaskOwnedSwitchWindowCompletion(): boolean {
    if (managesTaskSwitchWindowLifecycle) {
      return switchWindowCompletionPending;
    }

    return isCurrentTerminalSwitchTarget() && isVisible() && isActiveCommandTarget();
  }

  function isTerminalPaintReady(status: TerminalViewStatus): boolean {
    return (
      status === 'ready' &&
      isVisible() &&
      presentationMode().kind === 'live' &&
      !renderHibernating() &&
      !restoreBlocked() &&
      paintReady()
    );
  }

  function isSelectedVisibleSwitchTarget(): boolean {
    return isSelectedSwitchTargetTerminal() && isVisible();
  }

  function isSelectedSwitchTargetTerminal(): boolean {
    return isActiveCommandTarget() && isCurrentTerminalSwitchTarget();
  }

  function canCompleteSwitchWindowForStatus(status: TerminalViewStatus): boolean {
    if (!shouldReportTaskOwnedSwitchWindowCompletion() || !ownsTaskSwitchWindow()) {
      return false;
    }

    if (status === 'ready') {
      if (!isSelectedSwitchTargetTerminal() || !isTerminalPaintReady(status)) {
        return false;
      }
    } else if (status !== 'error' || !isSelectedVisibleSwitchTarget()) {
      return false;
    }

    if (renderHibernating()) {
      return false;
    }

    if (restoreBlocked()) {
      return false;
    }

    if (isTerminalSwitchWindowTargetRecoveryActive(taskId)) {
      return false;
    }

    return true;
  }

  function getHiddenTerminalSessionDormancyDelayMs(): number | null {
    if (props.isShell === true) {
      return null;
    }

    return getTerminalPerformanceExperimentConfig().hiddenTerminalSessionDormancyDelayMs;
  }

  function shouldKeepTerminalSessionLive(): boolean {
    return surfaceTier() !== 'cold-hidden';
  }

  function shouldKeepTerminalRenderLive(): boolean {
    switch (surfaceTier()) {
      case 'cold-hidden':
      case 'hot-hidden-live':
        return false;
      case 'passive-visible':
      case 'handoff-live':
      case 'interactive-live':
        return true;
    }
  }

  function shouldKeepTerminalGeometryLive(): boolean {
    return (
      (isFocusedNow || isVisibleNow) &&
      sessionStatus() === 'ready' &&
      presentationMode().kind === 'live' &&
      !renderHibernating() &&
      !restoreBlocked() &&
      !isPanelResizeDragging()
    );
  }

  function syncDomFocusWithin(): void {
    setDomFocusWithin(isTerminalDomFocused(shellRef));
  }

  function queueDomFocusWithinSync(): void {
    queueMicrotask(() => {
      syncDomFocusWithin();
    });
  }

  function bumpDocumentFocusVersion(): void {
    setDocumentFocusVersion((version) => version + 1);
  }

  function isTerminalFocused(): boolean {
    return props.isFocused === true || domFocusWithin();
  }

  function shouldRestoreTerminalFocusAfterRecovery(
    status: TerminalViewStatus,
    mode: TerminalPresentationMode['kind'],
  ): boolean {
    if (!pendingRecoveryFocusRestore || status !== 'ready' || mode !== 'live') {
      return false;
    }

    if (
      renderHibernating() ||
      !isTerminalPaintReady(status) ||
      !session ||
      !hasDocumentFocus() ||
      store.sidebarFocused ||
      store.placeholderFocused ||
      hasBlockingDialogOpen()
    ) {
      return false;
    }

    return !isTerminalDomFocused(shellRef);
  }

  function shouldBlinkTerminalCursor(): boolean {
    return (
      isTerminalFocused() &&
      isActiveCommandTarget() &&
      sessionStatus() === 'ready' &&
      presentationMode().kind === 'live' &&
      !hasPeerController() &&
      !renderHibernating() &&
      !restoreBlocked() &&
      !resizeTransactionActive()
    );
  }

  function isSelectedTerminalInteractive(): boolean {
    return (
      isActiveCommandTarget() &&
      isVisible() &&
      sessionStatus() === 'ready' &&
      isPaintSettledReady() &&
      !restoreBlocked() &&
      !resizeTransactionActive() &&
      shouldBlinkTerminalCursor()
    );
  }

  function canAcceptTerminalInput(): boolean {
    if (!isActiveCommandTarget() || hasPeerController() || resizeTransactionActive()) {
      return false;
    }

    const status = sessionStatus();
    switch (status) {
      case 'attaching':
      case 'ready':
      case 'restoring':
        return true;
      case 'binding':
      case 'error':
        return false;
      default:
        return assertNever(status, 'Unhandled terminal input acceptance status');
    }
  }

  function getSwitchWindowOwnerPriority(): number {
    if (props.isFocused === true) {
      return 2;
    }

    if (isVisible()) {
      return 1;
    }

    return 0;
  }

  function shouldManageTaskSwitchWindow(): boolean {
    return managesTaskSwitchWindowLifecycle && isActiveCommandTarget();
  }

  function ownsTaskSwitchWindow(): boolean {
    return isTerminalSwitchWindowOwner(taskId, switchWindowOwnerId);
  }

  function shouldPinSelectedSurfaceTier(): boolean {
    return isActiveCommandTarget() && (props.isFocused === true || props.isCommandTarget === true);
  }

  function shouldUseInteractiveSurfaceTier(): boolean {
    return props.isFocused === true || (props.isCommandTarget === true && isActiveCommandTarget());
  }

  function focusLiveCommandTargetFromPointer(): void {
    if (
      !session ||
      !isActiveCommandTarget() ||
      hasPeerController() ||
      presentationMode().kind !== 'live'
    ) {
      return;
    }

    session.term.focus();
  }

  function getCommandTargetAttribute(): 'default' | 'false' | 'true' {
    if (props.isCommandTarget === true) {
      return 'true';
    }

    if (props.isCommandTarget === false) {
      return 'false';
    }

    return 'default';
  }

  function syncTerminalSurfaceRegistrations(): void {
    isFocusedNow = props.isFocused === true;
    isVisibleNow = isVisible();
    isSelectedNow = isActiveCommandTarget();
    terminalVisibilityRegistration?.update({
      isFocused: isFocusedNow,
      isSelected: isSelectedNow,
      isVisible: isVisibleNow,
    });
    terminalSurfaceTierRegistration?.update({
      isFocused: shouldUseInteractiveSurfaceTier(),
      isSelected: shouldPinSelectedSurfaceTier(),
      isVisible: isVisibleNow,
    });
  }

  function getRenderHibernationDelayMs(): number | null {
    switch (surfaceTier()) {
      case 'cold-hidden':
      case 'hot-hidden-live':
        return getTerminalPerformanceExperimentConfig().hiddenTerminalHibernationDelayMs;
      case 'passive-visible':
        return null;
      case 'handoff-live':
      case 'interactive-live':
        return null;
    }
  }

  function armTerminalWakePrewarm(): void {
    armFocusedTerminalOutputPreemption();
  }

  function syncCurrentSessionRuntimeState(): void {
    if (!session) {
      return;
    }

    session.term.options.disableStdin = !canAcceptTerminalInput();
    session.term.options.cursorBlink = shouldBlinkTerminalCursor();
    session.updateOutputPriority?.();
  }

  function getSwitchPostInputReadyEchoGraceMs(): number {
    return getTerminalExperimentSwitchPostInputReadyEchoGraceMs(getVisibleTerminalCount());
  }

  function getTerminalStartupPaintRole(): 'hidden' | 'selected' | 'visible-sibling' {
    if (isActiveCommandTarget() && isVisible()) {
      return 'selected';
    }

    if (!isVisible()) {
      return 'hidden';
    }

    return 'visible-sibling';
  }

  function syncTerminalStartupPaintCoordination(): void {
    setTerminalStartupPaintCoordinationEntry(
      terminalStartupKey,
      {
        paintReady: isTerminalPaintReady(sessionStatus()),
        role: getTerminalStartupPaintRole(),
        taskId,
      },
      terminalInstanceId,
    );
  }

  function isStartupPaintAttributionActive(): boolean {
    return (
      isRendererRuntimeDiagnosticsEnabled() &&
      sessionStartupMeasurementStartedAtMs !== null &&
      activeSessionStartupMeasurementGeneration !== 0 &&
      lastPaintReadyMeasurementGeneration !== activeSessionStartupMeasurementGeneration
    );
  }

  function withStartupPaintAttribution(
    callback: (role: ReturnType<typeof getTerminalStartupPaintRole>) => void,
  ): void {
    if (!isStartupPaintAttributionActive()) {
      return;
    }

    callback(getTerminalStartupPaintRole());
  }

  function recordStartupRenderEventIfPending(): void {
    withStartupPaintAttribution((role) => {
      recordTerminalStartupRenderEvent(role);
    });
  }

  function recordStartupWriteIfPending(byteLength: number): void {
    if (byteLength <= 0) {
      return;
    }

    withStartupPaintAttribution((role) => {
      recordTerminalStartupWrite(role, byteLength);
    });
  }

  function recordStartupFitScheduleIfPending(
    reason: Parameters<typeof recordTerminalStartupFitSchedule>[1],
  ): void {
    withStartupPaintAttribution((role) => {
      recordTerminalStartupFitSchedule(role, reason);
    });
  }

  function recordStartupFitExecutionIfPending(
    details: Parameters<typeof recordTerminalStartupFitExecution>[1],
  ): void {
    withStartupPaintAttribution((role) => {
      recordTerminalStartupFitExecution(role, details);
    });
  }

  function beginStartupMeasurement(): void {
    sessionStartupMeasurementGeneration += 1;
    activeSessionStartupMeasurementGeneration = sessionStartupMeasurementGeneration;
    sessionStartupMeasurementStartedAtMs = performance.now();
    lastLogicalReadyMeasurementGeneration = 0;
    lastPaintReadyMeasurementGeneration = 0;
    lastLogicalReadyDurationMs = null;
    lastLogicalReadyDurationGeneration = 0;
  }

  function recordLogicalReadyMeasurementIfPending(): void {
    if (
      sessionStatus() !== 'ready' ||
      sessionStartupMeasurementStartedAtMs === null ||
      activeSessionStartupMeasurementGeneration === 0 ||
      lastLogicalReadyMeasurementGeneration === activeSessionStartupMeasurementGeneration
    ) {
      return;
    }

    const logicalReadyDurationMs =
      getRoundedPerformanceNow() - sessionStartupMeasurementStartedAtMs;
    lastLogicalReadyMeasurementGeneration = activeSessionStartupMeasurementGeneration;
    lastLogicalReadyDurationGeneration = activeSessionStartupMeasurementGeneration;
    lastLogicalReadyDurationMs = logicalReadyDurationMs;
    recordTerminalStartupLogicalReady(getTerminalStartupPaintRole(), logicalReadyDurationMs);
  }

  function recordPaintReadyMeasurementIfPending(): void {
    if (
      !isPaintSettledReady() ||
      sessionStartupMeasurementStartedAtMs === null ||
      activeSessionStartupMeasurementGeneration === 0 ||
      lastPaintReadyMeasurementGeneration === activeSessionStartupMeasurementGeneration
    ) {
      return;
    }

    const paintReadyDurationMs = getRoundedPerformanceNow() - sessionStartupMeasurementStartedAtMs;
    lastPaintReadyMeasurementGeneration = activeSessionStartupMeasurementGeneration;
    const role = getTerminalStartupPaintRole();
    recordTerminalStartupPaintReady(role, paintReadyDurationMs);
    if (
      lastLogicalReadyDurationGeneration === activeSessionStartupMeasurementGeneration &&
      lastLogicalReadyDurationMs !== null
    ) {
      recordTerminalStartupLogicalToPaintReadyDelay(
        role,
        Math.max(0, paintReadyDurationMs - lastLogicalReadyDurationMs),
      );
    }
  }

  function prewarmHiddenTerminalIfNeeded(): void {
    terminalSurfaceTierRegistration?.noteIntent();
    armTerminalWakePrewarm();
    if (isFocusedNow || isVisibleNow || isSelectedNow) {
      return;
    }

    const isSessionDormant = untrack(sessionDormant);
    if (isSessionDormant || (!session && !attachRegistration)) {
      ensureTerminalSessionRegistered();
      return;
    }

    session?.prewarmRenderHibernation?.();
  }

  function cleanupTerminalSessionLifetime(): void {
    sessionStartGeneration += 1;
    takeOverGeneration += 1;
    terminalAttachInProgress = false;
    terminalAttachQueued = false;
    terminalAttachUnregisterPending = false;
    terminalSessionLoadFailed = false;
    selectedInteractiveBreadcrumbEmitted = false;
    setTakingOver(false);
    setRenderHibernating(false);
    setRestoreBlocked(false);
    setResizeTransactionActive(false);
    session?.cleanup();
    session = undefined;
    setSessionVersion((version) => version + 1);
    attachRegistration?.unregister();
    attachRegistration = undefined;
  }

  function acceptStartedTerminalSession(generation: number, nextSession: TerminalSession): void {
    if (generation !== sessionStartGeneration) {
      nextSession.cleanup();
      return;
    }

    terminalAttachInProgress = false;
    session = nextSession;
    setSessionVersion((version) => version + 1);
    syncCurrentSessionRuntimeState();
  }

  function handleTerminalSessionLoadFailure(generation: number, error: unknown): void {
    if (generation !== sessionStartGeneration) {
      return;
    }

    terminalAttachInProgress = false;
    console.warn('Failed to load terminal runtime:', error);
    terminalSessionLoadFailed = true;
    sessionStartedOnce = false;
    if (attachRegistration) {
      attachRegistration.unregister();
      attachRegistration = undefined;
    } else {
      terminalAttachUnregisterPending = true;
    }
    setSessionStatus('error');
  }

  function retryTerminalSessionLoadAfterPriorityChange(): void {
    if (!terminalSessionLoadFailed) {
      return;
    }

    terminalSessionLoadFailed = false;
    setSessionStatus('binding');
    ensureTerminalSessionRegistered();
  }

  function handleSessionStatusChange(status: TerminalViewStatus): void {
    setSessionStatus(status);
    syncCurrentSessionRuntimeState();
  }

  function handleSessionPaintReadyChange(nextPaintReady: boolean): void {
    setPaintReady(nextPaintReady);
    syncCurrentSessionRuntimeState();
  }

  function handleSessionRenderHibernationChange(isHibernating: boolean): void {
    setRenderHibernating(isHibernating);
    syncCurrentSessionRuntimeState();
  }

  function handleSessionRestoreBlockedChange(isBlocked: boolean): void {
    setRestoreBlocked(isBlocked);
    syncCurrentSessionRuntimeState();
  }

  function handleSessionResizeTransactionChange(isActive: boolean): void {
    setResizeTransactionActive(isActive);
    syncCurrentSessionRuntimeState();
  }

  function enterSessionDormancy(): void {
    if (sessionDormant()) {
      return;
    }

    cleanupTerminalSessionLifetime();
    setSessionDormant(true);
    setSessionStatus('binding');
  }

  function ensureTerminalSessionRegistered(): void {
    setSessionDormant(false);
    if (terminalSessionLoadFailed || session) {
      return;
    }

    if (attachRegistration && !terminalAttachQueued && !terminalAttachInProgress) {
      attachRegistration.unregister();
      attachRegistration = undefined;
    }

    if (attachRegistration) {
      return;
    }

    selectedInteractiveBreadcrumbEmitted = false;
    beginTerminalAttachTraceEntry(terminalStartupKey, taskId, agentId);
    terminalAttachQueued = true;
    const nextAttachRegistration = registerTerminalAttachCandidate({
      attach: () => {
        terminalAttachQueued = false;
        terminalAttachInProgress = true;
        const generation = ++sessionStartGeneration;
        updateTerminalAttachTrace(terminalStartupKey, (entry) => {
          entry.attachStartedAtMs = getRoundedPerformanceNow();
          entry.status = 'binding';
        });
        sessionStartedOnce = true;
        beginStartupMeasurement();
        let startedSession: TerminalSession | Promise<TerminalSession>;
        try {
          startedSession = startLoadedTerminalSession({
            canAcceptInput: canAcceptTerminalInput,
            containerRef,
            getOutputPriority: outputPriority,
            getStartupPaintRole: getTerminalStartupPaintRole,
            getRenderHibernationDelayMs,
            getStartupPaintCoordinationSnapshot: getGlobalTerminalStartupPaintCoordinationSnapshot,
            isSelectedRecoveryProtected: isSelectedSwitchTargetTerminal,
            onAttachBound: () => {
              updateTerminalAttachTrace(terminalStartupKey, (entry) => {
                entry.attachBoundAtMs = getRoundedPerformanceNow();
              });
              attachRegistration?.release();
            },
            onAttachMilestone: (milestone) => {
              recordTerminalAttachMilestone(terminalStartupKey, milestone);
            },
            onBlockedInputAttempt: () => {
              recordTerminalPresentationBlockedInput(presentationMode().kind);
              anomalyMonitorRegistration?.recordInteraction('blocked-input');
            },
            onPaintReadyChange: handleSessionPaintReadyChange,
            onStartupFitExecuted: recordStartupFitExecutionIfPending,
            onStartupFitScheduled: recordStartupFitScheduleIfPending,
            onStartupRenderEvent: recordStartupRenderEventIfPending,
            onStartupWriteRendered: recordStartupWriteIfPending,
            onRenderHibernationChange: handleSessionRenderHibernationChange,
            onReadOnlyInputAttempt: () => {
              anomalyMonitorRegistration?.recordInteraction('read-only-input');
              controlVisualState.expandBanner();
            },
            onRestoreBlockedChange: handleSessionRestoreBlockedChange,
            onResizeTransactionChange: handleSessionResizeTransactionChange,
            onSelectedRecoverySettle: () => {
              markTerminalSwitchWindowRecoverySettled(taskId, switchWindowOwnerId);
              requestTerminalOutputDrain();
            },
            onSelectedRecoveryStart: () => {
              markTerminalSwitchWindowRecoveryStarted(taskId, switchWindowOwnerId);
            },
            onShouldKeepRenderLive: shouldKeepTerminalRenderLive,
            onStatusChange: handleSessionStatusChange,
            props,
            subscribeStartupPaintCoordinationChanges:
              subscribeTerminalStartupPaintCoordinationChanges,
            shouldCommitResize: shouldKeepTerminalGeometryLive,
          });
        } catch (error) {
          handleTerminalSessionLoadFailure(generation, error);
          return;
        }

        if (startedSession instanceof Promise) {
          void startedSession
            .then((nextSession) => {
              untrack(() => {
                acceptStartedTerminalSession(generation, nextSession);
              });
            })
            .catch((error: unknown) => {
              handleTerminalSessionLoadFailure(generation, error);
            });
          return;
        }

        acceptStartedTerminalSession(generation, startedSession);
      },
      getPriority: attachPriority,
      key: terminalStartupKey,
      ownerId: terminalInstanceId,
      taskId,
    });
    attachRegistration = nextAttachRegistration;
    if (terminalAttachUnregisterPending) {
      terminalAttachUnregisterPending = false;
      nextAttachRegistration.unregister();
      if (attachRegistration === nextAttachRegistration) {
        attachRegistration = undefined;
      }
    }
  }

  function syncTerminalSessionLiveness(): void {
    const hiddenTerminalSessionDormancyDelayMs = getHiddenTerminalSessionDormancyDelayMs();

    if (terminalSessionLoadFailed) {
      clearSessionDormancyTimer();
      return;
    }

    if (props.isShell === true && !sessionStartedOnce && !shouldKeepTerminalSessionLive()) {
      clearSessionDormancyTimer();
      setSessionDormant(true);
      setSessionStatus('binding');
      return;
    }

    if (!sessionStartedOnce) {
      clearSessionDormancyTimer();
      if (shouldKeepTerminalSessionLive() || props.isShell !== true) {
        ensureTerminalSessionRegistered();
      } else {
        setSessionDormant(true);
        setSessionStatus('binding');
      }
      return;
    }

    if (hiddenTerminalSessionDormancyDelayMs === null) {
      clearSessionDormancyTimer();
      ensureTerminalSessionRegistered();
      return;
    }

    if (shouldKeepTerminalSessionLive()) {
      clearSessionDormancyTimer();
      ensureTerminalSessionRegistered();
      return;
    }

    if (!session && !attachRegistration) {
      setSessionDormant(true);
      setSessionStatus('binding');
      return;
    }

    if (sessionDormancyTimer !== undefined) {
      return;
    }

    // eslint-disable-next-line solid/reactivity
    sessionDormancyTimer = window.setTimeout(() => {
      sessionDormancyTimer = undefined;
      if (shouldKeepTerminalSessionLive()) {
        return;
      }

      enterSessionDormancy();
    }, hiddenTerminalSessionDormancyDelayMs);
  }

  onMount(() => {
    let observer: IntersectionObserver | undefined;
    const handleDocumentFocusIn = (): void => {
      if (isTerminalDomFocused(shellRef)) {
        setDomFocusWithin(true);
        return;
      }

      queueDomFocusWithinSync();
    };
    const handleDocumentFocusOut = (): void => {
      queueDomFocusWithinSync();
    };
    const handleWindowBlur = (): void => {
      setDomFocusWithin(false);
      bumpDocumentFocusVersion();
    };
    const handleWindowFocus = (): void => {
      bumpDocumentFocusVersion();
      queueDomFocusWithinSync();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        setDomFocusWithin(false);
        bumpDocumentFocusVersion();
        return;
      }

      bumpDocumentFocusVersion();
      queueDomFocusWithinSync();
    };
    surfaceTierCleanup = subscribeTerminalSurfaceTierChanges(bumpSurfaceTierVersion);
    denseOverloadCleanup = subscribeTerminalDenseOverloadChanges(bumpSurfaceTierVersion);
    recentHiddenReservationCleanup =
      subscribeTerminalRecentHiddenReservationChanges(bumpSurfaceTierVersion);
    terminalVisibilityRegistration = registerTerminalVisibility(terminalStartupKey, {
      isFocused: isFocusedNow,
      isSelected: isSelectedNow,
      isVisible: isVisibleNow,
    });
    terminalSurfaceTierRegistration = registerTerminalSurfaceTier(terminalStartupKey, {
      isFocused: shouldUseInteractiveSurfaceTier(),
      isSelected: shouldPinSelectedSurfaceTier(),
      isVisible: isVisibleNow,
    });
    syncTerminalSurfaceRegistrations();
    queueMicrotask(syncTerminalSurfaceRegistrations);
    prewarmCleanup = subscribeTerminalPrewarm(taskId, () => {
      prewarmHiddenTerminalIfNeeded();
    });
    anomalyMonitorRegistration = registerTerminalAnomalyMonitorTerminal({
      agentId,
      key: terminalStartupKey,
      taskId,
    });
    anomalyMonitorRegistration.updateLifecycle(untrack(getCurrentTerminalAnomalyLifecycleState));
    anomalyMonitorCleanup = subscribeTerminalAnomalyMonitorChanges(bumpAnomalyMonitorVersion);
    const switchWindowCleanup = subscribeTerminalSwitchWindowChanges(bumpSwitchWindowVersion);
    const initialVisibility = isInitiallyFocused || isElementVisibleInViewport(shellRef);
    setIsVisible(initialVisibility);
    syncDomFocusWithin();
    document.addEventListener('focusin', handleDocumentFocusIn, true);
    document.addEventListener('focusout', handleDocumentFocusOut, true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    if (isActiveCommandTarget() && initialVisibility) {
      startSwitchWindowForSelection();
    }

    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          setIsVisible(entries.some((entry) => entry.isIntersecting));
        },
        { threshold: 0.1 },
      );
      observer.observe(shellRef);
    } else {
      setIsVisible(true);
    }
    syncTerminalSessionLiveness();

    onCleanup(() => {
      document.removeEventListener('focusin', handleDocumentFocusIn, true);
      document.removeEventListener('focusout', handleDocumentFocusOut, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
      observer?.disconnect();
      clearSessionDormancyTimer();
      cleanupTerminalSessionLifetime();
      cancelSwitchWindowState();
      clearTerminalStartupPaintCoordinationEntry(terminalStartupKey, terminalInstanceId);
      terminalVisibilityRegistration?.unregister();
      terminalVisibilityRegistration = undefined;
      terminalSurfaceTierRegistration?.unregister();
      terminalSurfaceTierRegistration = undefined;
      prewarmCleanup?.();
      prewarmCleanup = undefined;
      anomalyMonitorCleanup?.();
      anomalyMonitorCleanup = undefined;
      anomalyMonitorRegistration?.unregister();
      anomalyMonitorRegistration = undefined;
      surfaceTierCleanup?.();
      surfaceTierCleanup = undefined;
      denseOverloadCleanup?.();
      denseOverloadCleanup = undefined;
      recentHiddenReservationCleanup?.();
      recentHiddenReservationCleanup = undefined;
      switchWindowCleanup();
      clearTerminalRecentHiddenCandidate(terminalStartupKey);
    });
  });

  const presentationMode = createMemo<TerminalPresentationMode>(() => {
    const status = sessionStatus();

    const nextLoadingLabel = getTerminalLoadingLabel(status);
    if (nextLoadingLabel !== null) {
      return {
        kind: 'loading',
        label: nextLoadingLabel,
      };
    }

    if (status === 'error') {
      return { kind: 'error' };
    }

    return { kind: 'live' };
  });
  const loadingPresentationMode = createMemo(() => getLoadingPresentationMode(presentationMode()));
  const loadingLabel = createMemo(() => {
    return loadingPresentationMode()?.label ?? null;
  });
  const readOnlyBorder = createMemo(() => theme.warning ?? '#d4a017');
  const isLiveRenderReady = createMemo(() => {
    return (
      sessionStatus() === 'ready' &&
      presentationMode().kind === 'live' &&
      (props.isFocused === true || isVisible())
    );
  });
  const isPaintSettledReady = createMemo(() => isTerminalPaintReady(sessionStatus()));
  const shouldMaskLiveTerminalSurface = createMemo(() => {
    return shouldMaskTerminalPresentationMode(presentationMode());
  });

  createEffect(() => {
    sessionStatus();
    outputPriority();
    paintReady();
    presentationMode();
    renderHibernating();
    restoreBlocked();
    isVisible();
    syncTerminalStartupPaintCoordination();
  });

  createEffect(() => {
    const isFocused = props.isFocused === true;
    const isSelected = isActiveCommandTarget();
    const visibleNow = isVisible();
    const gainedFocusedPriority = isFocused && !previouslyFocused;
    const gainedTaskSelection = isSelected && !previouslySelected;
    const gainedVisibility = visibleNow && !previouslyVisible;
    const becameHidden = !isSelected && !visibleNow && (previouslySelected || previouslyVisible);

    previouslyFocused = isFocused;
    previouslySelected = isSelected;
    previouslyVisible = visibleNow;

    if (gainedTaskSelection) {
      clearTerminalRecentHiddenCandidate(terminalStartupKey);
      startSwitchWindowForSelection();
    }

    if (gainedFocusedPriority && isSelected) {
      startSwitchWindowForSelection();
    }

    if (!isSelected) {
      cancelSwitchWindowState();
    }

    if (becameHidden) {
      reserveTerminalRecentHiddenCandidate(terminalStartupKey, taskId);
    }

    if (gainedFocusedPriority || gainedTaskSelection || gainedVisibility) {
      clearTerminalRecentHiddenCandidate(terminalStartupKey);
      terminalSurfaceTierRegistration?.noteIntent();
      armTerminalWakePrewarm();
      retryTerminalSessionLoadAfterPriorityChange();
    }
  });

  createEffect(() => {
    const status = sessionStatus();
    switchWindowVersion();
    syncTerminalSurfaceRegistrations();
    void status;
    syncTerminalSessionLiveness();
  });

  createRenderEffect(() => {
    sessionVersion();
    const geometryLive = shouldKeepTerminalGeometryLive();
    if (!geometryLive) {
      return;
    }

    session?.flushPendingResize();
  });

  createEffect(() => {
    attachPriority();
    attachRegistration?.updatePriority();
  });

  createRenderEffect(() => {
    sessionVersion();
    outputPriority();
    surfaceTier();
    session?.updateOutputPriority?.();
  });

  createEffect(() => {
    const status = sessionStatus();
    switchWindowVersion();

    updateTerminalAttachTrace(terminalStartupKey, (entry) => {
      entry.status = status;
      if ((status === 'ready' || status === 'error') && entry.readyAtMs === null) {
        entry.readyAtMs = getRoundedPerformanceNow();
      }
    });

    syncTerminalStartupPhaseForStatus(terminalStartupKey, status, terminalInstanceId);

    if (canCompleteSwitchWindowForStatus(status)) {
      if (switchWindowCompletionRaf !== undefined) {
        return;
      }

      switchWindowCompletionRaf = requestAnimationFrame(() => {
        switchWindowCompletionRaf = undefined;
        if (canCompleteSwitchWindowForStatus(sessionStatus())) {
          markSwitchWindowInputReady();
        }
      });
    }
  });

  createEffect(() => {
    sessionStatus();
    recordLogicalReadyMeasurementIfPending();
  });

  createEffect(() => {
    const paintSettledReady = isPaintSettledReady();
    recordPaintReadyMeasurementIfPending();
    if (paintSettledReady) {
      updateTerminalAttachTrace(terminalStartupKey, (entry) => {
        if (entry.paintReadyAtMs === null) {
          entry.paintReadyAtMs = getRoundedPerformanceNow();
        }
      });
    }
    if (paintSettledReady && getTerminalStartupPaintRole() === 'selected') {
      markBrowserStartupSelectedTerminalReady();
      notifyTerminalAttachPolicyChanged();
    }
  });

  createEffect(() => {
    if (selectedInteractiveBreadcrumbEmitted || !isSelectedTerminalInteractive()) {
      return;
    }

    selectedInteractiveBreadcrumbEmitted = true;
    updateTerminalAttachTrace(terminalStartupKey, (entry) => {
      if (entry.selectedInteractiveAtMs === null) {
        entry.selectedInteractiveAtMs = getRoundedPerformanceNow();
      }
    });
    emitStartupBreadcrumb('terminal:selected-interactive');
  });

  createEffect(() => {
    const status = sessionStatus();
    switchWindowVersion();

    if (
      !ownsTaskSwitchWindow() ||
      !isSelectedSwitchTargetTerminal() ||
      !isTerminalPaintReady(status)
    ) {
      clearPendingSwitchWindowFirstPaint();
      return;
    }

    if (switchWindowFirstPaintRaf !== undefined) {
      return;
    }

    switchWindowFirstPaintRaf = requestAnimationFrame(() => {
      switchWindowFirstPaintRaf = undefined;
      if (
        ownsTaskSwitchWindow() &&
        isSelectedSwitchTargetTerminal() &&
        isTerminalPaintReady(sessionStatus())
      ) {
        markTerminalSwitchWindowFirstPaint(taskId, switchWindowOwnerId);
      }
    });
  });

  createEffect(() => {
    if (sessionStatus() === 'error') {
      attachRegistration?.release();
    }
  });

  createRenderEffect(() => {
    sessionVersion();
    const size = props.fontSize;
    if (size === undefined || size === null || !session) return;
    session.term.options.fontSize = size;
    markDirty(agentId, 'font-size');
  });

  createRenderEffect(() => {
    sessionVersion();
    const font = store.terminalFont;
    if (!session) return;
    session.term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(agentId, 'font-family');
  });

  createRenderEffect(() => {
    sessionVersion();
    const preset = store.themePreset;
    if (!session) return;
    session.term.options.theme = getTerminalTheme(preset);
    markDirty(agentId, 'theme');
  });

  createRenderEffect(() => {
    sessionVersion();
    const focused = props.isFocused === true;
    const masked = shouldMaskLiveTerminalSurface();
    const hibernating = renderHibernating();
    const blocked = restoreBlocked();
    const resizing = resizeTransactionActive();
    const priority = outputPriority();
    const status = sessionStatus();
    void focused;
    void masked;
    void hibernating;
    void blocked;
    void resizing;
    void priority;
    void status;
    if (!session) return;
    syncCurrentSessionRuntimeState();
  });

  createRenderEffect(() => {
    sessionVersion();
    const focused = props.isFocused === true;
    const status = sessionStatus();
    const blocked = restoreBlocked();
    const mode = presentationMode().kind;
    const hibernating = renderHibernating();
    const paintSettledReady = isPaintSettledReady();
    const focusVersion = documentFocusVersion();
    const domFocused = domFocusWithin();
    void paintSettledReady;
    void focusVersion;
    void domFocused;

    if (!focused) {
      pendingRecoveryFocusRestore = false;
      return;
    }

    if (status === 'attaching' || status === 'restoring' || blocked) {
      pendingRecoveryFocusRestore = true;
      return;
    }

    const activeSession = session;
    if (hibernating || !activeSession || !shouldRestoreTerminalFocusAfterRecovery(status, mode)) {
      return;
    }

    pendingRecoveryFocusRestore = false;
    activeSession.term.focus();
  });

  createRenderEffect(() => {
    sessionVersion();
    const shouldMaskSurface = shouldMaskLiveTerminalSurface();
    if (!session || !shouldMaskSurface) {
      return;
    }

    session.term.blur?.();
  });

  createEffect(() => {
    const mode = presentationMode().kind;
    if (lastRecordedPresentationMode === mode) {
      return;
    }

    lastRecordedPresentationMode = mode;
    recordTerminalPresentationTransition(mode);
  });

  createEffect(() => {
    surfaceTier();
    switchWindowVersion();
    const status = sessionStatus();
    const visible = isVisible();
    const dormant = sessionDormant();
    const hibernating = renderHibernating();
    const blocked = restoreBlocked();
    const resizing = resizeTransactionActive();
    const peerControlled = hasPeerController();
    const liveReady = isLiveRenderReady();
    const paintSettledReady = isPaintSettledReady();
    const mode = presentationMode().kind;
    void status;
    void visible;
    void dormant;
    void hibernating;
    void blocked;
    void resizing;
    void peerControlled;
    void liveReady;
    void paintSettledReady;
    void mode;
    anomalyMonitorRegistration?.updateLifecycle(getCurrentTerminalAnomalyLifecycleState());
  });

  return (
    <div
      ref={shellRef}
      data-terminal-agent-id={props.agentId}
      data-terminal-active-command-target={isActiveCommandTarget() ? 'true' : undefined}
      data-terminal-anomaly-count={
        terminalAnomalyPresentation().count > 0
          ? String(terminalAnomalyPresentation().count)
          : undefined
      }
      data-terminal-anomaly-kinds={terminalAnomalyPresentation().kinds ?? undefined}
      data-terminal-anomaly-severity={terminalAnomalyPresentation().severity ?? undefined}
      data-terminal-command-target={getCommandTargetAttribute()}
      data-terminal-cursor-blink={shouldBlinkTerminalCursor() ? 'true' : undefined}
      data-terminal-dormant={sessionDormant() ? 'true' : undefined}
      data-terminal-render-hibernating={renderHibernating() ? 'true' : undefined}
      data-terminal-restore-blocked={restoreBlocked() ? 'true' : undefined}
      data-terminal-live-render-ready={isLiveRenderReady() ? 'true' : undefined}
      data-terminal-paint-ready={isPaintSettledReady() ? 'true' : undefined}
      data-terminal-presentation-mode={presentationMode().kind}
      data-terminal-surface-tier={surfaceTier()}
      data-terminal-status={sessionStatus()}
      onMouseDown={focusLiveCommandTargetFromPointer}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        'border-radius': '12px',
        'box-shadow':
          !loadingLabel() && hasPeerController()
            ? `inset 0 0 0 1px color-mix(in srgb, ${readOnlyBorder()} 60%, ${theme.border})`
            : undefined,
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          padding: '4px 0 0 4px',
          contain: 'strict',
          opacity: shouldMaskLiveTerminalSurface() ? '0' : undefined,
          'pointer-events': shouldMaskLiveTerminalSurface() ? 'none' : undefined,
        }}
      />
      <Show when={loadingLabel()}>
        {(label) => (
          <div
            data-terminal-loading-overlay="true"
            onPointerDown={(event) => event.preventDefault()}
            style={{
              position: 'absolute',
              inset: '0',
              display: 'flex',
              'align-items': 'flex-start',
              'justify-content': 'flex-start',
              padding: '12px',
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--island-bg) 88%, rgb(12, 15, 20)), color-mix(in srgb, var(--island-bg) 80%, rgb(12, 15, 20)))',
              color: theme.fg,
              'pointer-events': 'auto',
            }}
          >
            <div
              data-terminal-loading-card="true"
              style={{
                display: 'grid',
                'grid-template-columns': '14px minmax(0, 1fr)',
                'align-items': 'center',
                gap: '10px',
                padding: '10px 14px',
                width: '32ch',
                'max-width': '100%',
                'min-height': '40px',
                background: 'color-mix(in srgb, var(--island-bg) 82%, transparent)',
                border: `1px solid ${theme.border}`,
                'border-radius': '12px',
                'box-shadow': '0 12px 30px rgba(0, 0, 0, 0.24)',
              }}
            >
              <span class="inline-spinner" aria-hidden="true" />
              <span
                data-terminal-loading-label="true"
                style={{
                  'font-family': getTerminalFontFamily(store.terminalFont),
                  'font-size': '12px',
                  color: theme.fgMuted,
                  'text-align': 'left',
                  'white-space': 'nowrap',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                }}
              >
                {label()}
              </span>
            </div>
          </div>
        )}
      </Show>
      <Show
        when={
          !loadingLabel() && !controlVisualState.isBannerVisible() && controlVisualState.status()
        }
      >
        {(status) => (
          <div
            style={{
              position: 'absolute',
              top: '8px',
              right: '8px',
              'z-index': '11',
            }}
          >
            <TaskControlChip
              busy={takingOver()}
              label={status().label}
              onTakeOver={() => {
                void handleTakeOver();
              }}
              takeOverLabel="Take Over"
            />
          </div>
        )}
      </Show>
      <Show
        when={
          !loadingLabel() && controlVisualState.isBannerVisible() && controlVisualState.status()
        }
      >
        {(status) => (
          <TaskControlBanner
            busy={takingOver()}
            message={status().message}
            onDismiss={controlVisualState.dismissBanner}
            onTakeOver={() => {
              void handleTakeOver();
            }}
            style={{
              position: 'absolute',
              top: '8px',
              left: '8px',
              right: '8px',
              'z-index': '12',
              background: 'color-mix(in srgb, var(--island-bg) 88%, rgba(18, 22, 28, 0.18))',
            }}
          />
        )}
      </Show>
      <Show when={isTerminalAnomalyMonitorEnabled() && terminalAnomalyPresentation().label}>
        {(label) => (
          <div
            data-terminal-anomaly-monitor="true"
            style={{
              position: 'absolute',
              left: '8px',
              bottom: '8px',
              'z-index': '12',
              padding: '6px 10px',
              'max-width': 'calc(100% - 16px)',
              background: 'color-mix(in srgb, var(--island-bg) 90%, rgba(10, 12, 16, 0.55))',
              border: `1px solid ${
                terminalAnomalyPresentation().severity === 'error'
                  ? (theme.error ?? '#ff6b6b')
                  : (theme.warning ?? '#d4a017')
              }`,
              'border-radius': '10px',
              'box-shadow': '0 10px 24px rgba(0, 0, 0, 0.28)',
              color: theme.fgMuted,
              'font-family': getTerminalFontFamily(store.terminalFont),
              'font-size': '11px',
              'line-height': '1.4',
              'pointer-events': 'none',
              'text-wrap': 'balance',
            }}
          >
            {label()}
          </div>
        )}
      </Show>
    </div>
  );
}

export type { TerminalViewProps } from './terminal-view/types';
