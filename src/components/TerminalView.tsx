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
import { getTerminalSearchDecorationTheme, getTerminalTheme, theme } from '../lib/theme';
import { markDirty } from '../lib/terminalFitManager';
import { assertNever } from '../lib/assert-never';
import {
  getTerminalExperimentInputAcknowledgementDurationMs,
  getTerminalExperimentInputAcknowledgementMode,
  getTerminalExperimentLocalInputFeedbackDurationMs,
  getTerminalExperimentLocalInputFeedbackModeOverride,
  getTerminalExperimentSwitchPostInputReadyEchoGraceMs,
  getTerminalExperimentSwitchTargetWindowMs,
  getTerminalPerformanceExperimentConfig,
  type TerminalLocalInputFeedbackMode,
} from '../lib/terminal-performance-experiments';
import {
  isRendererRuntimeDiagnosticsEnabled,
  recordTerminalLocalInputAckPulse,
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
import { nextCoordinatorActivityHintSeq, sendCoordinatorActivityHint } from '../app/coordinator';
import { getPanelResizeDragEpoch, isPanelResizeDragging } from '../app/panel-resize-drag';
import { setTaskFocusedPanelState, store } from '../store/store';
import { loadTaskCommandControllers } from '../store/task-command-controllers';
import { getTaskTerminalPlaceholderTail } from '../store/task-terminal-slate';
import { clearTerminalStartupEntry, setTerminalStartupPhase } from '../store/terminal-startup';
import {
  enqueuePendingSessionInput,
  getPendingSessionInputCount,
  takePendingSessionInput,
} from './terminal-view/terminal-pending-session-input';
import {
  clearTerminalStartupPaintCoordinationEntry,
  getGlobalTerminalStartupPaintCoordinationSnapshot,
  setTerminalStartupPaintCoordinationEntry,
  subscribeTerminalStartupPaintCoordinationChanges,
} from '../app/terminal-startup-paint';
import { TaskControlBanner } from './TaskControlBanner';
import { TaskControlChip } from './TaskControlChip';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { createTaskControlVisualState } from './task-control-visual-state';
import { ensureAgentSessionForDeferredTerminal } from '../app/agent-session-ensure';
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
  getTerminalRuntimeSurfaceAllocation,
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
import {
  getTerminalRestoreUnavailableMessage,
  type TerminalSessionAttachUnavailableReason,
  type TerminalPresentationMode,
  type TerminalViewProps,
  type TerminalViewStatus,
} from './terminal-view/types';
import { getTerminalOutputPriority } from '../lib/terminal-output-priority';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { TERMINAL_SEARCH_QUERY_LIMIT, type TerminalSearchResult } from '../lib/terminal-search';

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
const POST_RECOVERY_INPUT_CAPTURE_GRACE_MS = 750;
const EMPTY_TERMINAL_SEARCH_RESULT: TerminalSearchResult = { count: 0, index: -1 };

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
    store.showAddProjectDialog ||
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
  // Frozen browser-scorecard wire names. These measure the whole attach RPC,
  // which may restore or bind an existing process without spawning one.
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
      case 'attach-requested':
        entry.spawnRequestedAtMs = atMs;
        entry.status = 'spawning';
        return;
      case 'attach-resolved':
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
  let switchWindowEchoGraceAllowed = false;
  let surfaceTierCleanup: (() => void) | undefined;
  let anomalyMonitorCleanup: (() => void) | undefined;
  let anomalyMonitorRegistration:
    | ReturnType<typeof registerTerminalAnomalyMonitorTerminal>
    | undefined;
  let denseOverloadCleanup: (() => void) | undefined;
  let recentHiddenReservationCleanup: (() => void) | undefined;
  let sessionDormancyTimer: number | undefined;
  let inputAcknowledgementTimer: number | undefined;
  let pendingTerminalKeyCapture = false;
  let terminalActivityHintTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingTerminalKeyCaptureReleaseTimer: number | undefined;
  let terminalInputCaptureGraceUntilMs = 0;
  let takeOverGeneration = 0;
  let sessionStartGeneration = 0;
  let activeSessionIdentity: string | undefined;
  let activeSearchIdentity: string | undefined;
  let activeSearchCapability: TerminalSession['search'] | undefined;
  let pendingRecoveryFocusRestore = false;
  let previousFocusRestoreIntent = false;
  let previousXtermFocusIntent: boolean | undefined;
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
  let terminalViewUnmounting = false;
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
  previousFocusRestoreIntent = isInitiallyFocused;
  isFocusedNow = isInitiallyFocused;
  isSelectedNow = untrack(() => store.activeTaskId === taskId && isInitiallyCommandTarget);
  isVisibleNow = isInitiallyFocused;
  let previouslyFocused = isFocusedNow;
  let previouslySelected = isSelectedNow;
  let previouslyVisible = typeof IntersectionObserver !== 'function';
  let lastPanelResizeRefreshEpoch = untrack(getPanelResizeDragEpoch);
  const [sessionStatus, setSessionStatus] = createSignal<TerminalViewStatus>('binding');
  const [attachUnavailableReason, setAttachUnavailableReason] =
    createSignal<TerminalSessionAttachUnavailableReason | null>(null);
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
  const [inputAcknowledgementGeneration, setInputAcknowledgementGeneration] = createSignal(0);
  const [inputAcknowledgementDurationMs, setInputAcknowledgementDurationMs] = createSignal(
    getTerminalExperimentInputAcknowledgementDurationMs(),
  );
  const [inputAcknowledgementVisible, setInputAcknowledgementVisible] = createSignal(false);
  const [sessionVersion, setSessionVersion] = createSignal(0);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [searchResult, setSearchResult] = createSignal<TerminalSearchResult>(
    EMPTY_TERMINAL_SEARCH_RESULT,
  );
  const [searchLoading, setSearchLoading] = createSignal(false);
  const [searchUnavailable, setSearchUnavailable] = createSignal(false);
  const [searchFocusVersion, setSearchFocusVersion] = createSignal(0);
  const surfaceTier = createMemo<TerminalSurfaceTier>(() => {
    surfaceTierVersion();
    const registeredTier = getTerminalSurfaceTier(terminalStartupKey);
    if (registeredTier !== 'cold-hidden' || !shouldPinSelectedSurfaceTier()) {
      return registeredTier;
    }

    return shouldUseInteractiveSurfaceTier() ? 'interactive-live' : 'handoff-live';
  });
  const surfaceAllocation = createMemo(() => getTerminalRuntimeSurfaceAllocation(surfaceTier()));
  const isCurrentTerminalSwitchTarget = createMemo(() => {
    switchWindowVersion();
    return isTerminalSwitchTarget(taskId, switchWindowOwnerId);
  });
  const attachPriority = createMemo(() => {
    if (surfaceTier() === 'cold-hidden') {
      if (props.isFocused === true) {
        return 0;
      }

      if (isActiveCommandTarget()) {
        return 1;
      }

      if (isVisible()) {
        return 2;
      }
    }

    return surfaceAllocation().attachPriority;
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
    return store.activeTaskId === taskId && props.isCommandTarget !== false;
  }

  function getTerminalSessionPropsSnapshot(): TerminalViewProps {
    const snapshot: TerminalViewProps = {
      agentId,
      args: props.args,
      command: props.command,
      cwd: props.cwd,
      taskId,
    };

    if (props.adapter !== undefined) {
      snapshot.adapter = props.adapter;
    }
    if (props.arenaLaunchToken !== undefined) {
      snapshot.arenaLaunchToken = props.arenaLaunchToken;
    }
    if (props.baseBranch !== undefined) {
      snapshot.baseBranch = props.baseBranch;
    }
    if (props.env !== undefined) {
      snapshot.env = props.env;
    }
    if (props.fontSize !== undefined) {
      snapshot.fontSize = props.fontSize;
    }
    if (props.initialCommand !== undefined) {
      snapshot.initialCommand = props.initialCommand;
    }
    if (props.isCommandTarget !== undefined) {
      snapshot.isCommandTarget = props.isCommandTarget;
    }
    if (props.isFocused !== undefined) {
      snapshot.isFocused = props.isFocused;
    }
    if (props.isShell !== undefined) {
      snapshot.isShell = props.isShell;
    }
    if (props.manageTaskSwitchWindowLifecycle !== undefined) {
      snapshot.manageTaskSwitchWindowLifecycle = props.manageTaskSwitchWindowLifecycle;
    }
    if (props.onBufferReady !== undefined) {
      snapshot.onBufferReady = props.onBufferReady;
    }
    if (props.onData !== undefined) {
      snapshot.onData = props.onData;
    }
    if (props.onExit !== undefined) {
      snapshot.onExit = props.onExit;
    }
    if (props.onPromptDetected !== undefined) {
      snapshot.onPromptDetected = props.onPromptDetected;
    }
    if (props.onReady !== undefined) {
      snapshot.onReady = props.onReady;
    }
    if (props.projectMode !== undefined) {
      snapshot.projectMode = props.projectMode;
    }
    if (props.replaceExistingSession !== undefined) {
      snapshot.replaceExistingSession = props.replaceExistingSession;
    }
    if (props.resumeOnStart !== undefined) {
      snapshot.resumeOnStart = props.resumeOnStart;
    }
    if (props.runnerProfile !== undefined) {
      snapshot.runnerProfile = props.runnerProfile;
    }
    if (props.sessionOwner !== undefined) {
      snapshot.sessionOwner = props.sessionOwner;
    }
    if (props.startsTaskWatchers !== undefined) {
      snapshot.startsTaskWatchers = props.startsTaskWatchers;
    }

    return snapshot;
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

      const focusPanelId = props.focusPanelId ?? (props.isShell ? 'terminal' : 'ai-terminal');
      setTaskFocusedPanelState(taskId, focusPanelId);
      syncFocusedTypingTaskCommandLease(taskId, focusPanelId);
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
    switchWindowEchoGraceAllowed = false;
    if (!managesTaskSwitchWindowLifecycle) {
      return;
    }

    cancelTerminalSwitchEchoGrace(taskId);
    cancelTerminalSwitchWindow(taskId, switchWindowOwnerId);
  }

  function startSwitchWindowForSelection(options?: { allowEchoGrace?: boolean }): void {
    if (!shouldManageTaskSwitchWindow()) {
      return;
    }

    // Warm the task-command lease at switch intent so the first keystroke
    // after a task switch does not pay the lease-acquisition round trip.
    session?.prefetchInputLease();
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
    switchWindowEchoGraceAllowed = options?.allowEchoGrace ?? true;
  }

  function beginSwitchWindowEchoGraceIfNeeded(): void {
    if (!switchWindowEchoGraceAllowed) {
      return;
    }

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
    return surfaceAllocation().keepSessionLive;
  }

  function shouldKeepTerminalRenderLive(): boolean {
    return surfaceAllocation().keepRenderLive;
  }

  function shouldKeepTerminalGeometryLive(): boolean {
    return (
      surfaceAllocation().keepGeometryLive &&
      (props.isFocused === true || isVisible()) &&
      sessionStatus() === 'ready' &&
      presentationMode().kind === 'live' &&
      !renderHibernating() &&
      !restoreBlocked() &&
      !isPanelResizeDragging()
    );
  }

  function requestTerminalGeometryRefreshAfterPanelResizeDrag(
    pendingResizeFlush: Promise<void> | undefined,
  ): void {
    function markResizeDirtyIfLive(): void {
      if (terminalViewUnmounting || !shouldKeepTerminalGeometryLive()) {
        return;
      }

      markDirty(agentId, 'resize');
    }

    if (!pendingResizeFlush) {
      markResizeDirtyIfLive();
      return;
    }

    void pendingResizeFlush.then(markResizeDirtyIfLive, markResizeDirtyIfLive);
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
    gainedFocusIntent: boolean,
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
      searchOpen() ||
      hasBlockingDialogOpen()
    ) {
      return false;
    }

    const activeElement = document.activeElement;
    // Recovery is not a new request to leave an editor. Focus can move through Tab,
    // browser restoration, or an editor outside a task panel while app intent lags.
    if (
      !gainedFocusIntent &&
      activeElement instanceof HTMLElement &&
      !isTerminalDomFocused(shellRef) &&
      activeElement.matches(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      )
    ) {
      pendingRecoveryFocusRestore = false;
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
      case 'ready':
        return (
          presentationMode().kind === 'live' &&
          isTerminalPaintReady(status) &&
          !renderHibernating() &&
          !restoreBlocked() &&
          !resizeTransactionActive()
        );
      case 'attaching':
      case 'binding':
      case 'error':
      case 'restoring':
        return false;
      default:
        return assertNever(status, 'Unhandled terminal input acceptance status');
    }
  }

  function canBufferTerminalInputWhileInteractionPending(): boolean {
    return (
      (isActiveCommandTarget() || props.isFocused === true || domFocusWithin()) &&
      !hasPeerController() &&
      !renderHibernating() &&
      sessionStatus() !== 'error'
    );
  }

  function isBackendInputAcknowledgementExperimentEnabled(): boolean {
    return getTerminalExperimentInputAcknowledgementMode() === 'pulse';
  }

  function isLocalInputFeedbackAvailable(): boolean {
    return presentationMode().kind === 'live';
  }

  function clearInputAcknowledgementTimer(): void {
    if (inputAcknowledgementTimer === undefined) {
      return;
    }

    window.clearTimeout(inputAcknowledgementTimer);
    inputAcknowledgementTimer = undefined;
  }

  function clearInputAcknowledgement(): void {
    clearInputAcknowledgementTimer();
    if (terminalViewUnmounting) {
      return;
    }

    setInputAcknowledgementVisible(false);
  }

  function showInputAcknowledgement(durationMs: number): void {
    if (terminalViewUnmounting) {
      return;
    }

    if (!isLocalInputFeedbackAvailable()) {
      return;
    }

    clearInputAcknowledgementTimer();
    setInputAcknowledgementDurationMs(durationMs);
    setInputAcknowledgementGeneration((generation) => generation + 1);
    setInputAcknowledgementVisible(true);
    inputAcknowledgementTimer = window.setTimeout(() => {
      inputAcknowledgementTimer = undefined;
      setInputAcknowledgementVisible(false);
    }, durationMs);
  }

  function showBackendInputAcknowledgement(): void {
    if (!isBackendInputAcknowledgementExperimentEnabled()) {
      return;
    }

    showInputAcknowledgement(getTerminalExperimentInputAcknowledgementDurationMs());
  }

  function getEffectiveLocalInputFeedbackMode(): TerminalLocalInputFeedbackMode {
    const experimentOverride = getTerminalExperimentLocalInputFeedbackModeOverride();
    if (experimentOverride !== null) {
      return experimentOverride;
    }

    return store.terminalLocalInputFeedbackEnabled ? 'ack-pulse' : 'off';
  }

  function handleSessionLocalInputFeedback(): void {
    if (terminalViewUnmounting) {
      return;
    }

    const feedbackMode = getEffectiveLocalInputFeedbackMode();
    switch (feedbackMode) {
      case 'ack-pulse':
        recordTerminalLocalInputAckPulse();
        showInputAcknowledgement(getTerminalExperimentLocalInputFeedbackDurationMs());
        return;
      case 'off':
        return;
      default:
        return assertNever(feedbackMode, 'Unhandled local input feedback mode');
    }
  }

  function handleSessionInputAccepted(): void {
    if (terminalViewUnmounting) {
      return;
    }

    if (getEffectiveLocalInputFeedbackMode() !== 'off') {
      return;
    }

    showBackendInputAcknowledgement();
  }

  function handleSessionOutputRendered(): void {
    if (terminalViewUnmounting) {
      return;
    }

    clearInputAcknowledgement();
  }

  function getInputAcknowledgementPulsePhase(): 'even' | 'odd' | undefined {
    if (!inputAcknowledgementVisible()) {
      return undefined;
    }

    return inputAcknowledgementGeneration() % 2 === 0 ? 'even' : 'odd';
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

  function shouldWaitForObservedShellVisibility(): boolean {
    return (
      props.isShell === true && !isInitiallyFocused && typeof IntersectionObserver === 'function'
    );
  }

  function canStartInitialShellSession(): boolean {
    if (props.isShell !== true || sessionStartedOnce || !shouldWaitForObservedShellVisibility()) {
      return true;
    }

    if (attachRegistration || terminalAttachQueued || terminalAttachInProgress) {
      return true;
    }

    if (props.isFocused === true || shouldPinSelectedSurfaceTier()) {
      return true;
    }

    return isVisible();
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
    const currentSession = session;
    if (!currentSession) {
      return;
    }

    const nextDisableStdin = !canAcceptTerminalInput();
    if (currentSession.term.options.disableStdin !== nextDisableStdin) {
      currentSession.term.options.disableStdin = nextDisableStdin;
    }

    const nextCursorBlink = shouldBlinkTerminalCursor();
    if (currentSession.term.options.cursorBlink !== nextCursorBlink) {
      currentSession.term.options.cursorBlink = nextCursorBlink;
    }

    currentSession.updateOutputPriority?.();
  }

  function syncCurrentSessionFocusIntent(): void {
    if (!session) {
      previousXtermFocusIntent = undefined;
      return;
    }

    const nextFocusIntent = isTerminalFocused();
    if (previousXtermFocusIntent === undefined) {
      previousXtermFocusIntent = nextFocusIntent;
      return;
    }

    if (previousXtermFocusIntent && !nextFocusIntent) {
      session.term.blur?.();
    }
    previousXtermFocusIntent = nextFocusIntent;
  }

  function getBufferedTerminalKeyData(event: KeyboardEvent): string | null {
    if (event.isComposing || event.altKey || event.metaKey) {
      return null;
    }

    if (event.ctrlKey) {
      switch (event.key.toLowerCase()) {
        case 'c':
          return '\x03';
        case 'd':
          return '\x04';
        case 'u':
          return '\x15';
        default:
          return null;
      }
    }

    switch (event.key) {
      case 'ArrowDown':
        return '\x1b[B';
      case 'ArrowLeft':
        return '\x1b[D';
      case 'ArrowRight':
        return '\x1b[C';
      case 'ArrowUp':
        return '\x1b[A';
      case 'Backspace':
        return '\x7f';
      case 'Delete':
        return '\x1b[3~';
      case 'End':
        return '\x1b[F';
      case 'Enter':
        return '\r';
      case 'Escape':
        return '\x1b';
      case 'Home':
        return '\x1b[H';
      case 'PageDown':
        return '\x1b[6~';
      case 'PageUp':
        return '\x1b[5~';
      case 'Tab':
        if (event.shiftKey) {
          return '\x1b[Z';
        }
        return '\t';
      default:
        if (event.key.length === 1) {
          return event.key;
        }
        return null;
    }
  }

  function getBufferedTerminalBeforeInputData(event: InputEvent): string | null {
    if (event.isComposing) {
      return null;
    }

    switch (event.inputType) {
      case 'deleteContentBackward':
        return '\x7f';
      case 'insertLineBreak':
      case 'insertParagraph':
        return '\r';
      case 'insertText':
        if (event.data && event.data.length > 0) {
          return event.data;
        }
        return null;
      default:
        return null;
    }
  }

  function getTerminalInputCaptureNowMs(): number {
    if (typeof performance === 'undefined') {
      return Date.now();
    }

    return performance.now();
  }

  function isTerminalInputCaptureGraceActive(): boolean {
    return getTerminalInputCaptureNowMs() < terminalInputCaptureGraceUntilMs;
  }

  function armTerminalInputCaptureGrace(): void {
    terminalInputCaptureGraceUntilMs =
      getTerminalInputCaptureNowMs() + POST_RECOVERY_INPUT_CAPTURE_GRACE_MS;
  }

  function clearTerminalInputCaptureGrace(): void {
    terminalInputCaptureGraceUntilMs = 0;
  }

  function armTerminalInputCaptureGraceIfPaintReady(): void {
    if (isTerminalPaintReady(sessionStatus()) && canBufferTerminalInputWhileInteractionPending()) {
      armTerminalInputCaptureGrace();
    }
  }

  function isTerminalSessionExpected(): boolean {
    return attachRegistration !== undefined || terminalAttachQueued || terminalAttachInProgress;
  }

  function shouldBufferPendingTerminalInputEvent(): boolean {
    // Keys typed before the session object exists are buffered too, as long
    // as an attach is queued or in flight; they drain into the session in
    // acceptStartedTerminalSession so nothing typed in the focus-to-ready
    // window is lost.
    return (
      (session !== undefined || isTerminalSessionExpected()) &&
      (!canAcceptTerminalInput() ||
        pendingTerminalKeyCapture ||
        isTerminalInputCaptureGraceActive()) &&
      canBufferTerminalInputWhileInteractionPending()
    );
  }

  function isEditableElement(element: Element): boolean {
    return (
      element.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]') ||
      element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !==
        null
    );
  }

  function isOwnedTerminalInputElement(element: Element): boolean {
    const terminalInput = element.closest(TERMINAL_INPUT_SELECTOR);
    return terminalInput !== null && shellRef?.contains(terminalInput) === true;
  }

  function shouldHandleTerminalInputCapture(event: Event): boolean {
    if (!shouldBufferPendingTerminalInputEvent()) {
      return false;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
      return true;
    }

    // xterm disables its own textarea while resize/recovery blocks direct
    // stdin. Keep capturing that owned textarea so keys enter the ordered
    // pending-input path instead of disappearing. Other editors, including
    // terminal search and controls outside this surface, retain normal input.
    if (
      target instanceof Element &&
      isEditableElement(target) &&
      !isOwnedTerminalInputElement(target)
    ) {
      return false;
    }

    if (shellRef?.contains(target)) {
      return true;
    }

    return target === document.body || target === document.documentElement;
  }

  function scheduleTerminalInputActivityHint(): void {
    if (store.tasks[taskId]?.coordinatorRole !== 'subtask') {
      return;
    }
    if (terminalActivityHintTimer !== undefined) {
      return;
    }

    terminalActivityHintTimer = setTimeout(() => {
      terminalActivityHintTimer = undefined;
      void sendCoordinatorActivityHint({
        agentGeneration: store.agents[agentId]?.generation ?? 0,
        blocked: true,
        clientId: getRuntimeClientId(),
        kind: 'terminal-pending-input',
        seq: nextCoordinatorActivityHintSeq(),
        taskId,
        ttlMs: 1_500,
      }).catch(() => {});
    }, 100);
  }

  function enqueueCapturedTerminalInput(data: string): void {
    pendingTerminalKeyCapture = true;
    scheduleTerminalInputActivityHint();
    clearPendingTerminalKeyCaptureReleaseTimer();
    if (canAcceptTerminalInput()) {
      schedulePendingTerminalKeyCaptureRelease();
    }
    if (session) {
      session.handleTerminalData(data);
      return;
    }

    enqueuePendingSessionInput(terminalStartupKey, data);
  }

  function handleTerminalKeyDownCapture(event: KeyboardEvent): void {
    if (!shouldHandleTerminalInputCapture(event)) {
      return;
    }

    const data = getBufferedTerminalKeyData(event);
    if (data === null) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    enqueueCapturedTerminalInput(data);
  }

  function handleTerminalBeforeInputCapture(event: InputEvent): void {
    if (!shouldHandleTerminalInputCapture(event)) {
      return;
    }

    const data = getBufferedTerminalBeforeInputData(event);
    if (data === null) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    enqueueCapturedTerminalInput(data);
  }

  function clearPendingTerminalKeyCaptureReleaseTimer(): void {
    if (pendingTerminalKeyCaptureReleaseTimer === undefined) {
      return;
    }

    window.clearTimeout(pendingTerminalKeyCaptureReleaseTimer);
    pendingTerminalKeyCaptureReleaseTimer = undefined;
  }

  function schedulePendingTerminalKeyCaptureRelease(): void {
    clearPendingTerminalKeyCaptureReleaseTimer();
    pendingTerminalKeyCaptureReleaseTimer = window.setTimeout(() => {
      pendingTerminalKeyCaptureReleaseTimer = undefined;
      pendingTerminalKeyCapture = false;
      clearTerminalInputCaptureGrace();
    }, 250);
  }

  function schedulePendingTerminalKeyCaptureReleaseIfReady(): void {
    if (
      pendingTerminalKeyCapture &&
      pendingTerminalKeyCaptureReleaseTimer === undefined &&
      canAcceptTerminalInput()
    ) {
      schedulePendingTerminalKeyCaptureRelease();
    }
  }

  function clearPendingTerminalKeyCapture(): void {
    clearPendingTerminalKeyCaptureReleaseTimer();
    pendingTerminalKeyCapture = false;
    clearTerminalInputCaptureGrace();
  }

  onMount(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.addEventListener('keydown', handleTerminalKeyDownCapture, true);
    document.addEventListener('beforeinput', handleTerminalBeforeInputCapture, true);
    onCleanup(() => {
      if (terminalActivityHintTimer !== undefined) {
        clearTimeout(terminalActivityHintTimer);
        terminalActivityHintTimer = undefined;
      }
      clearPendingTerminalKeyCapture();
      document.removeEventListener('keydown', handleTerminalKeyDownCapture, true);
      document.removeEventListener('beforeinput', handleTerminalBeforeInputCapture, true);
    });
  });

  createEffect(() => {
    if (!canBufferTerminalInputWhileInteractionPending()) {
      clearPendingTerminalKeyCapture();
    }
  });

  createEffect(() => {
    schedulePendingTerminalKeyCaptureReleaseIfReady();
  });

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

  function getTerminalSessionIdentity(generation: number): string {
    return `${terminalStartupKey}:${generation}`;
  }

  function isCurrentSearchBinding(
    identity: string | undefined,
    capability: TerminalSession['search'] | undefined,
  ): boolean {
    return (
      identity !== undefined &&
      capability !== undefined &&
      identity === activeSessionIdentity &&
      identity === activeSearchIdentity &&
      capability === activeSearchCapability &&
      capability === session?.search
    );
  }

  function resetTerminalSearchPresentation(): void {
    if (terminalViewUnmounting) {
      return;
    }

    setSearchOpen(false);
    setSearchQuery('');
    setSearchResult(EMPTY_TERMINAL_SEARCH_RESULT);
    setSearchLoading(false);
    setSearchUnavailable(false);
  }

  function closeTerminalSearch(restoreFocus: boolean): void {
    const identity = activeSearchIdentity;
    const capability = activeSearchCapability;
    activeSearchIdentity = undefined;
    activeSearchCapability = undefined;
    resetTerminalSearchPresentation();
    capability?.close();

    if (!restoreFocus || !identity || !capability) {
      return;
    }

    queueMicrotask(() =>
      untrack(() => {
        if (
          terminalViewUnmounting ||
          activeSessionIdentity !== identity ||
          session?.search !== capability ||
          sessionDormant() ||
          sessionStatus() !== 'ready' ||
          !isVisible()
        ) {
          return;
        }

        session.term.focus();
      }),
    );
  }

  function handleSearchRequested(identity: string, capability: TerminalSession['search']): void {
    if (
      terminalViewUnmounting ||
      identity !== activeSessionIdentity ||
      capability !== session?.search ||
      sessionDormant()
    ) {
      return;
    }

    if (
      searchOpen() &&
      activeSearchIdentity === identity &&
      activeSearchCapability === capability
    ) {
      setSearchFocusVersion((version) => version + 1);
      return;
    }

    if (searchOpen()) {
      closeTerminalSearch(false);
    }

    const selectionSeed = capability.getSelectionSeed();
    activeSearchIdentity = identity;
    activeSearchCapability = capability;
    setSearchQuery(selectionSeed);
    setSearchResult(EMPTY_TERMINAL_SEARCH_RESULT);
    setSearchUnavailable(false);
    setSearchLoading(selectionSeed.length > 0);
    setSearchOpen(true);
    setSearchFocusVersion((version) => version + 1);
    capability.setDecorationTheme(getTerminalSearchDecorationTheme(store.themePreset));
    if (selectionSeed.length === 0) {
      capability.clear();
      return;
    }

    capability.find(selectionSeed, { direction: 'next', incremental: true });
  }

  function handleSearchResult(
    identity: string,
    capability: TerminalSession['search'],
    result: TerminalSearchResult,
  ): void {
    if (!searchOpen() || !isCurrentSearchBinding(identity, capability)) {
      return;
    }

    setSearchResult(result);
    setSearchLoading(false);
  }

  function handleSearchUnavailable(identity: string, capability: TerminalSession['search']): void {
    if (!searchOpen() || !isCurrentSearchBinding(identity, capability)) {
      return;
    }

    setSearchLoading(false);
    setSearchUnavailable(true);
  }

  function handleSearchQueryChange(query: string): void {
    const capability = activeSearchCapability;
    const identity = activeSearchIdentity;
    if (!searchOpen() || !isCurrentSearchBinding(identity, capability) || !capability) {
      return;
    }

    const boundedQuery = query.slice(0, TERMINAL_SEARCH_QUERY_LIMIT);
    setSearchQuery(boundedQuery);
    setSearchResult(EMPTY_TERMINAL_SEARCH_RESULT);
    if (boundedQuery.length === 0) {
      setSearchLoading(false);
      capability.clear();
      return;
    }

    if (searchUnavailable()) {
      return;
    }

    setSearchLoading(true);
    capability.find(boundedQuery, { direction: 'next', incremental: true });
  }

  function handleSearchNavigate(direction: 'next' | 'previous'): void {
    const capability = activeSearchCapability;
    const identity = activeSearchIdentity;
    const query = searchQuery();
    if (
      query.length === 0 ||
      searchUnavailable() ||
      !searchOpen() ||
      !isCurrentSearchBinding(identity, capability) ||
      !capability
    ) {
      return;
    }

    setSearchLoading(true);
    capability.find(query, { direction, incremental: false });
  }

  function cleanupTerminalSessionLifetime(): void {
    sessionStartGeneration += 1;
    takeOverGeneration += 1;
    terminalAttachInProgress = false;
    terminalAttachQueued = false;
    terminalAttachUnregisterPending = false;
    terminalSessionLoadFailed = false;
    selectedInteractiveBreadcrumbEmitted = false;
    if (!terminalViewUnmounting) {
      setTakingOver(false);
      setRenderHibernating(false);
      setRestoreBlocked(false);
      setResizeTransactionActive(false);
    }
    closeTerminalSearch(false);
    const currentSession = session;
    session = undefined;
    activeSessionIdentity = undefined;
    currentSession?.cleanup();
    previousXtermFocusIntent = undefined;
    if (!terminalViewUnmounting) {
      setSessionVersion((version) => version + 1);
    }
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
    activeSessionIdentity = getTerminalSessionIdentity(generation);
    // Drain pre-session keystrokes into the session input pipeline before any
    // other input so focus-to-ready typing keeps its order relative to keys
    // typed after the session exists.
    const pendingSessionInput = takePendingSessionInput(terminalStartupKey);
    if (pendingSessionInput !== null && pendingSessionInput.length > 0) {
      nextSession.handleTerminalData(pendingSessionInput);
    }
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
    if (terminalViewUnmounting) {
      return;
    }

    if (status !== 'ready') {
      clearInputAcknowledgement();
    } else {
      setAttachUnavailableReason(null);
    }
    setSessionStatus(status);
    armTerminalInputCaptureGraceIfPaintReady();
    syncCurrentSessionRuntimeState();
    schedulePendingTerminalKeyCaptureReleaseIfReady();
  }

  function retryUnavailableTerminalAttach(): void {
    const currentSession = session;
    if (!currentSession || attachUnavailableReason() === null) return;
    pendingRecoveryFocusRestore = true;
    setAttachUnavailableReason(null);
    currentSession.retryAttach();
  }

  function handleSessionPaintReadyChange(nextPaintReady: boolean): void {
    if (terminalViewUnmounting) {
      return;
    }

    setPaintReady(nextPaintReady);
    armTerminalInputCaptureGraceIfPaintReady();
    syncCurrentSessionRuntimeState();
    schedulePendingTerminalKeyCaptureReleaseIfReady();
  }

  function handleSessionRenderHibernationChange(isHibernating: boolean): void {
    if (terminalViewUnmounting) {
      return;
    }

    if (isHibernating) {
      clearInputAcknowledgement();
    }
    setRenderHibernating(isHibernating);
    syncCurrentSessionRuntimeState();
  }

  function handleSessionRestoreBlockedChange(isBlocked: boolean): void {
    if (terminalViewUnmounting) {
      return;
    }

    if (isBlocked) {
      clearInputAcknowledgement();
    }
    setRestoreBlocked(isBlocked);
    syncCurrentSessionRuntimeState();
  }

  function handleSessionResizeTransactionChange(isActive: boolean): void {
    if (terminalViewUnmounting) {
      return;
    }

    if (isActive) {
      clearInputAcknowledgement();
    }
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
            canBufferInputWhileInteractionPending: canBufferTerminalInputWhileInteractionPending,
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
            },
            onAttachDispatched: () => {
              // The scheduler slot only guards renderer CPU phases: release
              // it as soon as the attach RPC is dispatched instead of when
              // the backend resolves it.
              attachRegistration?.release();
            },
            onAttachSettledWithoutDispatch: () => {
              // Lease refusal/cancellation still settles this queued attempt,
              // even though no backend attach RPC was dispatched.
              attachRegistration?.release();
            },
            onAttachMilestone: (milestone) => {
              recordTerminalAttachMilestone(terminalStartupKey, milestone);
            },
            onAttachUnavailable: setAttachUnavailableReason,
            onBlockedInputAttempt: () => {
              recordTerminalPresentationBlockedInput(presentationMode().kind);
              anomalyMonitorRegistration?.recordInteraction('blocked-input');
            },
            onInputAccepted: handleSessionInputAccepted,
            onLocalInputFeedback: handleSessionLocalInputFeedback,
            onOutputRendered: handleSessionOutputRendered,
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
            onSearchRequested: handleSearchRequested,
            onSearchResult: handleSearchResult,
            onSearchUnavailable: handleSearchUnavailable,
            onSelectedRecoverySettle: () => {
              markTerminalSwitchWindowRecoverySettled(taskId, switchWindowOwnerId);
              requestTerminalOutputDrain();
            },
            onSelectedRecoveryStart: () => {
              markTerminalSwitchWindowRecoveryStarted(taskId, switchWindowOwnerId);
            },
            onShouldKeepRenderLive: shouldKeepTerminalRenderLive,
            onStatusChange: handleSessionStatusChange,
            props: getTerminalSessionPropsSnapshot(),
            sessionIdentity: getTerminalSessionIdentity(generation),
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

    if (!canStartInitialShellSession()) {
      clearSessionDormancyTimer();
      setSessionDormant(true);
      setSessionStatus('binding');
      return;
    }

    // Mirrors the attachPriority cold-hidden override: a terminal whose tier
    // has not registered yet still counts as live when it is focused, the
    // active command target, or already visible.
    const hasLiveAttachIntent = props.isFocused === true || isActiveCommandTarget() || isVisible();
    const shouldDeferColdHiddenSession =
      props.isShell === true
        ? !shouldKeepTerminalSessionLive()
        : !shouldKeepTerminalSessionLive() && !hasLiveAttachIntent;
    if (!sessionStartedOnce && shouldDeferColdHiddenSession) {
      // Cold-hidden terminals defer their renderer attach until visibility or
      // prewarm intent. Non-shell terminals keep their backend session (and
      // supervision) live through the ensure path while deferred.
      clearSessionDormancyTimer();
      setSessionDormant(true);
      setSessionStatus('binding');
      if (props.isShell !== true) {
        ensureAgentSessionForDeferredTerminal(taskId, agentId);
      }
      return;
    }

    if (!sessionStartedOnce) {
      clearSessionDormancyTimer();
      ensureTerminalSessionRegistered();
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
    const initialVisibility =
      isInitiallyFocused ||
      (!shouldWaitForObservedShellVisibility() && isElementVisibleInViewport(shellRef));
    setIsVisible(initialVisibility);
    syncDomFocusWithin();
    document.addEventListener('focusin', handleDocumentFocusIn, true);
    document.addEventListener('focusout', handleDocumentFocusOut, true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    if (isActiveCommandTarget() && initialVisibility) {
      startSwitchWindowForSelection({ allowEchoGrace: false });
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
      terminalViewUnmounting = true;
      document.removeEventListener('focusin', handleDocumentFocusIn, true);
      document.removeEventListener('focusout', handleDocumentFocusOut, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
      observer?.disconnect();
      clearInputAcknowledgement();
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
  const queuedInputCount = createMemo(() => getPendingSessionInputCount(terminalStartupKey));
  // The placeholder is a static capture of the last-known screen, taken once
  // per loading-phase entry so live writes underneath never animate through
  // the masked overlay. While the capture is still empty (cold start before
  // the supervision preview hydrates), a late-arriving tail may fill it once;
  // a non-empty capture stays frozen until the next loading entry.
  const [loadingPlaceholderTail, setLoadingPlaceholderTail] = createSignal<string | null>(null);
  let previousLoadingPresentation = false;
  createEffect(() => {
    const loading = presentationMode().kind === 'loading';
    if (!loading) {
      previousLoadingPresentation = false;
      return;
    }

    if (!previousLoadingPresentation) {
      previousLoadingPresentation = true;
      setLoadingPlaceholderTail(untrack(() => getTaskTerminalPlaceholderTail(agentId)));
    }
    if (loadingPlaceholderTail() === null) {
      const lateTail = getTaskTerminalPlaceholderTail(agentId);
      if (lateTail !== null) {
        setLoadingPlaceholderTail(lateTail);
      }
    }
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
    if (getEffectiveLocalInputFeedbackMode() !== 'ack-pulse') {
      clearInputAcknowledgement();
    }
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
    const panelResizeDragEpoch = getPanelResizeDragEpoch();
    const hasUnrefreshedPanelResize =
      !isPanelResizeDragging() && panelResizeDragEpoch !== lastPanelResizeRefreshEpoch;
    const geometryLive = shouldKeepTerminalGeometryLive();
    if (!geometryLive) {
      return;
    }

    const pendingResizeFlush = session?.flushPendingResize();

    if (!hasUnrefreshedPanelResize) {
      return;
    }

    lastPanelResizeRefreshEpoch = panelResizeDragEpoch;
    requestTerminalGeometryRefreshAfterPanelResizeDrag(pendingResizeFlush);
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
    session.search.setDecorationTheme(getTerminalSearchDecorationTheme(preset));
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
    syncCurrentSessionFocusIntent();
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

    const gainedFocusIntent = focused && !previousFocusRestoreIntent;
    previousFocusRestoreIntent = focused;

    if (!focused) {
      pendingRecoveryFocusRestore = false;
      return;
    }

    if (gainedFocusIntent) {
      pendingRecoveryFocusRestore = true;
    }

    if (status === 'attaching' || status === 'restoring' || blocked) {
      pendingRecoveryFocusRestore = true;
      return;
    }

    const activeSession = session;
    if (
      hibernating ||
      !activeSession ||
      !shouldRestoreTerminalFocusAfterRecovery(status, mode, gainedFocusIntent)
    ) {
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
      data-terminal-agent-id={agentId}
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
      data-terminal-input-ack={inputAcknowledgementVisible() ? 'true' : undefined}
      data-terminal-input-ack-phase={getInputAcknowledgementPulsePhase()}
      data-terminal-render-hibernating={renderHibernating() ? 'true' : undefined}
      data-terminal-restore-blocked={restoreBlocked() ? 'true' : undefined}
      data-terminal-search-open={searchOpen() ? 'true' : undefined}
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
        '--terminal-input-ack-duration': `${inputAcknowledgementDurationMs()}ms`,
      }}
    >
      <div
        ref={containerRef}
        data-terminal-live-surface="true"
        style={{
          position: 'absolute',
          inset: '4px',
          overflow: 'hidden',
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
            <Show when={!isLiveRenderReady() && loadingPlaceholderTail()}>
              {(placeholderTail) => (
                <pre
                  data-terminal-placeholder-tail="true"
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: '12px',
                    margin: '0',
                    overflow: 'hidden',
                    'font-family': getTerminalFontFamily(store.terminalFont),
                    'font-size': '12px',
                    'line-height': '1.4',
                    color: `color-mix(in srgb, ${theme.fgMuted} 55%, transparent)`,
                    'white-space': 'pre-wrap',
                    'word-break': 'break-word',
                    'pointer-events': 'none',
                    'user-select': 'none',
                  }}
                >
                  {placeholderTail()}
                </pre>
              )}
            </Show>
            <div
              data-terminal-loading-card="true"
              style={{
                position: 'relative',
                display: 'grid',
                'grid-template-columns': '14px minmax(0, 1fr)',
                'align-items': 'center',
                gap: '8px 10px',
                padding: '8px 12px',
                'max-width': '100%',
                background: 'color-mix(in srgb, var(--island-bg) 92%, transparent)',
                border:
                  queuedInputCount() > 0
                    ? `1px solid color-mix(in srgb, ${theme.accent} 45%, ${theme.border})`
                    : `1px solid ${theme.border}`,
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
              <Show when={!isLiveRenderReady() && queuedInputCount() > 0}>
                <span
                  data-terminal-queued-input-count={String(queuedInputCount())}
                  style={{
                    'grid-column': '2',
                    'font-family': getTerminalFontFamily(store.terminalFont),
                    'font-size': '11px',
                    color: theme.accent,
                    'white-space': 'nowrap',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                  }}
                >
                  {`${queuedInputCount()} key${queuedInputCount() === 1 ? '' : 's'} queued — sent when ready`}
                </span>
              </Show>
            </div>
          </div>
        )}
      </Show>
      <Show when={attachUnavailableReason()}>
        {(reason) => (
          <div
            data-terminal-restore-unavailable={reason()}
            role="status"
            aria-live="polite"
            style={{
              position: 'absolute',
              right: '12px',
              bottom: '12px',
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              padding: '6px 8px',
              'border-radius': '8px',
              border: `1px solid ${theme.border}`,
              background: 'color-mix(in srgb, var(--island-bg) 92%, transparent)',
              color: theme.fgMuted,
              'font-size': '12px',
              'z-index': '12',
            }}
          >
            <span>{getTerminalRestoreUnavailableMessage(reason())}</span>
            <button type="button" onClick={retryUnavailableTerminalAttach}>
              Retry restore
            </button>
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
              top: searchOpen() ? '52px' : '8px',
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
              top: searchOpen() ? '52px' : '8px',
              left: '8px',
              right: '8px',
              'z-index': '12',
              background: 'color-mix(in srgb, var(--island-bg) 88%, rgba(18, 22, 28, 0.18))',
            }}
          />
        )}
      </Show>
      <Show when={searchOpen()}>
        <TerminalSearchOverlay
          focusVersion={searchFocusVersion()}
          loading={searchLoading()}
          query={searchQuery()}
          result={searchResult()}
          unavailable={searchUnavailable()}
          onClose={() => closeTerminalSearch(true)}
          onNavigate={handleSearchNavigate}
          onQueryChange={handleSearchQueryChange}
        />
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
