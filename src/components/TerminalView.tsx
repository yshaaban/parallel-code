import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';

import { getTerminalFontFamily } from '../lib/fonts';
import { getTerminalTheme } from '../lib/theme';
import { markDirty } from '../lib/terminalFitManager';
import { setWebglAddonPriority, touchWebglAddon } from '../lib/webglPool';
import { assertNever } from '../lib/assert-never';
import { theme } from '../lib/theme';
import {
  getTerminalExperimentSwitchPostInputReadyEchoGraceMs,
  getTerminalExperimentSwitchTargetWindowMs,
  getTerminalPerformanceExperimentConfig,
} from '../lib/terminal-performance-experiments';
import {
  recordTerminalPresentationBlockedInput,
  recordTerminalPresentationTransition,
} from '../app/runtime-diagnostics';
import { isPanelResizeDragging } from '../app/panel-resize-drag';
import { store } from '../store/store';
import { clearTerminalStartupEntry, setTerminalStartupPhase } from '../store/terminal-startup';
import { TaskControlBanner } from './TaskControlBanner';
import { TaskControlChip } from './TaskControlChip';
import { createTaskControlVisualState } from './task-control-visual-state';
import { registerTerminalAttachCandidate } from '../app/terminal-attach-scheduler';
import {
  armFocusedTerminalOutputPreemption,
  requestTerminalOutputDrain,
} from '../app/terminal-output-scheduler';
import { subscribeTerminalPrewarm } from '../app/terminal-prewarm';
import { subscribeTerminalDenseOverloadChanges } from '../app/terminal-dense-overload';
import { subscribeTerminalFocusedInputChanges } from '../app/terminal-focused-input';
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
import { startTerminalSession } from './terminal-view/terminal-session';
import type {
  TerminalPresentationMode,
  TerminalViewProps,
  TerminalViewStatus,
} from './terminal-view/types';
import {
  getTerminalOutputPriority,
  getTerminalWebglPriority,
} from '../lib/terminal-output-priority';

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

function getRoundedPerformanceNow(): number {
  return Math.round(performance.now() * 100) / 100;
}

