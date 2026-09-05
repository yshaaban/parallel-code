import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITerminalAddon } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { openMarkdownViewer } from '../../app/markdown-viewer';
import {
  isTaskCommandLeaseSkipped,
  runWithTaskCommandLease,
} from '../../app/task-command-lease-session';
import { isFailedProcessExit } from '../../domain/process-exit';
import type {
  AttachTerminalSessionResult,
  AttachTerminalSessionRequest,
  TerminalSessionOwner,
} from '../../domain/renderer-invoke';
import {
  Channel,
  fireAndForget,
  getBrowserTransportConnectionState,
  invoke,
  isBrowserControlAuthenticated,
  isElectronRuntime,
  listenServerMessage,
  markBrowserChannelBound,
  onBrowserAuthenticated,
  onBrowserTransportEvent,
  sendPagehideInvoke,
} from '../../lib/ipc';
import {
  ensureBrowserPagehideTracking,
  isBrowserPagehidePending,
} from '../../lib/browser-pagehide';
import { getBrowserChannelMessageTiming } from '../../lib/browser-channel-client';
import { tryDecodeBase64ToUint8Array } from '../../lib/base64';
import { dispatchByType, type DispatchByTypeHandlerMap } from '../../lib/dispatch-by-type';
import { assertNever } from '../../lib/assert-never';
import { getTerminalFontFamily } from '../../lib/fonts';
import {
  detectProbeInOutput,
  getTerminalTraceTimestampMs,
  hasTerminalTraceClockAlignment,
  hasPendingProbes,
  recordOutputReceived,
} from '../../lib/terminalLatency';
import {
  recordTerminalRenderEvent,
  recordTerminalRenderResize,
} from '../../lib/terminal-output-diagnostics';
import { createTerminalFitLifecycle } from '../../lib/terminalFitLifecycle';
import {
  registerTerminal,
  scheduleFitIfDirty,
  unregisterTerminal,
} from '../../lib/terminalFitManager';
import { getTerminalShortcutAction } from '../../lib/terminal-shortcuts';
import { cleanCopiedTerminalText } from '../../lib/copy-text';
import {
  dataTransferHasFiles,
  dataTransferToTerminalPaste,
  escapeTerminalPath,
} from '../../lib/terminal-drop';
import { matchesDialogSafeShortcut, matchesGlobalShortcut } from '../../lib/shortcuts';
import { alignTerminalDomRendererWidthMetricsWithWebgl } from '../../lib/terminal-renderer-metrics';
import { computeTerminalMarkdownLinks } from '../../lib/terminal-links';
import { getTerminalSearchDecorationTheme, getTerminalTheme } from '../../lib/theme';
import {
  acquireWebglAddon,
  isWebglAddonRuntimeReady,
  preloadWebglAddon,
  releaseWebglAddon,
  setWebglAddonPriority,
  touchWebglAddon,
} from '../../lib/webglPool';
import { isMac } from '../../lib/platform';
import {
  getTerminalExperimentStartupSkipNonSelectedVisibleSessionRafFit,
  getTerminalExperimentStartupVisibleSiblingSessionFitGateUntilSelectedPaintReady,
  getTerminalExperimentVisibleWebglAcquisitionMode,
  getTerminalExperimentVisibleWebglContextLimit,
} from '../../lib/terminal-performance-experiments';
import {
  recordTerminalFitExecution,
  recordTerminalFitSchedule,
  recordTerminalRendererSwap,
  type TerminalFitExecutionSource,
  type TerminalFitScheduleReason,
} from '../../app/runtime-diagnostics';
import {
  shouldYieldToTerminalInteractivity,
  subscribeTerminalInteractivityChanges,
} from '../../app/terminal-interactivity-governor';
import { setTerminalFocusedChannel } from '../../app/terminal-focused-channels';
import { showNotification } from '../../store/notification';
import { store } from '../../store/store';
import {
  getTaskCommandController,
  subscribeTaskCommandControllerChanges,
} from '../../store/task-command-controllers';
import { getRuntimeClientId } from '../../lib/runtime-client-id';
import {
  completeCompatibilityTerminalCreation,
  isCompatibilityTerminalCreationPending,
} from '../../runtime/compatibility-terminal-creation';
import {
  createTerminalSearchRuntime,
  type TerminalSearchCapability,
  type TerminalSearchResult,
} from './terminal-search-runtime';
import type { PtyExitData, PtyOutput } from '../../ipc/types';
import { createTerminalInputPipeline } from './terminal-input-pipeline';
import { createTerminalOutputPipeline } from './terminal-output-pipeline';
import { createTerminalRenderHibernationController } from './terminal-render-hibernation';
import {
  createTerminalRecoveryRuntime,
  type TerminalRecoveryRuntime,
} from './terminal-recovery-runtime';
import {
  getTerminalRestoreUnavailableMessage,
  type TerminalSessionAttachUnavailableReason,
  type TerminalViewProps,
  type TerminalViewStatus,
} from './types';
import {
  getTerminalWebglPriority,
  type TerminalOutputPriority,
} from '../../lib/terminal-output-priority';

const INITIAL_COMMAND_DELAY_MS = 50;
const DEFAULT_READY_FALLBACK_DELAY_MS = 500;
const SELECTED_READY_FALLBACK_DELAY_MS = 150;
const PROBE_TEXT_DECODER = new TextDecoder();
const TASK_CONTROLLED_AGENT_ERROR_MESSAGE = 'Task is controlled by another client';
const TERMINAL_LETTER_SPACING = 0;
const TERMINAL_LINE_HEIGHT = 1;
type TerminalFitEnsureReason = 'attach' | 'renderer-loss' | 'restore' | 'spawn-ready';
type TerminalWebLinksAddonConstructor = new (
  handler: (event: MouseEvent, uri: string) => void,
) => ITerminalAddon;
interface TerminalGeometry {
  cols: number;
  rows: number;
}

function resolveTerminalSessionOwner(
  sessionOwner: TerminalSessionOwner | undefined,
  arenaLaunchToken: string | undefined,
  isShell: boolean | undefined,
): TerminalSessionOwner {
  if (sessionOwner) return sessionOwner;
  if (arenaLaunchToken !== undefined) return 'arena-transient';
  return isShell === true ? 'compatibility-shell' : 'managed-agent';
}

let terminalWebLinksAddonConstructor: TerminalWebLinksAddonConstructor | null = null;
let terminalWebLinksAddonLoadPromise: Promise<TerminalWebLinksAddonConstructor> | null = null;

function loadTerminalWebLinksAddonConstructor(): Promise<TerminalWebLinksAddonConstructor> {
  if (terminalWebLinksAddonConstructor) {
    return Promise.resolve(terminalWebLinksAddonConstructor);
  }

  terminalWebLinksAddonLoadPromise ??= import('@xterm/addon-web-links')
    .then((module) => {
      terminalWebLinksAddonConstructor = module.WebLinksAddon;
      return module.WebLinksAddon;
    })
    .catch((error: unknown) => {
      terminalWebLinksAddonLoadPromise = null;
      throw error;
    });

  return terminalWebLinksAddonLoadPromise;
}

if (typeof window !== 'undefined') {
  // Preload at module load so terminal attach never awaits the dynamic
  // web-links addon import on its critical path.
  void loadTerminalWebLinksAddonConstructor().catch(() => {});
}

function getInitialRecoveryTransportState(
  browserMode: boolean,
): 'connected' | 'disconnected' | 'reconnecting' {
  if (!browserMode) {
    return 'disconnected';
  }

  const connectionState = getBrowserTransportConnectionState();
  if (connectionState === 'connected' || connectionState === 'reconnecting') {
    return connectionState;
  }

  return 'disconnected';
}

function getReadyFallbackDelayMs(
  startupPaintRole: 'hidden' | 'selected' | 'visible-sibling' | undefined,
): number {
  if (startupPaintRole === 'selected') {
    return SELECTED_READY_FALLBACK_DELAY_MS;
  }

  return DEFAULT_READY_FALLBACK_DELAY_MS;
}

