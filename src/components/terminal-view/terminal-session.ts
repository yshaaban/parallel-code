import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITerminalAddon } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { openMarkdownViewer } from '../../app/markdown-viewer';
import {
  Channel,
  fireAndForget,
  getBrowserTransportConnectionState,
  invoke,
  isElectronRuntime,
  listenServerMessage,
  onBrowserTransportEvent,
  sendPagehideInvoke,
} from '../../lib/ipc';
import {
  ensureBrowserPagehideTracking,
  isBrowserPagehidePending,
} from '../../lib/browser-pagehide';
import { getBrowserChannelMessageTiming } from '../../lib/browser-channel-client';
import { dispatchByType, type DispatchByTypeHandlerMap } from '../../lib/dispatch-by-type';
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
import { getTerminalTheme } from '../../lib/theme';
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
import { showNotification } from '../../store/notification';
import { store } from '../../store/store';
import { subscribeTaskCommandControllerChanges } from '../../store/task-command-controllers';
import { getRuntimeClientId } from '../../lib/runtime-client-id';
import type { PtyExitData, PtyOutput } from '../../ipc/types';
import { createTerminalInputPipeline } from './terminal-input-pipeline';
import { createTerminalOutputPipeline } from './terminal-output-pipeline';
import { createTerminalRenderHibernationController } from './terminal-render-hibernation';
import {
  createTerminalRecoveryRuntime,
  type TerminalRecoveryRuntime,
} from './terminal-recovery-runtime';
import type { TerminalViewProps, TerminalViewStatus } from './types';
import {
  getTerminalWebglPriority,
  type TerminalOutputPriority,
} from '../../lib/terminal-output-priority';

const INITIAL_COMMAND_DELAY_MS = 50;
const DEFAULT_READY_FALLBACK_DELAY_MS = 500;
const SELECTED_READY_FALLBACK_DELAY_MS = 150;
const PROBE_TEXT_DECODER = new TextDecoder();
const TERMINAL_MARKDOWN_LINK_PATTERN =
  /(?:file:\/\/\/?[^\s<>()"'`]+|(?:~?\/|\.{1,2}\/)?[^\s<>()"'`]+\.md(?:[?#][^\s<>()"'`]*)?(?::\d+(?::\d+)?)?)/giu;
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

function decodeTerminalOutputData(data: Extract<PtyOutput, { type: 'Data' }>['data']): Uint8Array {
  if (typeof data !== 'string') {
    return data;
  }

  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

function shouldAcquireTerminalWebglRenderer(priority: TerminalOutputPriority): boolean {
  return priority === 'focused';
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

function getViewportScale(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.visualViewport?.scale ?? null;
}

function shouldOpenTerminalLink(event: MouseEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

function normalizeTerminalPathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function hasFileUrlPrefix(filePath: string): boolean {
  return /^file:\/\//iu.test(filePath);
}

function shouldResolveTerminalMarkdownLinkAsFileUrl(linkText: string): boolean {
  return hasFileUrlPrefix(linkText) || isWindowsDrivePath(linkText);
}

function isWindowsDrivePath(filePath: string): boolean {
  return /^[a-zA-Z]:\//u.test(normalizeTerminalPathSeparators(filePath));
}

function isWindowsDriveSegment(pathSegment: string | undefined): boolean {
  return pathSegment !== undefined && /^[a-zA-Z]:$/u.test(pathSegment);
}

function stripTerminalMarkdownLinkSuffix(linkText: string): string {
  const trimmedText = linkText.trim().replace(/^[('"`]+|[)',.;:!?`]+$/gu, '');
  const textWithoutFragment = trimmedText.split('#', 1)[0] ?? '';
  const textWithoutQuery = textWithoutFragment.split('?', 1)[0] ?? '';
  return textWithoutQuery.replace(/:\d+(?::\d+)?$/u, '');
}

function toFileUrlInput(filePath: string): string {
  const normalizedPath = normalizeTerminalPathSeparators(filePath);
  if (hasFileUrlPrefix(normalizedPath)) {
    return normalizedPath;
  }

  if (isWindowsDrivePath(normalizedPath)) {
    return `file:///${normalizedPath}`;
  }

  if (normalizedPath.startsWith('/')) {
    return `file://${normalizedPath}`;
  }

  return normalizedPath;
}