interface TerminalAttachTraceEntry {
  agentId: string;
  attachBoundAtMs: number | null;
  attachQueuedAtMs: number;
  attachStartedAtMs: number | null;
  key: string;
  readyAtMs: number | null;
  status: TerminalViewStatus | 'queued';
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

function ensureTerminalAttachTraceEntry(
  key: string,
  taskId: string,
  agentId: string,
): TerminalAttachTraceEntry | null {
  if (!shouldRecordTerminalAttachTrace()) {
    return null;
  }

  const traceStore = window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ ?? {};
  const existingEntry = traceStore[key];
  if (existingEntry) {
    return existingEntry;
  }

  const nextEntry: TerminalAttachTraceEntry = {
    agentId,
    attachBoundAtMs: null,
    attachQueuedAtMs: getRoundedPerformanceNow(),
    attachStartedAtMs: null,
    key,
    readyAtMs: null,
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
): void {
  switch (status) {
    case 'binding':
      return;
    case 'attaching':
      setTerminalStartupPhase(terminalStartupKey, 'attaching');
      return;
    case 'restoring':
      setTerminalStartupPhase(terminalStartupKey, 'restoring');
      return;
    case 'ready':
    case 'error':
      clearTerminalStartupEntry(terminalStartupKey);
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

export function TerminalView(props: TerminalViewProps): JSX.Element {
  let shellRef!: HTMLDivElement;
  let containerRef!: HTMLDivElement;
  let session: ReturnType<typeof startTerminalSession> | undefined;
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
  let focusedInputCleanup: (() => void) | undefined;
  let recentHiddenReservationCleanup: (() => void) | undefined;
  let sessionDormancyTimer: number | undefined;
  let lastRecordedPresentationMode: TerminalPresentationMode['kind'] | null = null;
  let sessionStartedOnce = false;
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
  isFocusedNow = isInitiallyFocused;
  isSelectedNow = untrack(() => store.activeTaskId === taskId);
  isVisibleNow = isInitiallyFocused;
  let previouslyFocused = isFocusedNow;
  let previouslySelected = isSelectedNow;
  let previouslyVisible = typeof IntersectionObserver !== 'function';
  const [sessionStatus, setSessionStatus] = createSignal<TerminalViewStatus>('binding');
  const [sessionDormant, setSessionDormant] = createSignal(false);
  const [renderHibernating, setRenderHibernating] = createSignal(false);
  const [restoreBlocked, setRestoreBlocked] = createSignal(false);
  const [surfaceTierVersion, setSurfaceTierVersion] = createSignal(0);
  const [switchWindowVersion, setSwitchWindowVersion] = createSignal(0);
  const [anomalyMonitorVersion, setAnomalyMonitorVersion] = createSignal(0);
  const [takingOver, setTakingOver] = createSignal(false);
  const [isVisible, setIsVisible] = createSignal(isInitiallyFocused);
  const surfaceTier = createMemo<TerminalSurfaceTier>(() => {
    surfaceTierVersion();
    return getTerminalSurfaceTier(terminalStartupKey);
  });
  const isCurrentTerminalSwitchTarget = createMemo(() => {
    switchWindowVersion();
    return isTerminalSwitchTarget(taskId, switchWindowOwnerId);
  });
  const attachPriority = createMemo(() => {
    if (props.isFocused === true) {
      return 0;
    }

    if (store.activeTaskId === props.taskId) {
      return 1;
    }

    if (isVisible()) {
      return 2;
    }

    return 3;
  });
  const outputPriority = createMemo(() =>
    getTerminalOutputPriority({
      isActiveTask: store.activeTaskId === props.taskId,
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
  const terminalAnomalies = createMemo(() => terminalAnomalySnapshot()?.anomalies ?? []);
  const terminalAnomalyKinds = createMemo(() => {
    if (terminalAnomalies().length === 0) {
      return null;
    }

    return terminalAnomalies()
      .map((anomaly) => anomaly.key)
      .join(',');
  });
  const terminalAnomalySeverity = createMemo(() => {
    const anomalies = terminalAnomalies();
    if (anomalies.some((anomaly) => anomaly.severity === 'error')) {
      return 'error';
    }

    if (anomalies.length > 0) {
      return 'warning';
    }

    return null;
  });
  const terminalAnomalyLabel = createMemo(() => {
    if (terminalAnomalies().length === 0) {
      return null;
    }

    return terminalAnomalies()
      .map((anomaly) => anomaly.label)
      .join(' · ');
  });

  function bumpAnomalyMonitorVersion(): void {
    setAnomalyMonitorVersion((version) => version + 1);
  }

  function getCurrentTerminalAnomalyLifecycleState() {
    return {
      cursorBlink: shouldBlinkTerminalCursor(),
      hasPeerController: hasPeerController(),
      isFocused: props.isFocused === true,
      isSelected: store.activeTaskId === props.taskId,
      isVisible: isVisible(),
      liveRenderReady: isLiveRenderReady(),
      presentationMode: presentationMode().kind,
      renderHibernating: renderHibernating(),
      restoreBlocked: restoreBlocked(),
      sessionDormant: sessionDormant(),
      status: sessionStatus(),
      surfaceTier: surfaceTier(),
    } as const;
  }

  async function handleTakeOver(): Promise<void> {
    if (!session || takingOver()) {
      return;
    }

    setTakingOver(true);
    try {
      const acquired = await session.requestInputTakeover();
      if (acquired) {
        session.term.focus();
      }
    } finally {
      setTakingOver(false);
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

  function isTerminalLiveRenderReady(status: TerminalViewStatus): boolean {
    return status === 'ready' && isVisible() && !renderHibernating();
  }

  function isSelectedVisibleSwitchTarget(): boolean {
    return isSelectedSwitchTargetTerminal() && isVisible();
  }

  function isSelectedSwitchTargetTerminal(): boolean {
    return store.activeTaskId === props.taskId && isCurrentTerminalSwitchTarget();
  }

  function canCompleteSwitchWindowForStatus(status: TerminalViewStatus): boolean {
    if (!switchWindowCompletionPending || !ownsTaskSwitchWindow()) {
      return false;
    }

    if (status === 'ready') {
      if (!isSelectedSwitchTargetTerminal() || !isTerminalLiveRenderReady(status)) {
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
        return false;
      case 'passive-visible':
      case 'hot-hidden-live':
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

  function shouldBlinkTerminalCursor(): boolean {
    return (
      props.isFocused === true &&
      sessionStatus() === 'ready' &&
      presentationMode().kind === 'live' &&
      !hasPeerController() &&
      !renderHibernating() &&
      !restoreBlocked()
    );
  }

  function canAcceptTerminalInput(): boolean {
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
    return managesTaskSwitchWindowLifecycle && store.activeTaskId === props.taskId;
  }

  function ownsTaskSwitchWindow(): boolean {
    return isTerminalSwitchWindowOwner(taskId, switchWindowOwnerId);
  }

  function shouldPinSelectedSurfaceTier(): boolean {
    return (
      isSelectedNow &&
      (props.isFocused === true || (isVisibleNow && isSelectedSwitchTargetTerminal()))
    );
  }

  function getRenderHibernationDelayMs(): number | null {
    switch (surfaceTier()) {
      case 'cold-hidden':
        return getTerminalPerformanceExperimentConfig().hiddenTerminalHibernationDelayMs;
      case 'passive-visible':
        return null;
      case 'hot-hidden-live':
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
    setWebglAddonPriority(agentId, getTerminalWebglPriority(outputPriority()));
    if (props.isFocused === true) {
      touchWebglAddon(agentId);
    }
  }

  function getSwitchPostInputReadyEchoGraceMs(): number {
    return getTerminalExperimentSwitchPostInputReadyEchoGraceMs(getVisibleTerminalCount());
  }

  function prewarmHiddenTerminalIfNeeded(): void {
    terminalSurfaceTierRegistration?.noteIntent();
    armTerminalWakePrewarm();
    if (isFocusedNow || isVisibleNow || isSelectedNow) {
      return;
    }

    const isSessionDormant = untrack(sessionDormant);
    if (isSessionDormant || (!session && !attachRegistration && sessionStartedOnce)) {
      ensureTerminalSessionRegistered();
      return;
    }

    session?.prewarmRenderHibernation?.();
  }

  function cleanupTerminalSessionLifetime(): void {
    setRenderHibernating(false);
    setRestoreBlocked(false);
    session?.cleanup();
    session = undefined;
    attachRegistration?.unregister();
    attachRegistration = undefined;
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
    if (attachRegistration || session) {
      return;
    }

    setSessionDormant(false);
    ensureTerminalAttachTraceEntry(terminalStartupKey, taskId, agentId);
    attachRegistration = registerTerminalAttachCandidate({
      attach: () => {
        updateTerminalAttachTrace(terminalStartupKey, (entry) => {
          entry.attachStartedAtMs = getRoundedPerformanceNow();
          entry.status = 'binding';
        });
        sessionStartedOnce = true;
        session = startTerminalSession({
          canAcceptInput: canAcceptTerminalInput,
          containerRef,
          getOutputPriority: outputPriority,
          getRenderHibernationDelayMs,
          isSelectedRecoveryProtected: isSelectedSwitchTargetTerminal,
          onAttachBound: () => {
            updateTerminalAttachTrace(terminalStartupKey, (entry) => {
              entry.attachBoundAtMs = getRoundedPerformanceNow();
            });
            attachRegistration?.release();
          },
          onBlockedInputAttempt: () => {
            recordTerminalPresentationBlockedInput(presentationMode().kind);
            anomalyMonitorRegistration?.recordInteraction('blocked-input');
          },
          onRenderHibernationChange: setRenderHibernating,
          onReadOnlyInputAttempt: () => {
            anomalyMonitorRegistration?.recordInteraction('read-only-input');
            controlVisualState.expandBanner();
          },
          onRestoreBlockedChange: setRestoreBlocked,
          onSelectedRecoverySettle: () => {
            markTerminalSwitchWindowRecoverySettled(taskId, switchWindowOwnerId);
            requestTerminalOutputDrain();
          },
          onSelectedRecoveryStart: () => {
            markTerminalSwitchWindowRecoveryStarted(taskId, switchWindowOwnerId);
          },
          onShouldKeepRenderLive: shouldKeepTerminalRenderLive,
          onStatusChange: setSessionStatus,
          props,
          shouldCommitResize: shouldKeepTerminalGeometryLive,
        });
        syncCurrentSessionRuntimeState();
      },
      getPriority: attachPriority,
      key: terminalStartupKey,
      taskId,
    });
  }

  function syncTerminalSessionLiveness(): void {
    const hiddenTerminalSessionDormancyDelayMs = getHiddenTerminalSessionDormancyDelayMs();

    if (hiddenTerminalSessionDormancyDelayMs === null) {
      clearSessionDormancyTimer();
      ensureTerminalSessionRegistered();
      return;
    }

    if (!sessionStartedOnce) {
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
    terminalVisibilityRegistration = registerTerminalVisibility(terminalStartupKey, {
      isFocused: isFocusedNow,
      isSelected: isSelectedNow,
      isVisible: isVisibleNow,
    });
    terminalSurfaceTierRegistration = registerTerminalSurfaceTier(terminalStartupKey, {
      isFocused: isFocusedNow,
      isSelected: shouldPinSelectedSurfaceTier(),
      isVisible: isVisibleNow,
    });
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
    surfaceTierCleanup = subscribeTerminalSurfaceTierChanges(bumpSurfaceTierVersion);
    denseOverloadCleanup = subscribeTerminalDenseOverloadChanges(bumpSurfaceTierVersion);
    focusedInputCleanup = subscribeTerminalFocusedInputChanges(bumpSurfaceTierVersion);
    recentHiddenReservationCleanup =
      subscribeTerminalRecentHiddenReservationChanges(bumpSurfaceTierVersion);
    const switchWindowCleanup = subscribeTerminalSwitchWindowChanges(bumpSwitchWindowVersion);
    setIsVisible(isInitiallyFocused || isElementVisibleInViewport(shellRef));

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
      observer?.disconnect();
      clearSessionDormancyTimer();
      cleanupTerminalSessionLifetime();
      cancelSwitchWindowState();
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
      focusedInputCleanup?.();
      focusedInputCleanup = undefined;
      recentHiddenReservationCleanup?.();
      recentHiddenReservationCleanup = undefined;
      switchWindowCleanup();
      clearTerminalRecentHiddenCandidate(terminalStartupKey);
    });
  });

  createEffect(() => {
    const isFocused = props.isFocused === true;
    const isSelected = store.activeTaskId === props.taskId;
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
    }
  });

  createEffect(() => {
    const focused = props.isFocused === true;
    const visible = isVisible();
    const status = sessionStatus();
    const activeTaskId = store.activeTaskId;
    switchWindowVersion();
    isFocusedNow = focused;
    isVisibleNow = visible;
    isSelectedNow = activeTaskId === props.taskId;
    terminalVisibilityRegistration?.update({
      isFocused: isFocusedNow,
      isSelected: isSelectedNow,
      isVisible: isVisibleNow,
    });
    terminalSurfaceTierRegistration?.update({
      isFocused: isFocusedNow,
      isSelected: shouldPinSelectedSurfaceTier(),
      isVisible: isVisibleNow,
    });
    void status;
    syncTerminalSessionLiveness();
  });

  createEffect(() => {
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

  createEffect(() => {
    outputPriority();
    surfaceTier();
    session?.updateOutputPriority?.();
  });

  createEffect(() => {
    const status = sessionStatus();
    switchWindowVersion();

    updateTerminalAttachTrace(terminalStartupKey, (entry) => {
      entry.status = status;
      if (status === 'ready' || status === 'error') {
        entry.readyAtMs = getRoundedPerformanceNow();
      }
    });

    syncTerminalStartupPhaseForStatus(terminalStartupKey, status);

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
    const status = sessionStatus();
    switchWindowVersion();

    if (
      !ownsTaskSwitchWindow() ||
      !isSelectedSwitchTargetTerminal() ||
      !isTerminalLiveRenderReady(status)
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
        isTerminalLiveRenderReady(sessionStatus())
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

  createEffect(() => {
    const size = props.fontSize;
    if (size === undefined || size === null || !session) return;
    session.term.options.fontSize = size;
    markDirty(agentId, 'font-size');
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!session) return;
    session.term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(agentId, 'font-family');
  });

  createEffect(() => {
    const preset = store.themePreset;
    if (!session) return;
    session.term.options.theme = getTerminalTheme(preset);
    markDirty(agentId, 'theme');
  });

  createEffect(() => {
    const focused = props.isFocused === true;
    const masked = shouldMaskLiveTerminalSurface();
    const hibernating = renderHibernating();
    const blocked = restoreBlocked();
    const priority = outputPriority();
    const status = sessionStatus();
    void focused;
    void masked;
    void hibernating;
    void blocked;
    void priority;
    void status;
    if (!session) return;
    syncCurrentSessionRuntimeState();
  });

  createEffect(() => {
    const shouldMaskSurface = shouldMaskLiveTerminalSurface();
    if (!session || !shouldMaskSurface) {
      return;
    }

    session.term.blur?.();
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
    return sessionStatus() === 'ready' && isVisible() && presentationMode().kind === 'live';
  });
  const shouldMaskLiveTerminalSurface = createMemo(() => {
    return shouldMaskTerminalPresentationMode(presentationMode());
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
    const peerControlled = hasPeerController();
    const liveReady = isLiveRenderReady();
    const mode = presentationMode().kind;
    void status;
    void visible;
    void dormant;
    void hibernating;
    void blocked;
    void peerControlled;
    void liveReady;
    void mode;
    anomalyMonitorRegistration?.updateLifecycle(getCurrentTerminalAnomalyLifecycleState());
  });

  return (
    <div
      ref={shellRef}
      data-terminal-agent-id={props.agentId}
      data-terminal-anomaly-count={
        terminalAnomalies().length > 0 ? String(terminalAnomalies().length) : undefined
      }
      data-terminal-anomaly-kinds={terminalAnomalyKinds() ?? undefined}
      data-terminal-anomaly-severity={terminalAnomalySeverity() ?? undefined}
      data-terminal-cursor-blink={shouldBlinkTerminalCursor() ? 'true' : undefined}
      data-terminal-dormant={sessionDormant() ? 'true' : undefined}
      data-terminal-render-hibernating={renderHibernating() ? 'true' : undefined}
      data-terminal-restore-blocked={restoreBlocked() ? 'true' : undefined}
      data-terminal-live-render-ready={isLiveRenderReady() ? 'true' : undefined}
      data-terminal-presentation-mode={presentationMode().kind}
      data-terminal-surface-tier={surfaceTier()}
      data-terminal-status={sessionStatus()}
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
      <Show when={isTerminalAnomalyMonitorEnabled() && terminalAnomalyLabel()}>
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
                terminalAnomalySeverity() === 'error'
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