// Exit lines carry the real exit metadata: failed exits (shared
// isFailedProcessExit semantics) render red with the code or signal, clean
// exits and synthetic server_unavailable exits stay on the plain gray line.
export function formatTerminalExitLine(payload: PtyExitData): string {
  const failed = isFailedProcessExit(payload.exit_code, payload.signal);
  const color = failed ? '\x1b[31m' : '\x1b[90m';
  let detail = '';
  if (typeof payload.exit_code === 'number' && payload.exit_code !== 0) {
    detail = `: code ${payload.exit_code}`;
  } else if (
    typeof payload.signal === 'string' &&
    payload.signal.length > 0 &&
    payload.signal !== 'server_unavailable'
  ) {
    detail = `: signal ${payload.signal}`;
  }

  return `\r\n${color}[Process exited${detail}]\x1b[0m\r\n`;
}

function decodeTerminalOutputData(
  data: Extract<PtyOutput, { type: 'Data' }>['data'],
): Uint8Array | null {
  if (typeof data !== 'string') {
    return data;
  }

  const decoded = tryDecodeBase64ToUint8Array(data);
  if (decoded === null) {
    console.warn(
      '[terminal] Ignoring malformed terminal output payload',
      new Error('Invalid base64 payload'),
    );
    return null;
  }

  return decoded;
}

function shouldAcquireTerminalWebglRenderer(priority: TerminalOutputPriority): boolean {
  switch (priority) {
    case 'focused':
      return true;
    case 'switch-target-visible':
    case 'active-visible':
    case 'visible-background':
      return getTerminalExperimentVisibleWebglAcquisitionMode() === 'visible-set';
    case 'hidden':
      return false;
    default:
      return assertNever(priority, 'Unhandled terminal WebGL acquisition priority');
  }
}

function shouldRetainTerminalWebglRenderer(priority: TerminalOutputPriority): boolean {
  switch (priority) {
    case 'focused':
    case 'switch-target-visible':
    case 'active-visible':
    case 'visible-background':
      return true;
    case 'hidden':
      return false;
  }
}

function getTerminalVisibleWebglAcquisitionLimit(
  priority: TerminalOutputPriority,
): number | undefined {
  switch (priority) {
    case 'switch-target-visible':
    case 'active-visible':
    case 'visible-background':
      if (getTerminalExperimentVisibleWebglAcquisitionMode() !== 'visible-set') {
        return undefined;
      }

      return getTerminalExperimentVisibleWebglContextLimit();
    case 'focused':
    case 'hidden':
      return undefined;
    default:
      return assertNever(priority, 'Unhandled terminal visible WebGL limit priority');
  }
}

function getViewportScale(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.visualViewport?.scale ?? null;
}

function shouldOpenTerminalLink(event: MouseEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

function registerTerminalMarkdownLinkProvider(
  term: Terminal,
  props: TerminalViewProps,
  isCurrentSession: () => boolean,
): { dispose: () => void } {
  const agentId = props.agentId;
  const taskId = props.taskId;
  const worktreePath = props.cwd.trim();

  return term.registerLinkProvider({
    provideLinks(lineNumber, callback): void {
      if (!isCurrentSession() || worktreePath.length === 0) {
        callback(undefined);
        return;
      }

      const links = computeTerminalMarkdownLinks(term.buffer.active, lineNumber, worktreePath);
      if (links.length === 0) {
        callback(undefined);
        return;
      }

      callback(
        links.map((link) => ({
          activate(event: MouseEvent): void {
            if (!shouldOpenTerminalLink(event) || !isCurrentSession()) {
              return;
            }

            void openMarkdownViewer({
              agentId,
              relativePath: link.relativePath,
              taskId,
            });
          },
          range: link.range,
          text: link.text,
        })),
      );
    },
  });
}

function openTerminalLink(uri: string): void {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.open(uri, '_blank', 'noopener');
    }
  } catch {
    // ignore invalid URL
  }
}

export interface TerminalSession {
  cleanup(): void;
  fitAddon: FitAddon;
  flushPendingResize(): Promise<void>;
  handleTerminalData(data: string): void;
  isRestoreBlocked(): boolean;
  prefetchInputLease(): void;
  prewarmRenderHibernation(): void;
  requestInputTakeover(): Promise<boolean>;
  retryAttach(): void;
  search: TerminalSearchCapability;
  term: Terminal;
  updateOutputPriority(): void;
}

export type TerminalAttachMilestone =
  | 'attach-requested'
  | 'attach-resolved'
  | 'attach-fit-ready'
  | 'attach-recovery-settled'
  | 'attach-recovery-started'
  | 'channel-ready';

type TerminalAttachInvocation =
  | { kind: 'dispatched'; result: unknown }
  | { kind: 'settled-without-dispatch'; reason: 'cancelled' | 'task-control-unavailable' };

export interface StartTerminalSessionOptions {
  canAcceptInput?: () => boolean;
  canBufferInputWhileInteractionPending?: () => boolean;
  containerRef: HTMLDivElement;
  outputChannel?: Channel<PtyOutput>;
  getOutputPriority: () => TerminalOutputPriority;
  getStartupPaintRole?: () => 'hidden' | 'selected' | 'visible-sibling';
  getRenderHibernationDelayMs?: () => number | null;
  getStartupPaintCoordinationSnapshot?: () => {
    hiddenPendingCount: number;
    hiddenReadyCount: number;
    selectedPaintReady: boolean;
    selectedPendingCount: number;
    visiblePendingCount: number;
    visibleReadyCount: number;
  };
  isSelectedRecoveryProtected?: () => boolean;
  onAttachBound?: () => void;
  // Fires when the attach RPC has been DISPATCHED (not resolved); the attach
  // scheduler releases its slot here so slots only guard CPU phases, never
  // network waits.
  onAttachDispatched?: () => void;
  // A lease refusal or pre-dispatch cancellation settles the scheduler slot
  // without claiming that an RPC was sent.
  onAttachSettledWithoutDispatch?: () => void;
  onAttachMilestone?: (milestone: TerminalAttachMilestone) => void;
  onAttachUnavailable?: (reason: TerminalSessionAttachUnavailableReason | null) => void;
  onBlockedInputAttempt?: () => void;
  onInputAccepted?: () => void;
  onLocalInputFeedback?: (data: string) => void;
  onOutputRendered?: (byteLength: number) => void;
  onPaintReadyChange?: (isPaintReady: boolean) => void;
  onStartupFitExecuted?: (details: {
    geometryChanged: boolean;
    source: TerminalFitExecutionSource;
  }) => void;
  onStartupFitScheduled?: (reason: TerminalFitScheduleReason) => void;
  onStartupRenderEvent?: () => void;
  onStartupWriteRendered?: (byteLength: number) => void;
  onRenderHibernationChange?: (isHibernating: boolean) => void;
  onReadOnlyInputAttempt?: () => void;
  onRestoreBlockedChange?: (isBlocked: boolean) => void;
  onResizeTransactionChange?: (isActive: boolean) => void;
  onSearchRequested?: (sessionIdentity: string, capability: TerminalSearchCapability) => void;
  onSearchResult?: (
    sessionIdentity: string,
    capability: TerminalSearchCapability,
    result: TerminalSearchResult,
  ) => void;
  onSearchUnavailable?: (sessionIdentity: string, capability: TerminalSearchCapability) => void;
  onSelectedRecoverySettle?: () => void;
  onSelectedRecoveryStart?: () => void;
  onShouldKeepRenderLive?: () => boolean;
  onStatusChange?: (status: TerminalViewStatus) => void;
  props: TerminalViewProps;
  sessionIdentity?: string;
  subscribeStartupPaintCoordinationChanges?: (listener: () => void) => () => void;
  shouldCommitResize?: () => boolean;
}

function shouldTrackKeyboardEvent(event: KeyboardEvent): boolean {
  if (event.isComposing) {
    return false;
  }

  switch (event.key) {
    case 'Alt':
    case 'CapsLock':
    case 'Control':
    case 'Fn':
    case 'Meta':
    case 'NumLock':
    case 'ScrollLock':
    case 'Shift':
      return false;
    default:
      return true;
  }
}