function getDirectoryFileUrl(directoryPath: string): URL | null {
  const normalizedPath = normalizeTerminalPathSeparators(directoryPath).trim();
  if (normalizedPath.length === 0) {
    return null;
  }

  const suffixedPath = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
  try {
    return new URL(toFileUrlInput(suffixedPath));
  } catch {
    return null;
  }
}

function getDecodedFileUrlSegments(fileUrl: URL): string[] {
  return decodeURIComponent(fileUrl.pathname)
    .split('/')
    .filter((segment) => segment.length > 0);
}

function getComparableFileUrlHost(fileUrl: URL, caseInsensitive: boolean): string {
  const decodedHost = decodeURIComponent(fileUrl.host);
  return caseInsensitive ? decodedHost.toLowerCase() : decodedHost;
}

function getComparableFileUrlSegments(fileUrl: URL, caseInsensitive: boolean): string[] {
  const decodedSegments = getDecodedFileUrlSegments(fileUrl);
  if (!caseInsensitive) {
    return decodedSegments;
  }

  return decodedSegments.map((segment) => segment.toLowerCase());
}

function shouldCompareFileUrlPathCaseInsensitively(fileUrl: URL): boolean {
  const decodedSegments = getDecodedFileUrlSegments(fileUrl);
  return fileUrl.host.length > 0 || isWindowsDriveSegment(decodedSegments[0]);
}

function resolveTerminalMarkdownFileUrl(worktreeUrl: URL, normalizedLinkText: string): URL | null {
  try {
    if (shouldResolveTerminalMarkdownLinkAsFileUrl(normalizedLinkText)) {
      return new URL(toFileUrlInput(normalizedLinkText));
    }

    return new URL(normalizedLinkText, worktreeUrl);
  } catch {
    return null;
  }
}

function getMarkdownViewerRelativePath(worktreePath: string, linkText: string): string | null {
  const worktreeUrl = getDirectoryFileUrl(worktreePath);
  if (!worktreeUrl) {
    return null;
  }

  const sanitizedLinkText = stripTerminalMarkdownLinkSuffix(linkText);
  if (sanitizedLinkText.length === 0 || sanitizedLinkText.startsWith('~/')) {
    return null;
  }

  const normalizedLinkText = normalizeTerminalPathSeparators(sanitizedLinkText);
  if (!normalizedLinkText.toLowerCase().endsWith('.md')) {
    return null;
  }

  const hasExplicitScheme =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(normalizedLinkText) &&
    !isWindowsDrivePath(normalizedLinkText);
  if (hasExplicitScheme && !hasFileUrlPrefix(normalizedLinkText)) {
    return null;
  }

  const resolvedFileUrl = resolveTerminalMarkdownFileUrl(worktreeUrl, normalizedLinkText);
  if (!resolvedFileUrl) {
    return null;
  }

  if (resolvedFileUrl.protocol !== 'file:') {
    return null;
  }

  const compareCaseInsensitively =
    shouldCompareFileUrlPathCaseInsensitively(worktreeUrl) ||
    shouldCompareFileUrlPathCaseInsensitively(resolvedFileUrl);
  if (
    getComparableFileUrlHost(worktreeUrl, compareCaseInsensitively) !==
    getComparableFileUrlHost(resolvedFileUrl, compareCaseInsensitively)
  ) {
    return null;
  }

  const worktreeSegments = getComparableFileUrlSegments(worktreeUrl, compareCaseInsensitively);
  const targetComparableSegments = getComparableFileUrlSegments(
    resolvedFileUrl,
    compareCaseInsensitively,
  );
  const targetRelativeSegments = getDecodedFileUrlSegments(resolvedFileUrl);
  if (targetComparableSegments.length <= worktreeSegments.length) {
    return null;
  }

  for (let index = 0; index < worktreeSegments.length; index += 1) {
    if (targetComparableSegments[index] !== worktreeSegments[index]) {
      return null;
    }
  }

  return targetRelativeSegments.slice(worktreeSegments.length).join('/');
}

function getTerminalMarkdownLinks(
  lineText: string,
  worktreePath: string,
): Array<{ length: number; relativePath: string; startIndex: number; text: string }> {
  const links: Array<{ length: number; relativePath: string; startIndex: number; text: string }> =
    [];
  let match: RegExpExecArray | null;
  TERMINAL_MARKDOWN_LINK_PATTERN.lastIndex = 0;
  while ((match = TERMINAL_MARKDOWN_LINK_PATTERN.exec(lineText)) !== null) {
    const rawText = match[0];
    const relativePath = getMarkdownViewerRelativePath(worktreePath, rawText);
    if (!relativePath) {
      continue;
    }

    const displayText = stripTerminalMarkdownLinkSuffix(rawText);
    if (displayText.length === 0) {
      continue;
    }

    links.push({
      length: displayText.length,
      relativePath,
      startIndex: match.index,
      text: displayText,
    });
  }

  return links;
}