function getWindowDevicePixelRatio(fallbackDevicePixelRatio: number): number {
  if (typeof window === 'undefined') {
    return fallbackDevicePixelRatio;
  }

  return window.devicePixelRatio ?? 1;
}

export function startTerminalSession(options: StartTerminalSessionOptions): TerminalSession {
  const { containerRef, onReadOnlyInputAttempt, onStatusChange, props } = options;
  const taskId = props.taskId;
  const agentId = props.agentId;
  const initialFontSize = props.fontSize ?? store.terminalFontSize;
  const browserMode = !isElectronRuntime();
  const runtimeClientId = getRuntimeClientId();
  const sessionOwner = resolveTerminalSessionOwner(
    props.sessionOwner,
    props.arenaLaunchToken,
    props.isShell,
  );
  const sessionIdentity = options.sessionIdentity ?? `${taskId}:${agentId}`;
  const cleanupCallbacks: Array<() => void> = [];
  const outputChannel = options.outputChannel ?? new Channel<PtyOutput>();

  if (browserMode) {
    ensureBrowserPagehideTracking();
  }

  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: getTerminalFontFamily(store.terminalFont),
    fontSize: initialFontSize,
    letterSpacing: TERMINAL_LETTER_SPACING,
    lineHeight: TERMINAL_LINE_HEIGHT,
    scrollback: 3000,
    theme: getTerminalTheme(store.themePreset),
  });
  const fitAddon = new FitAddon();
  const searchRuntime = createTerminalSearchRuntime({
    onResult: (result) => {
      options.onSearchResult?.(sessionIdentity, searchRuntime, result);
    },
    onUnavailable: () => {
      options.onSearchUnavailable?.(sessionIdentity, searchRuntime);
    },
    term,
  });
  searchRuntime.setDecorationTheme(getTerminalSearchDecorationTheme(store.themePreset));

  let browserTransportCleanup: (() => void) | undefined;
  let browserTransportConnectionState:
    | 'auth-expired'
    | 'connected'
    | 'connecting'
    | 'disconnected'
    | 'reconnecting' = browserMode ? getInitialRecoveryTransportState(browserMode) : 'disconnected';
  let currentStatus: TerminalViewStatus = 'binding';
  let deferredControllerId: string | null | undefined;
  let disposed = false;
  let fitReady = false;
  let initialCommandSent = false;
  let initialCommandTimer: number | undefined;
  let pendingExitPayload: PtyExitData | null = null;
  let processExited = false;
  let readyFallbackTimer: number | undefined;
  let readyRequested = false;
  let hasObservedLocalInput = false;
  let spawnReady = false;
  let attachBound = false;
  let recoveryRuntime: TerminalRecoveryRuntime | null = null;
  let hasDeferredSessionFitStabilization = false;
  let wasYieldingToInteractivity = shouldYieldToTerminalInteractivity(taskId, agentId);
  let lastKnownDevicePixelRatio = getWindowDevicePixelRatio(1);
  let lastKnownViewportScale = getViewportScale();
  let paintReady = false;
  let paintReadyGeneration = 0;
  let pendingPaintReadyGeneration = 0;
  let pendingPaintReadySettleFrame: number | undefined;
  let renderedSincePaintReadyReset = false;
  let selectedAttachRecoveryPending = false;
  let webglRendererActive = false;
  let webglRendererAttachedOnce = false;
  let webglRendererLoadPending = false;

  function setPaintReady(nextPaintReady: boolean): void {
    if (paintReady === nextPaintReady) {
      return;
    }

    paintReady = nextPaintReady;
    options.onPaintReadyChange?.(nextPaintReady);
  }

  function clearPendingPaintReadySettleFrame(): void {
    if (pendingPaintReadySettleFrame === undefined) {
      return;
    }

    cancelAnimationFrame(pendingPaintReadySettleFrame);
    pendingPaintReadySettleFrame = undefined;
  }

  function resetPaintReady(): void {
    pendingPaintReadyGeneration = 0;
    clearPendingPaintReadySettleFrame();
    renderedSincePaintReadyReset = false;
    setPaintReady(false);
  }

  function schedulePaintReadySettleFrame(): void {
    if (
      pendingPaintReadyGeneration === 0 ||
      pendingPaintReadySettleFrame !== undefined ||
      disposed ||
      currentStatus !== 'ready' ||
      renderHibernation.isHibernating() ||
      isRestoreBlockingRenderHibernation()
    ) {
      return;
    }

    const renderGeneration = pendingPaintReadyGeneration;
    pendingPaintReadySettleFrame = requestAnimationFrame(() => {
      pendingPaintReadySettleFrame = undefined;
      if (
        disposed ||
        renderGeneration !== pendingPaintReadyGeneration ||
        currentStatus !== 'ready' ||
        renderHibernation.isHibernating() ||
        isRestoreBlockingRenderHibernation()
      ) {
        return;
      }

      pendingPaintReadyGeneration = 0;
      setPaintReady(true);
      renderedSincePaintReadyReset = false;
    });
  }

  function beginAwaitingPaintReady(): void {
    paintReadyGeneration += 1;
    pendingPaintReadyGeneration = paintReadyGeneration;
    clearPendingPaintReadySettleFrame();
    setPaintReady(false);
    if (renderedSincePaintReadyReset) {
      schedulePaintReadySettleFrame();
    }
  }

  function settlePaintReadyAfterRender(): void {
    schedulePaintReadySettleFrame();
  }

  function setStatus(status: TerminalViewStatus): void {
    const previousStatus = currentStatus;
    currentStatus = status;
    if (status === 'ready') {
      if (previousStatus !== 'ready') {
        beginAwaitingPaintReady();
      }
    } else {
      resetPaintReady();
    }
    syncWebglRendererPolicy();
    onStatusChange?.(status);
  }

  function markAttachBound(): void {
    if (attachBound) {
      return;
    }

    attachBound = true;
    options.onAttachBound?.();
  }

  function markLocalInputObserved(): void {
    hasObservedLocalInput = true;
  }

  function getOutputPriority(): TerminalOutputPriority {
    return options.getOutputPriority();
  }

  function syncFocusedChannelRegistration(): void {
    const outputPriority = getOutputPriority();
    setTerminalFocusedChannel(
      agentId,
      outputChannel.id,
      outputPriority === 'focused' || outputPriority === 'switch-target-visible',
    );
  }

  function getRenderHibernationDelayMs(): number | null {
    return options.getRenderHibernationDelayMs?.() ?? null;
  }

  function isRestoreBlockingRenderHibernation(): boolean {
    return selectedAttachRecoveryPending || recoveryRuntime?.isRestoreBlocked() === true;
  }

  function syncRenderHibernationAfterIdle(): void {
    flushPendingExitWhenIdle();
    renderHibernation.sync();
  }

  function handleResizeTransactionChange(active: boolean): void {
    syncWebglRendererPolicy();
    options.onResizeTransactionChange?.(active);
    if (!active) {
      runDeferredSessionFitStabilization();
      scheduleFitIfDirty(agentId);
    }
  }

  function clearReadyFallback(): void {
    if (readyFallbackTimer === undefined) {
      return;
    }

    clearTimeout(readyFallbackTimer);
    readyFallbackTimer = undefined;
  }

  function clearInitialCommandTimer(): void {
    if (initialCommandTimer === undefined) {
      return;
    }

    window.clearTimeout(initialCommandTimer);
    initialCommandTimer = undefined;
  }

  function flushReadyState(): void {
    if (disposed || !readyRequested || !fitReady || isRestoreBlockingRenderHibernation()) {
      return;
    }

    readyRequested = false;
    clearReadyFallback();
    setStatus('ready');
    runDeferredSessionFitStabilization();
  }

  function runTerminalFit(source: TerminalFitExecutionSource): {
    geometryChanged: boolean;
    source: TerminalFitExecutionSource;
  } {
    const previousCols = term.cols;
    const previousRows = term.rows;
    fitAddon.fit();
    const fitDetails = {
      geometryChanged: previousCols !== term.cols || previousRows !== term.rows,
      source,
    };
    recordTerminalFitExecution(fitDetails);
    options.onStartupFitExecuted?.(fitDetails);
    return fitDetails;
  }

  function canRunSessionFitStabilization(): boolean {
    return (
      currentStatus === 'ready' &&
      !isRestoreBlockingRenderHibernation() &&
      options.shouldCommitResize?.() !== false &&
      !inputPipeline.isResizeTransactionPending() &&
      !shouldDeferVisibleSiblingSessionFitStabilization() &&
      !shouldYieldSessionFitToInteractivity()
    );
  }

  function shouldYieldSessionFitToInteractivity(): boolean {
    return shouldYieldToTerminalInteractivity(taskId, agentId);
  }

  function runSessionFitStabilizationCycle(): void {
    const immediateFit = runTerminalFit('session-immediate');
    if (!immediateFit.geometryChanged) {
      return;
    }

    if (shouldSkipNonSelectedVisibleSessionRafFit()) {
      return;
    }

    requestAnimationFrame(() => {
      if (!disposed && canRunSessionFitStabilization()) {
        runTerminalFit('session-raf');
      }
    });
  }

  function shouldSkipNonSelectedVisibleSessionRafFit(): boolean {
    if (!getTerminalExperimentStartupSkipNonSelectedVisibleSessionRafFit()) {
      return false;
    }

    if (paintReady) {
      return false;
    }

    const startupRole = options.getStartupPaintRole?.();
    return startupRole === 'visible-sibling';
  }

  function shouldDeferVisibleSiblingSessionFitStabilization(): boolean {
    if (!getTerminalExperimentStartupVisibleSiblingSessionFitGateUntilSelectedPaintReady()) {
      return false;
    }

    if (options.getStartupPaintRole?.() !== 'visible-sibling') {
      return false;
    }

    const startupPaintSnapshot = options.getStartupPaintCoordinationSnapshot?.();
    if (!startupPaintSnapshot) {
      return false;
    }

    return startupPaintSnapshot.selectedPaintReady !== true;
  }

  function requestWebglRendererRuntime(): void {
    if (webglRendererLoadPending || isWebglAddonRuntimeReady()) {
      return;
    }

    webglRendererLoadPending = true;
    void preloadWebglAddon()
      .then(() => {
        webglRendererLoadPending = false;
        syncWebglRendererPolicy();
      })
      .catch(() => {
        webglRendererLoadPending = false;
      });
  }

  function syncWebglRendererPolicy(): void {
    if (disposed) {
      return;
    }

    const outputPriority = getOutputPriority();
    const shouldUseWebglRenderer =
      currentStatus === 'ready' &&
      !isRestoreBlockingRenderHibernation() &&
      (shouldAcquireTerminalWebglRenderer(outputPriority) ||
        (webglRendererActive && shouldRetainTerminalWebglRenderer(outputPriority)));
    if (!shouldUseWebglRenderer) {
      if (webglRendererActive) {
        releaseWebglAddon(agentId);
        webglRendererActive = false;
      }
      return;
    }

    if (!webglRendererActive && !shouldAcquireTerminalWebglRenderer(outputPriority)) {
      return;
    }

    if (!webglRendererActive && inputPipeline.isResizeTransactionPending()) {
      return;
    }

    if (!webglRendererActive && !isWebglAddonRuntimeReady()) {
      requestWebglRendererRuntime();
      return;
    }

    if (webglRendererActive) {
      const webglPriority = getTerminalWebglPriority(outputPriority);
      const visibleContextLimit = getTerminalVisibleWebglAcquisitionLimit(outputPriority);
      const retained =
        visibleContextLimit === undefined
          ? setWebglAddonPriority(agentId, webglPriority)
          : setWebglAddonPriority(agentId, webglPriority, { visibleContextLimit });
      if (retained === false) {
        webglRendererActive = false;
        return;
      }

      if (outputPriority === 'focused') {
        touchWebglAddon(agentId);
      }
      return;
    }

    const webglPriority = getTerminalWebglPriority(outputPriority);
    const visibleContextLimit = getTerminalVisibleWebglAcquisitionLimit(outputPriority);
    const handleRendererLost = (): void => {
      void recoveryRuntime?.restoreTerminalOutput('renderer-loss');
    };
    const addon =
      visibleContextLimit === undefined
        ? acquireWebglAddon(agentId, term, handleRendererLost, webglPriority)
        : acquireWebglAddon(agentId, term, handleRendererLost, webglPriority, {
            visibleContextLimit,
          });
    if (!addon) {
      webglRendererActive = false;
      return;
    }

    webglRendererActive = true;
    if (webglRendererAttachedOnce) {
      return;
    }

    webglRendererAttachedOnce = true;
    recordTerminalRendererSwap('attach');
  }

  function runDeferredSessionFitStabilization(): void {
    if (disposed || !fitReady || !hasDeferredSessionFitStabilization) {
      return;
    }

    if (!canRunSessionFitStabilization()) {
      return;
    }

    hasDeferredSessionFitStabilization = false;
    runSessionFitStabilizationCycle();
  }

  function applyCommittedResizeFit(geometry: TerminalGeometry): void {
    if (disposed) {
      return;
    }

    const proposedGeometry = fitAddon.proposeDimensions();
    if (!proposedGeometry) {
      return;
    }

    if (proposedGeometry.cols !== geometry.cols || proposedGeometry.rows !== geometry.rows) {
      return;
    }

    if (term.cols === geometry.cols && term.rows === geometry.rows) {
      return;
    }

    runTerminalFit('resize-commit');
  }

  function scheduleTerminalFitStabilization(reason: TerminalFitScheduleReason): void {
    recordTerminalFitSchedule(reason);
    options.onStartupFitScheduled?.(reason);
    if (fitReady) {
      if (!canRunSessionFitStabilization()) {
        hasDeferredSessionFitStabilization = true;
        return;
      }

      runSessionFitStabilizationCycle();
      return;
    }

    fitLifecycle.scheduleStabilize();
  }

  function shouldSkipAttachStartupRestoreFitStabilization(
    reason: TerminalFitEnsureReason,
  ): boolean {
    return reason === 'restore' && fitReady && currentStatus === 'attaching';
  }

  function handleViewportMetricsChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }

    const nextDevicePixelRatio = getWindowDevicePixelRatio(lastKnownDevicePixelRatio);
    const nextViewportScale = getViewportScale();
    if (
      nextDevicePixelRatio === lastKnownDevicePixelRatio &&
      nextViewportScale === lastKnownViewportScale
    ) {
      return;
    }

    lastKnownDevicePixelRatio = nextDevicePixelRatio;
    lastKnownViewportScale = nextViewportScale;
    scheduleTerminalFitStabilization('visibility');
  }

  async function ensureTerminalFitReady(reason: TerminalFitEnsureReason): Promise<boolean> {
    if (!shouldSkipAttachStartupRestoreFitStabilization(reason)) {
      scheduleTerminalFitStabilization(reason);
    }
    const ready = await fitLifecycle.ensureReady();
    fitReady = ready;
    if (!fitReady) {
      return false;
    }

    await inputPipeline.flushPendingResize();
    flushReadyState();
    if (!isRestoreBlockingRenderHibernation() && outputPipeline.hasQueuedOutput()) {
      outputPipeline.scheduleOutputFlush();
    }
    return true;
  }

  async function waitForTerminalFitReady(reason: TerminalFitEnsureReason): Promise<boolean> {
    while (!disposed) {
      if (await ensureTerminalFitReady(reason)) {
        return true;
      }
    }

    return false;
  }

  function markTerminalReady(): void {
    if (disposed) {
      return;
    }

    const wasReadyRequested = readyRequested;
    readyRequested = true;
    flushReadyState();
    if (readyRequested && !wasReadyRequested) {
      scheduleTerminalFitStabilization('ready');
    }
    flushDeferredControllerChange();
  }

  function shouldDeferControllerChange(controllerId: string | null): boolean {
    if (!browserMode) {
      return false;
    }

    if (controllerId === null || controllerId === runtimeClientId) {
      return false;
    }

    return (
      browserTransportConnectionState !== 'connected' ||
      (recoveryRuntime?.isRestoreBlocked() ?? false)
    );
  }

  function flushDeferredControllerChange(): void {
    if (deferredControllerId === undefined) {
      return;
    }

    if (shouldDeferControllerChange(deferredControllerId)) {
      return;
    }

    const nextControllerId = deferredControllerId;
    deferredControllerId = undefined;
    inputPipeline.handleControllerChange(nextControllerId);
  }

  function handleTaskCommandControllerChange(controllerId: string | null): void {
    if (controllerId === runtimeClientId) {
      deferredControllerId = undefined;
      inputPipeline.handleControllerChange(controllerId);
      inputPipeline.flushPendingInput();
      inputPipeline.drainInputQueue();
      return;
    }

    if (shouldDeferControllerChange(controllerId)) {
      deferredControllerId = controllerId;
      return;
    }

    deferredControllerId = undefined;
    inputPipeline.handleControllerChange(controllerId);
  }

  function scheduleReadyFallback(): void {
    if (readyFallbackTimer !== undefined || disposed) {
      return;
    }

    const readyFallbackDelayMs = getReadyFallbackDelayMs(options.getStartupPaintRole?.());
    readyFallbackTimer = window.setTimeout(() => {
      readyFallbackTimer = undefined;
      markTerminalReady();
    }, readyFallbackDelayMs);
  }

  function emitExit(payload: PtyExitData): void {
    processExited = true;
    term.write(formatTerminalExitLine(payload));
    props.onExit?.(payload);
  }

  async function copySelectionToClipboard(): Promise<void> {
    const selection = term.getSelection();
    if (!selection) {
      return;
    }
    const cleanedSelection = cleanCopiedTerminalText(selection);

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(cleanedSelection);
        term.clearSelection();
        return;
      } catch (error) {
        console.warn('[terminal] Failed to write clipboard text', error);
      }
    }

    try {
      if (document.execCommand('copy')) {
        term.clearSelection();
        return;
      }
    } catch (error) {
      console.warn('[terminal] execCommand(copy) failed', error);
    }

    showNotification('Copy failed. Use your browser copy shortcut or the context menu.');
  }

  function handleCopy(event: ClipboardEvent): void {
    const selection = term.getSelection();
    if (!selection || !event.clipboardData) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData('text/plain', cleanCopiedTerminalText(selection));
    queueMicrotask(() => term.clearSelection());
  }

  async function pasteTerminalInput(data: string): Promise<void> {
    inputPipeline.setNextProgrammaticInputTrace(data);
    term.paste(data);
  }

  async function pasteFromClipboard(): Promise<void> {
    try {
      if (isElectronRuntime()) {
        const clipboardPaste = await invoke(IPC.ResolveClipboardPaste);

        switch (clipboardPaste.kind) {
          case 'file':
          case 'image':
            await pasteTerminalInput(escapeTerminalPath(clipboardPaste.path));
            return;
          case 'text':
            await pasteTerminalInput(clipboardPaste.text);
            return;
          case 'empty':
            return;
        }
      }

      if (!navigator.clipboard?.readText) {
        showNotification('Paste failed. Use your browser paste shortcut or the context menu.');
        return;
      }

      const text = await navigator.clipboard.readText();
      if (text) {
        await pasteTerminalInput(text);
      }
    } catch (error) {
      console.warn('[terminal] Failed to read clipboard text', error);
      showNotification('Paste failed. Use your browser paste shortcut or the context menu.');
    }
  }

  function handleDragOver(event: DragEvent): void {
    if (!dataTransferHasFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  function handleDrop(event: DragEvent): void {
    if (!event.dataTransfer || event.dataTransfer.files.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const dataTransfer = event.dataTransfer;

    void (async () => {
      const droppedText = await dataTransferToTerminalPaste(dataTransfer, {
        resolveFilePath: window.electron?.getPathForFile,
        saveDroppedFile: isElectronRuntime()
          ? (request) => invoke(IPC.SaveDroppedImage, request)
          : undefined,
      });
      if (!droppedText) {
        return;
      }

      term.focus();
      await pasteTerminalInput(droppedText);
    })().catch((error: unknown) => {
      console.warn('[terminal] Failed to handle dropped files', error);
    });
  }

  function flushPendingExitWhenIdle(): void {
    if (
      !pendingExitPayload ||
      outputPipeline.hasWriteInFlight() ||
      outputPipeline.hasQueuedOutput()
    ) {
      return;
    }

    const exitPayload = pendingExitPayload;
    pendingExitPayload = null;
    emitExit(exitPayload);
  }

  const fitLifecycle = createTerminalFitLifecycle({
    fit: () => {
      runTerminalFit('lifecycle');
    },
    getMeasuredSize: () => ({
      height: containerRef.clientHeight,
      width: containerRef.clientWidth,
    }),
    getTerminalSize: () => ({
      cols: term.cols,
      rows: term.rows,
    }),
    onReady: () => {
      fitReady = true;
      void inputPipeline.flushPendingResize();
      flushReadyState();
      if (!recoveryRuntime?.isOutputFlushBlocked() && outputPipeline.hasQueuedOutput()) {
        outputPipeline.scheduleOutputFlush();
      }
    },
  });

  const outputPipeline = createTerminalOutputPipeline({
    agentId,
    canFlushOutput: () => fitReady && !recoveryRuntime?.isOutputFlushBlocked(),
    channelId: outputChannel.id,
    getOutputPriority,
    hasObservedLocalInput: () => hasObservedLocalInput,
    isDisposed: () => disposed,
    // Attach uncertainty is retryable and never proves that a process spawn failed.
    isSpawnFailed: () => false,
    markTerminalReady,
    onChunkRendered: (outputRenderedAtMs, _renderedOutputCursor, byteLength) => {
      inputPipeline.finalizePendingInputTraceEchoes(outputRenderedAtMs);
      options.onOutputRendered?.(byteLength);
      options.onStartupWriteRendered?.(byteLength);
      syncRenderHibernationAfterIdle();
    },
    onQueueEmpty: syncRenderHibernationAfterIdle,
    props,
    taskId,
    term,
  });

  const renderHibernation = createTerminalRenderHibernationController({
    getOutputPriority,
    getRenderHibernationDelayMs,
    hasQueuedOutput: () => outputPipeline.hasQueuedOutput(),
    hasSuppressedOutputSinceHibernation: () => outputPipeline.hasSuppressedOutputSinceHibernation(),
    hasWriteInFlight: () => outputPipeline.hasWriteInFlight(),
    isDisposed: () => disposed,
    isRestoreBlocked: isRestoreBlockingRenderHibernation,
    isSpawnFailed: () => false,
    isSpawnReady: () => spawnReady,
    onRenderHibernationChange: (isHibernating) => {
      if (isHibernating) {
        resetPaintReady();
      } else if (currentStatus === 'ready' && !isRestoreBlockingRenderHibernation()) {
        beginAwaitingPaintReady();
      }
      options.onRenderHibernationChange?.(isHibernating);
      outputPipeline.setRenderHibernating(isHibernating);
    },
    onShouldKeepRenderLive: options.onShouldKeepRenderLive,
    restoreTerminalOutput: async () => {
      await recoveryRuntime?.restoreTerminalOutput('hibernate');
    },
    scheduleOutputFlush: () => {
      outputPipeline.scheduleOutputFlush();
    },
  });

  const inputPipeline = createTerminalInputPipeline({
    agentId,
    armInteractiveEchoFastPath: outputPipeline.armInteractiveEchoFastPath,
    canAcceptInput: options.canAcceptInput,
    canBufferInputWhileInteractionPending: options.canBufferInputWhileInteractionPending,
    isDisposed: () => disposed,
    isProcessExited: () => processExited,
    isRestoreBlocked: isRestoreBlockingRenderHibernation,
    isSpawnFailed: () => false,
    isSpawnReady: () => spawnReady,
    onBlockedInputAttempt: options.onBlockedInputAttempt,
    onInputAccepted: options.onInputAccepted,
    onInputActivity: markLocalInputObserved,
    onLocalInputFeedback: options.onLocalInputFeedback,
    onReadOnlyInputAttempt,
    onResizeCommitted: applyCommittedResizeFit,
    onResizeTransactionChange: handleResizeTransactionChange,
    props,
    runtimeClientId,
    shouldCommitResize: options.shouldCommitResize,
    taskId,
    term,
  });
  const initialTaskCommandController = getTaskCommandController(taskId);
  if (initialTaskCommandController) {
    inputPipeline.handleControllerChange(initialTaskCommandController.controllerId);
  }

  recoveryRuntime = createTerminalRecoveryRuntime({
    agentId,
    channelId: outputChannel.id,
    ensureTerminalFitReady,
    getCurrentStatus: () => currentStatus,
    getOutputPriority,
    initialBrowserTransportState: getInitialRecoveryTransportState(browserMode),
    getStartupPaintCoordinationSnapshot: options.getStartupPaintCoordinationSnapshot,
    isSelectedRecoveryProtected: () => options.isSelectedRecoveryProtected?.() === true,
    inputPipeline,
    isShell: props.isShell === true,
    isRenderHibernating: () => renderHibernation.isRecoveryVisible(),
    isDisposed: () => disposed,
    isSpawnFailed: () => false,
    isSpawnReady: () => spawnReady,
    markTerminalReady,
    onRestoreBlockedChange: (isBlocked) => {
      if (isBlocked) {
        resetPaintReady();
      } else if (currentStatus === 'ready') {
        beginAwaitingPaintReady();
      }
      syncWebglRendererPolicy();
      options.onRestoreBlockedChange?.(isBlocked);
      if (!isBlocked) {
        flushDeferredControllerChange();
        inputPipeline.flushPendingInput();
        inputPipeline.drainInputQueue();
      }
    },
    onRestoreSettled: syncRenderHibernationAfterIdle,
    onSelectedRecoverySettle: options.onSelectedRecoverySettle,
    onSelectedRecoveryStart: options.onSelectedRecoveryStart,
    onStartupWriteRendered: options.onStartupWriteRendered,
    outputPipeline,
    setStatus,
    subscribeStartupPaintCoordinationChanges: options.subscribeStartupPaintCoordinationChanges,
    taskId,
    term,
  });
  if (browserMode && isBrowserControlAuthenticated()) {
    recoveryRuntime.handleBrowserControlAuthenticated();
  }

  function setSelectedAttachRecoveryPending(nextPending: boolean): void {
    if (selectedAttachRecoveryPending === nextPending) {
      return;
    }

    selectedAttachRecoveryPending = nextPending;
    if (nextPending) {
      return;
    }

    flushReadyState();
    if (!recoveryRuntime?.isOutputFlushBlocked() && outputPipeline.hasQueuedOutput()) {
      outputPipeline.scheduleOutputFlush();
    }
  }

  if (options.subscribeStartupPaintCoordinationChanges) {
    cleanupCallbacks.push(
      options.subscribeStartupPaintCoordinationChanges(() => {
        const startupPaintSnapshot = options.getStartupPaintCoordinationSnapshot?.();
        if (startupPaintSnapshot?.selectedPaintReady !== true) {
          return;
        }

        if (!hasDeferredSessionFitStabilization) {
          scheduleFitIfDirty(agentId);
          return;
        }

        scheduleFitIfDirty(agentId);
        runDeferredSessionFitStabilization();
      }),
    );
  }
  cleanupCallbacks.push(
    subscribeTerminalInteractivityChanges(() => {
      const isYieldingNow = shouldYieldSessionFitToInteractivity();
      if (isYieldingNow) {
        wasYieldingToInteractivity = true;
        return;
      }

      if (!wasYieldingToInteractivity) {
        return;
      }

      wasYieldingToInteractivity = false;
      scheduleFitIfDirty(agentId);
      runDeferredSessionFitStabilization();
    }),
  );

  const outputHandlers = {
    Data(message: Extract<PtyOutput, { type: 'Data' }>): void {
      const receiveTs = recordOutputReceived();
      const outputReceivedAtMs = getTerminalTraceTimestampMs();
      const channelTiming = getBrowserChannelMessageTiming(message);
      const outputTransportReceivedAtMs = channelTiming
        ? outputReceivedAtMs - Math.max(0, performance.now() - channelTiming.receivedAtMs)
        : undefined;
      const decoded = decodeTerminalOutputData(message.data);
      if (decoded === null) {
        return;
      }
      if (hasPendingProbes()) {
        detectProbeInOutput(PROBE_TEXT_DECODER.decode(decoded));
      }
      inputPipeline.detectPendingInputTraceEcho(
        decoded,
        outputReceivedAtMs,
        outputTransportReceivedAtMs,
      );
      outputPipeline.enqueueOutput(decoded, receiveTs);
      if (!initialCommandSent && props.initialCommand) {
        initialCommandSent = true;
        initialCommandTimer = window.setTimeout(() => {
          initialCommandTimer = undefined;
          if (disposed) {
            return;
          }
          inputPipeline.enqueueProgrammaticInput(`${props.initialCommand}\r`);
        }, INITIAL_COMMAND_DELAY_MS);
      }
    },
    Exit(message: Extract<PtyOutput, { type: 'Exit' }>): void {
      pendingExitPayload = message.data;
      outputPipeline.flushOutputQueue();
      if (
        fitReady &&
        !outputPipeline.hasWriteInFlight() &&
        !outputPipeline.hasQueuedOutput() &&
        pendingExitPayload
      ) {
        flushPendingExitWhenIdle();
      }
    },
    RecoveryRequired(message: Extract<PtyOutput, { type: 'RecoveryRequired' }>): void {
      void recoveryRuntime?.restoreTerminalOutput(message.reason);
    },
  } satisfies DispatchByTypeHandlerMap<PtyOutput>;

  outputChannel.onmessage = (message) => dispatchByType(outputHandlers, message);

  term.loadAddon(fitAddon);
  void loadTerminalWebLinksAddonConstructor()
    .then((WebLinksAddon) => {
      if (disposed) {
        return;
      }

      const webLinksAddon = new WebLinksAddon((event, uri) => {
        if (!shouldOpenTerminalLink(event)) {
          return;
        }

        openTerminalLink(uri);
      });
      term.loadAddon(webLinksAddon);
      cleanupCallbacks.push(() => {
        webLinksAddon.dispose();
      });
    })
    .catch(() => {});
  term.open(containerRef);
  const markdownLinkProvider = registerTerminalMarkdownLinkProvider(term, props, () => !disposed);
  cleanupCallbacks.push(() => {
    markdownLinkProvider.dispose();
  });
  alignTerminalDomRendererWidthMetricsWithWebgl(term);
  setStatus('binding');
  syncFocusedChannelRegistration();
  props.onReady?.(() => term.focus());
  props.onBufferReady?.(() => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index <= buffer.length - 1; index += 1) {
      const line = buffer.getLine(index);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  });

  containerRef.addEventListener('copy', handleCopy, true);
  containerRef.addEventListener('dragover', handleDragOver, true);
  containerRef.addEventListener('drop', handleDrop, true);

  // xterm marks its textarea readonly while stdin is disabled. Keep terminal-local
  // Find available in that state (for example, while a peer owns the input lease)
  // without re-enabling any PTY input path. Capturing at the terminal boundary also
  // keeps browser-native Find untouched everywhere outside this xterm surface.
  function handleStdinDisabledKeyDown(event: KeyboardEvent): void {
    if (
      term.options.disableStdin !== true ||
      matchesGlobalShortcut(event) ||
      matchesDialogSafeShortcut(event)
    ) {
      return;
    }

    const shortcutAction = getTerminalShortcutAction(event, {
      browserMode,
      hasSelection: term.hasSelection(),
      isMac,
    });
    if (shortcutAction.kind !== 'find') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    options.onSearchRequested?.(sessionIdentity, searchRuntime);
  }

  containerRef.addEventListener('keydown', handleStdinDisabledKeyDown, true);
  cleanupCallbacks.push(() => {
    containerRef.removeEventListener('copy', handleCopy, true);
    containerRef.removeEventListener('dragover', handleDragOver, true);
    containerRef.removeEventListener('drop', handleDrop, true);
    containerRef.removeEventListener('keydown', handleStdinDisabledKeyDown, true);
  });

  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (
      event.type === 'keydown' &&
      (matchesGlobalShortcut(event) || matchesDialogSafeShortcut(event))
    ) {
      return false;
    }

    const shortcutAction = getTerminalShortcutAction(event, {
      browserMode,
      hasSelection: term.hasSelection(),
      isMac,
    });
    if (shortcutAction.preventDefault) {
      event.preventDefault();
    }

    if (
      shortcutAction.kind === 'allow' &&
      hasTerminalTraceClockAlignment() &&
      shouldTrackKeyboardEvent(event)
    ) {
      inputPipeline.recordKeyboardTraceStart(event);
    }

    switch (shortcutAction.kind) {
      case 'allow':
        return true;
      case 'block':
        return false;
      case 'copy':
        void copySelectionToClipboard();
        return false;
      case 'find':
        options.onSearchRequested?.(sessionIdentity, searchRuntime);
        return false;
      case 'paste':
        void pasteFromClipboard();
        return false;
      case 'scrollback':
        if (shortcutAction.unit === 'line') {
          term.scrollLines(shortcutAction.delta);
        } else {
          term.scrollPages(shortcutAction.delta);
        }
        return false;
      case 'send-input':
        inputPipeline.setNextProgrammaticInputTrace(shortcutAction.data);
        inputPipeline.enqueueProgrammaticInput(shortcutAction.data);
        return false;
    }
  });

  registerTerminal(
    agentId,
    containerRef,
    fitAddon,
    term,
    (dirtyReasons) => {
      const canProcessResizeDirty =
        dirtyReasons.size > 0 && [...dirtyReasons].every((reason) => reason === 'resize');
      if (
        options.shouldCommitResize?.() === false ||
        shouldDeferVisibleSiblingSessionFitStabilization()
      ) {
        return false;
      }

      if (canProcessResizeDirty) {
        return true;
      }

      return !inputPipeline.isResizeTransactionPending() && !shouldYieldSessionFitToInteractivity();
    },
    ({ cols, rows }) => {
      inputPipeline.handleTerminalResize(cols, rows);
    },
  );
  scheduleTerminalFitStabilization('startup');

  const handleVisibilityResume = (): void => {
    if (document.visibilityState === 'hidden') {
      return;
    }

    scheduleTerminalFitStabilization('visibility');
  };

  document.addEventListener('visibilitychange', handleVisibilityResume);
  window.addEventListener('pageshow', handleVisibilityResume);
  window.addEventListener('resize', handleViewportMetricsChange);
  window.visualViewport?.addEventListener('resize', handleViewportMetricsChange);
  cleanupCallbacks.push(
    subscribeTaskCommandControllerChanges((snapshot) => {
      if (snapshot.taskId !== taskId) {
        return;
      }

      handleTaskCommandControllerChange(snapshot.controllerId);
    }),
    () => {
      document.removeEventListener('visibilitychange', handleVisibilityResume);
      window.removeEventListener('pageshow', handleVisibilityResume);
      window.removeEventListener('resize', handleViewportMetricsChange);
      window.visualViewport?.removeEventListener('resize', handleViewportMetricsChange);
    },
  );

  term.onData((data) => {
    inputPipeline.handleTerminalData(data);
  });

  term.onResize(({ cols, rows }) => {
    recordTerminalRenderResize({
      agentId,
      taskId,
    });
    inputPipeline.handleTerminalResize(cols, rows);
  });

  term.onRender(({ end, start }) => {
    recordTerminalRenderEvent({
      agentId,
      endRow: end,
      startRow: start,
      taskId,
      term,
    });
    if (currentStatus !== 'ready') {
      renderedSincePaintReadyReset = true;
    }
    options.onStartupRenderEvent?.();
    settlePaintReadyAfterRender();
  });

  if (!isElectronRuntime()) {
    cleanupCallbacks.push(
      listenServerMessage('agent-error', (message) => {
        if (
          message.agentId !== agentId ||
          !String(message.message).includes(TASK_CONTROLLED_AGENT_ERROR_MESSAGE)
        ) {
          return;
        }

        inputPipeline.handleTaskControlLoss();
      }),
    );
    browserTransportCleanup = onBrowserTransportEvent((event) => {
      if (event.kind !== 'connection') {
        return;
      }

      browserTransportConnectionState = event.state;

      switch (event.state) {
        case 'connected':
          flushDeferredControllerChange();
          recoveryRuntime?.handleBrowserTransportConnectionState(event.state);
          inputPipeline.flushPendingInput();
          inputPipeline.drainInputQueue();
          return;
        case 'disconnected':
        case 'reconnecting':
          recoveryRuntime?.handleBrowserTransportConnectionState(event.state);
          return;
        case 'auth-expired':
          recoveryRuntime?.handleBrowserTransportConnectionState('disconnected');
          return;
        case 'connecting':
          return;
      }
    });
    cleanupCallbacks.push(
      onBrowserAuthenticated(() => {
        recoveryRuntime?.handleBrowserControlAuthenticated();
      }),
    );
  }

  let attachInFlight = false;
  let attachUnavailableReason: TerminalSessionAttachUnavailableReason | null = null;

  function markAttachUnavailable(reason: TerminalSessionAttachUnavailableReason): void {
    attachUnavailableReason = reason;
    setStatus('error');
    const message = getTerminalRestoreUnavailableMessage(attachUnavailableReason);
    const retryGuidance =
      reason === 'task-control-unavailable'
        ? 'Retry when task control is available.'
        : 'Retry when the backend is ready.';
    term.write(`\x1b[33m${message} ${retryGuidance}\x1b[0m\r\n`);
    options.onAttachUnavailable?.(attachUnavailableReason);
  }

  function buildAttachRequest(
    activeRecoveryRuntime: TerminalRecoveryRuntime,
  ): AttachTerminalSessionRequest {
    const common = {
      agentId,
      initialRecovery: activeRecoveryRuntime.getInitialAttachRecoveryDescriptor(),
      onOutput: outputChannel,
      taskId,
    };
    if (sessionOwner === 'managed-agent' || sessionOwner === 'managed-task-shell') {
      return { ...common, sessionOwner };
    }
    return {
      ...common,
      adapter: props.adapter,
      ...(props.arenaLaunchToken !== undefined ? { arenaLaunchToken: props.arenaLaunchToken } : {}),
      args: props.args,
      baseBranch: props.baseBranch,
      cols: term.cols,
      command: props.command,
      ...(sessionOwner === 'compatibility-shell' &&
      isCompatibilityTerminalCreationPending(taskId, agentId)
        ? { compatibilityIntent: 'create' as const }
        : {}),
      ...(browserMode ? { controllerId: runtimeClientId } : {}),
      cwd: props.cwd,
      env: props.env ?? {},
      isShell: props.isShell,
      projectMode: props.projectMode,
      replaceExistingSession: props.replaceExistingSession === true,
      resumeOnStart: props.resumeOnStart === true,
      rows: term.rows,
      runnerProfile: props.runnerProfile,
      sessionOwner,
      startsTaskWatchers: props.startsTaskWatchers,
    };
  }

  async function invokeAttachRequest(
    request: AttachTerminalSessionRequest,
  ): Promise<TerminalAttachInvocation> {
    let dispatched = false;
    const dispatch = async (): Promise<TerminalAttachInvocation> => {
      const attachPromise = invoke(IPC.AttachTerminalSession, request);
      dispatched = true;
      options.onAttachDispatched?.();
      return { kind: 'dispatched' as const, result: await attachPromise };
    };

    try {
      if (
        browserMode &&
        sessionOwner === 'compatibility-shell' &&
        isCompatibilityTerminalCreationPending(taskId, agentId)
      ) {
        const result = await runWithTaskCommandLease<TerminalAttachInvocation>(
          taskId,
          'open a terminal',
          () => {
            if (disposed || !isCompatibilityTerminalCreationPending(taskId, agentId)) {
              return Promise.resolve({
                kind: 'settled-without-dispatch',
                reason: 'cancelled',
              });
            }
            return dispatch();
          },
        );
        if (isTaskCommandLeaseSkipped(result)) {
          return {
            kind: 'settled-without-dispatch',
            reason: 'task-control-unavailable',
          };
        }
        return result;
      }
      return dispatch();
    } catch (error) {
      if (!dispatched) {
        options.onAttachSettledWithoutDispatch?.();
      }
      throw error;
    }
  }

  function isAttachTerminalSessionResult(value: unknown): value is AttachTerminalSessionResult {
    if (typeof value !== 'object' || value === null || !('kind' in value)) {
      return false;
    }
    return value.kind === 'attached' || value.kind === 'unavailable';
  }

  async function attachTerminalSession(): Promise<void> {
    if (disposed || attachInFlight || spawnReady) return;
    const activeRecoveryRuntime = recoveryRuntime;
    if (!activeRecoveryRuntime) return;
    attachInFlight = true;
    attachUnavailableReason = null;
    options.onAttachUnavailable?.(null);
    try {
      // Single-round-trip attach: validate + restore/create + bind + initial recovery in
      // one RPC, dispatched immediately with optimistic geometry (last-known
      // or the 80x24 xterm default). Fit gates paint via the recovery-apply
      // path, never process admission, and the scheduler slot is released at dispatch.
      setStatus('attaching');
      options.onAttachMilestone?.('attach-requested');
      let attachInvocation: Awaited<ReturnType<typeof invokeAttachRequest>>;
      try {
        attachInvocation = await invokeAttachRequest(buildAttachRequest(activeRecoveryRuntime));
      } catch {
        if (!disposed) markAttachUnavailable('attach-transport-unavailable');
        return;
      }
      if (attachInvocation.kind === 'settled-without-dispatch') {
        options.onAttachSettledWithoutDispatch?.();
        if (!disposed && attachInvocation.reason === 'task-control-unavailable') {
          markAttachUnavailable(attachInvocation.reason);
        }
        return;
      }
      const attachResult = attachInvocation.result;
      if (!isAttachTerminalSessionResult(attachResult)) {
        if (!disposed) markAttachUnavailable('attach-transport-unavailable');
        return;
      }

      if (attachResult.kind === 'unavailable') {
        if (disposed) return;
        attachUnavailableReason = attachResult.reason;
        setStatus('error');
        const message = getTerminalRestoreUnavailableMessage(attachResult.reason);
        term.write(`\x1b[33m${message} Retry when the backend is ready.\x1b[0m\r\n`);
        options.onAttachUnavailable?.(attachResult.reason);
        return;
      }

      if (disposed) {
        // An existing-session attach can return a held recovery pause after
        // this view has unmounted. Hand the entry to the disposed recovery
        // owner anyway; its early-exit path releases the pause without
        // applying terminal state or reviving the session.
        if (attachResult.disposition !== 'created' && attachResult.recovery) {
          await activeRecoveryRuntime
            .applyInitialAttachRecoveryEntry(attachResult.recovery)
            .catch(() => undefined);
        }
        return;
      }

      if (sessionOwner === 'compatibility-shell') {
        completeCompatibilityTerminalCreation(taskId, agentId);
      }

      if (browserMode) {
        markBrowserChannelBound(outputChannel.id);
      }
      options.onAttachMilestone?.('channel-ready');
      options.onAttachMilestone?.('attach-resolved');
      spawnReady = true;
      markAttachBound();
      void waitForTerminalFitReady('spawn-ready').then((fitBecameReady) => {
        if (fitBecameReady && !disposed) {
          options.onAttachMilestone?.('attach-fit-ready');
          // The spawn no longer waits behind the fit gate, so the session
          // stabilization that used to ride the post-fit-ready 'spawn-ready'
          // ensure is scheduled here once fit actually becomes ready (it
          // defers itself until the terminal is ready/paint-coordinated).
          scheduleTerminalFitStabilization('spawn-ready');
        }
      });
      if (attachResult.disposition !== 'created' && attachResult.recovery) {
        const shouldPrioritizeSelectedAttachRecovery =
          options.isSelectedRecoveryProtected?.() === true;
        if (shouldPrioritizeSelectedAttachRecovery) {
          setSelectedAttachRecoveryPending(true);
        }
        try {
          options.onAttachMilestone?.('attach-recovery-started');
          await activeRecoveryRuntime.applyInitialAttachRecoveryEntry(attachResult.recovery);
        } catch {
          const message = getTerminalRestoreUnavailableMessage('restore-failed');
          term.write(`\x1b[33m${message} Live terminal output will continue.\x1b[0m\r\n`);
        } finally {
          options.onAttachMilestone?.('attach-recovery-settled');
          if (shouldPrioritizeSelectedAttachRecovery && !disposed) {
            setSelectedAttachRecoveryPending(false);
          }
        }
      }
      if (disposed) {
        return;
      }

      activeRecoveryRuntime.notifySpawnReady();
      outputPipeline.recoverFlowControlIfIdle();
      scheduleReadyFallback();
      void inputPipeline.flushPendingResize();
      inputPipeline.flushPendingInput();
      inputPipeline.drainInputQueue();
      renderHibernation.sync();
    } finally {
      attachInFlight = false;
    }
  }

  void attachTerminalSession();

  return {
    cleanup(): void {
      clearInitialCommandTimer();
      resetPaintReady();
      setTerminalFocusedChannel(agentId, outputChannel.id, false);
      options.onRestoreBlockedChange?.(false);
      renderHibernation.cleanup();
      disposed = true;
      recoveryRuntime?.dispose();
      recoveryRuntime = null;
      clearReadyFallback();
      inputPipeline.cleanup();
      outputPipeline.cleanup();
      searchRuntime.dispose();
      if (attachBound) {
        if (browserMode && isBrowserPagehidePending()) {
          sendPagehideInvoke(IPC.ResumeAgent, {
            agentId,
            channelId: outputChannel.id,
            reason: 'flow-control',
          });
          sendPagehideInvoke(IPC.DetachAgentOutput, { agentId, channelId: outputChannel.id });
        } else {
          fireAndForget(IPC.ResumeAgent, {
            agentId,
            channelId: outputChannel.id,
            reason: 'flow-control',
          });
          fireAndForget(IPC.DetachAgentOutput, { agentId, channelId: outputChannel.id });
        }
      }
      outputChannel.cleanup?.();
      browserTransportCleanup?.();
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
      fitLifecycle.cleanup();
      releaseWebglAddon(agentId);
      unregisterTerminal(agentId);
      term.dispose();
    },
    fitAddon,
    flushPendingResize(): Promise<void> {
      const pendingFlush = inputPipeline.flushPendingResize();
      runDeferredSessionFitStabilization();
      return pendingFlush;
    },
    handleTerminalData(data: string): void {
      inputPipeline.handleTerminalData(data);
    },
    isRestoreBlocked(): boolean {
      return recoveryRuntime?.isRestoreBlocked() ?? false;
    },
    prefetchInputLease(): void {
      inputPipeline.prefetchInputLease();
    },
    prewarmRenderHibernation(): void {
      void renderHibernation.prewarm();
    },
    requestInputTakeover(): Promise<boolean> {
      return inputPipeline.requestInputTakeover();
    },
    retryAttach(): void {
      if (attachUnavailableReason === null || disposed) return;
      void attachTerminalSession();
    },
    search: searchRuntime,
    term,
    updateOutputPriority(): void {
      outputPipeline.updateOutputPriority();
      syncFocusedChannelRegistration();
      syncWebglRendererPolicy();
      renderHibernation.sync();
      scheduleFitIfDirty(agentId);
      void inputPipeline.flushPendingResize();
      runDeferredSessionFitStabilization();
    },
  };
}