function registerTerminalMarkdownLinkProvider(
  term: Terminal,
  props: TerminalViewProps,
): { dispose: () => void } {
  return term.registerLinkProvider({
    provideLinks(lineNumber, callback): void {
      const worktreePath = props.cwd.trim();
      if (worktreePath.length === 0) {
        callback(undefined);
        return;
      }

      const lineText = term.buffer.active.getLine(lineNumber - 1)?.translateToString(true) ?? '';
      const links = getTerminalMarkdownLinks(lineText, worktreePath);
      if (links.length === 0) {
        callback(undefined);
        return;
      }

      callback(
        links.map((link) => ({
          activate(event: MouseEvent): void {
            if (!shouldOpenTerminalLink(event)) {
              return;
            }

            void openMarkdownViewer({
              agentId: props.agentId,
              relativePath: link.relativePath,
              taskId: props.taskId,
              worktreePath,
            });
          },
          range: {
            end: { x: link.startIndex + link.length + 1, y: lineNumber },
            start: { x: link.startIndex + 1, y: lineNumber },
          },
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
  flushPendingResize(): void;
  isRestoreBlocked(): boolean;
  prewarmRenderHibernation(): void;
  requestInputTakeover(): Promise<boolean>;
  term: Terminal;
  updateOutputPriority(): void;
}

export type TerminalAttachMilestone =
  | 'attach-fit-ready'
  | 'attach-recovery-settled'
  | 'attach-recovery-started'
  | 'channel-ready'
  | 'spawn-requested'
  | 'spawn-resolved';

export interface StartTerminalSessionOptions {
  canAcceptInput?: () => boolean;
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
  onAttachMilestone?: (milestone: TerminalAttachMilestone) => void;
  onBlockedInputAttempt?: () => void;
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
  onSelectedRecoverySettle?: () => void;
  onSelectedRecoveryStart?: () => void;
  onShouldKeepRenderLive?: () => boolean;
  onStatusChange?: (status: TerminalViewStatus) => void;
  props: TerminalViewProps;
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
  let spawnFailed = false;
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
    if (
      disposed ||
      spawnFailed ||
      !readyRequested ||
      !fitReady ||
      isRestoreBlockingRenderHibernation()
    ) {
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

    setWebglAddonPriority(agentId, getTerminalWebglPriority(outputPriority));
    if (outputPriority === 'focused') {
      touchWebglAddon(agentId);
    }

    if (webglRendererActive) {
      return;
    }

    const addon = acquireWebglAddon(
      agentId,
      term,
      () => {
        void recoveryRuntime?.restoreTerminalOutput('renderer-loss');
      },
      getTerminalWebglPriority(outputPriority),
    );
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
    while (!disposed && !spawnFailed) {
      if (await ensureTerminalFitReady(reason)) {
        return true;
      }
    }

    return false;
  }

  function markTerminalReady(): void {
    if (disposed || spawnFailed) {
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
    if (readyFallbackTimer !== undefined || disposed || spawnFailed) {
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
    term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
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
    isSpawnFailed: () => spawnFailed,
    markTerminalReady,
    onChunkRendered: (outputRenderedAtMs, _renderedOutputCursor, byteLength) => {
      inputPipeline.finalizePendingInputTraceEchoes(outputRenderedAtMs);
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
    isSpawnFailed: () => spawnFailed,
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
    isDisposed: () => disposed,
    isProcessExited: () => processExited,
    isRestoreBlocked: isRestoreBlockingRenderHibernation,
    isSpawnFailed: () => spawnFailed,
    isSpawnReady: () => spawnReady,
    onBlockedInputAttempt: options.onBlockedInputAttempt,
    onInputActivity: markLocalInputObserved,
    onReadOnlyInputAttempt,
    onResizeCommitted: applyCommittedResizeFit,
    onResizeTransactionChange: handleResizeTransactionChange,
    props,
    runtimeClientId,
    shouldCommitResize: options.shouldCommitResize,
    taskId,
    term,
  });

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
    isSpawnFailed: () => spawnFailed,
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
  const markdownLinkProvider = registerTerminalMarkdownLinkProvider(term, props);
  cleanupCallbacks.push(() => {
    markdownLinkProvider.dispose();
  });
  alignTerminalDomRendererWidthMetricsWithWebgl(term);
  setStatus('binding');
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
  cleanupCallbacks.push(() => {
    containerRef.removeEventListener('copy', handleCopy, true);
    containerRef.removeEventListener('dragover', handleDragOver, true);
    containerRef.removeEventListener('drop', handleDrop, true);
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
      return (
        options.shouldCommitResize?.() !== false &&
        !inputPipeline.isResizeTransactionPending() &&
        !shouldDeferVisibleSiblingSessionFitStabilization() &&
        (canProcessResizeDirty || !shouldYieldSessionFitToInteractivity())
      );
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
  }

  void (async () => {
    try {
      await outputChannel.ready;
      if (disposed) {
        return;
      }

      options.onAttachMilestone?.('channel-ready');
      setStatus('attaching');
      const attachFitReady = await waitForTerminalFitReady('attach');
      if (!attachFitReady || disposed) {
        return;
      }
      options.onAttachMilestone?.('attach-fit-ready');
      options.onAttachMilestone?.('spawn-requested');
      const spawnResult = await invoke(IPC.SpawnAgent, {
        adapter: props.adapter,
        agentId,
        args: props.args,
        baseBranch: props.baseBranch,
        cols: term.cols,
        command: props.command,
        controllerId: runtimeClientId,
        cwd: props.cwd,
        env: props.env ?? {},
        isShell: props.isShell,
        onOutput: outputChannel,
        resumeOnStart: props.resumeOnStart === true,
        rows: term.rows,
        taskId,
      });
      if (disposed) {
        return;
      }

      options.onAttachMilestone?.('spawn-resolved');
      spawnReady = true;
      markAttachBound();
      void waitForTerminalFitReady('spawn-ready');
      if (spawnResult.attachedExistingSession) {
        const shouldPrioritizeSelectedAttachRecovery =
          options.isSelectedRecoveryProtected?.() === true;
        if (shouldPrioritizeSelectedAttachRecovery) {
          setSelectedAttachRecoveryPending(true);
        }
        try {
          options.onAttachMilestone?.('attach-recovery-started');
          await recoveryRuntime.restoreTerminalOutput('attach');
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

      recoveryRuntime.notifySpawnReady();
      outputPipeline.recoverFlowControlIfIdle();
      scheduleReadyFallback();
      void inputPipeline.flushPendingResize();
      inputPipeline.flushPendingInput();
      inputPipeline.drainInputQueue();
      renderHibernation.sync();
    } catch (error) {
      if (disposed) {
        return;
      }

      spawnFailed = true;
      setStatus('error');
      // eslint-disable-next-line no-control-regex -- intentionally stripping control characters from terminal error output
      const safeError = String(error).replace(/[\x00-\x1f\x7f]/g, '');
      term.write(`\x1b[31mFailed to spawn: ${safeError}\x1b[0m\r\n`);
      props.onExit?.({
        exit_code: null,
        last_output: [`Failed to spawn: ${safeError}`],
        signal: 'spawn_failed',
      });
    }
  })();

  return {
    cleanup(): void {
      clearInitialCommandTimer();
      resetPaintReady();
      options.onRestoreBlockedChange?.(false);
      renderHibernation.cleanup();
      disposed = true;
      recoveryRuntime?.dispose();
      recoveryRuntime = null;
      clearReadyFallback();
      inputPipeline.cleanup();
      outputPipeline.cleanup();
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
    flushPendingResize(): void {
      void inputPipeline.flushPendingResize();
      runDeferredSessionFitStabilization();
    },
    isRestoreBlocked(): boolean {
      return recoveryRuntime?.isRestoreBlocked() ?? false;
    },
    prewarmRenderHibernation(): void {
      void renderHibernation.prewarm();
    },
    requestInputTakeover(): Promise<boolean> {
      return inputPipeline.requestInputTakeover();
    },
    term,
    updateOutputPriority(): void {
      outputPipeline.updateOutputPriority();
      syncWebglRendererPolicy();
      renderHibernation.sync();
      scheduleFitIfDirty(agentId);
      void inputPipeline.flushPendingResize();
      runDeferredSessionFitStabilization();
    },
  };
}
