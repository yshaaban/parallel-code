import type { TerminalOutputDiagnosticsSummarySnapshot } from '../lib/terminal-output-diagnostics';
import { getTerminalOutputDiagnosticsSummary } from '../lib/terminal-output-diagnostics';
import type { TerminalPresentationModeKind } from '../lib/terminal-presentation-mode';
import type { RendererRuntimeDiagnosticsSnapshot } from './runtime-diagnostics';
import { getRendererRuntimeDiagnosticsSnapshot } from './runtime-diagnostics';
import type { TerminalSurfaceTier } from './terminal-surface-tiering';

type TerminalAnomalyMonitorListener = () => void;
type TerminalAnomalyMonitorStatus = 'binding' | 'attaching' | 'restoring' | 'ready' | 'error';

export type TerminalAnomalySeverity = 'error' | 'warning';
export type TerminalAnomalyKind =
  | 'focused-ready-without-live-render'
  | 'peer-controlled-cursor'
  | 'terminal-error'
  | 'visible-dormant'
  | 'visible-render-hibernating'
  | 'visible-restore-blocked'
  | 'prolonged-loading';
export type TerminalAnomalyMonitorInteractionKind = 'blocked-input' | 'read-only-input';
export type TerminalAnomalyMonitorEventType =
  | 'anomaly-cleared'
  | 'anomaly-entered'
  | 'blocked-input'
  | 'read-only-input'
  | 'registered'
  | 'status-change'
  | 'unregistered';

export interface TerminalAnomalyLifecycleState {
  cursorBlink: boolean;
  hasPeerController: boolean;
  isFocused: boolean;
  isSelected: boolean;
  isVisible: boolean;
  liveRenderReady: boolean;
  presentationMode: TerminalPresentationModeKind;
  renderHibernating: boolean;
  restoreBlocked: boolean;
  sessionDormant: boolean;
  status: TerminalAnomalyMonitorStatus;
  surfaceTier: TerminalSurfaceTier;
}

export interface TerminalAnomalyMonitorEvent {
  agentId: string;
  atMs: number;
  key: string;
  taskId: string;
  type: TerminalAnomalyMonitorEventType;
  anomalyKind?: TerminalAnomalyKind;
  nextStatus?: TerminalAnomalyMonitorStatus;
  previousStatus?: TerminalAnomalyMonitorStatus | null;
}

export interface TerminalAnomalySnapshot {
  activeSinceMs: number;
  durationMs: number;
  key: TerminalAnomalyKind;
  label: string;
  severity: TerminalAnomalySeverity;
  thresholdMs: number;
}

export interface TerminalAnomalyTerminalSnapshot {
  agentId: string;
  anomalies: TerminalAnomalySnapshot[];
  counters: {
    blockedInputAttempts: number;
    readOnlyInputAttempts: number;
    statusTransitions: number;
  };
  key: string;
  lifecycle: TerminalAnomalyLifecycleState & {
    updatedAtMs: number;
  };
  recentEvents: TerminalAnomalyMonitorEvent[];
  taskId: string;
}

export interface TerminalAnomalyMonitorSnapshot {
  capturedAtMs: number;
  outputSummary: TerminalOutputDiagnosticsSummarySnapshot;
  recentEvents: TerminalAnomalyMonitorEvent[];
  rendererRuntime: RendererRuntimeDiagnosticsSnapshot;
  summary: {
    anomalyCounts: Record<TerminalAnomalyKind, number>;
    terminalsTracked: number;
    terminalsWithAnomalies: number;
    totalAnomalies: number;
  };
  terminals: TerminalAnomalyTerminalSnapshot[];
}

export interface TerminalAnomalyMonitorRegistration {
  recordInteraction: (kind: TerminalAnomalyMonitorInteractionKind) => void;
  unregister: () => void;
  updateLifecycle: (state: TerminalAnomalyLifecycleState) => void;
}

interface TerminalAnomalyDefinition {
  isActive: (state: TerminalAnomalyLifecycleState) => boolean;
  label: string;
  severity: TerminalAnomalySeverity;
  thresholdMs: number;
}

interface TerminalAnomalyMonitorEntry {
  agentId: string;
  candidateSinceMs: Record<TerminalAnomalyKind, number | null>;
  counters: TerminalAnomalyTerminalSnapshot['counters'];
  key: string;
  lastStatus: TerminalAnomalyMonitorStatus | null;
  lifecycle: TerminalAnomalyLifecycleState;
  recentEvents: TerminalAnomalyMonitorEvent[];
  taskId: string;
  updatedAtMs: number;
  visibleAnomalies: Set<TerminalAnomalyKind>;
}

const MAX_GLOBAL_EVENTS = 200;
const MAX_TERMINAL_EVENTS = 40;

const TERMINAL_ANOMALY_DEFINITIONS: Record<TerminalAnomalyKind, TerminalAnomalyDefinition> = {
  'focused-ready-without-live-render': {
    isActive: (state) =>
      state.isFocused &&
      state.status === 'ready' &&
      state.presentationMode === 'live' &&
      !state.liveRenderReady,
    label: 'Focused ready terminal without live render',
    severity: 'error',
    thresholdMs: 250,
  },
  'peer-controlled-cursor': {
    isActive: (state) => state.hasPeerController && state.cursorBlink,
    label: 'Peer-controlled terminal shows writable cursor',
    severity: 'error',
    thresholdMs: 0,
  },
  'prolonged-loading': {
    isActive: (state) => state.presentationMode === 'loading',
    label: 'Loading taking too long',
    severity: 'warning',
    thresholdMs: 4_000,
  },
  'terminal-error': {
    isActive: (state) => state.status === 'error',
    label: 'Terminal error',
    severity: 'error',
    thresholdMs: 0,
  },
  'visible-dormant': {
    isActive: (state) => state.isVisible && state.sessionDormant,
    label: 'Visible while dormant',
    severity: 'error',
    thresholdMs: 0,
  },
  'visible-render-hibernating': {
    isActive: (state) => state.isVisible && state.renderHibernating,
    label: 'Visible while render hibernating',
    severity: 'warning',
    thresholdMs: 1_500,
  },
  'visible-restore-blocked': {
    isActive: (state) => state.isVisible && state.restoreBlocked,
    label: 'Visible while restore blocked',
    severity: 'warning',
    thresholdMs: 1_500,
  },
};

const TERMINAL_ANOMALY_KINDS = Object.keys(
  TERMINAL_ANOMALY_DEFINITIONS,
) as readonly TerminalAnomalyKind[];

const DEFAULT_LIFECYCLE_STATE: TerminalAnomalyLifecycleState = {
  cursorBlink: false,
  hasPeerController: false,
  isFocused: false,
  isSelected: false,
  isVisible: false,
  liveRenderReady: false,
  presentationMode: 'loading',
  renderHibernating: false,
  restoreBlocked: false,
  sessionDormant: false,
  status: 'binding',
  surfaceTier: 'cold-hidden',
};

declare global {
  interface Window {
    __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
    __PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__?: boolean;
    __PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__?: boolean;
    __parallelCodeTerminalAnomalyMonitor?: {
      getSnapshot: () => TerminalAnomalyMonitorSnapshot;
      reset: () => void;
    };
  }
}

const terminalEntries = new Map<string, TerminalAnomalyMonitorEntry>();
const terminalAnomalyMonitorListeners = new Set<TerminalAnomalyMonitorListener>();
const terminalAnomalyMonitorEvents: TerminalAnomalyMonitorEvent[] = [];
let terminalAnomalyMonitorTimer: ReturnType<typeof setTimeout> | undefined;

function getTerminalAnomalyMonitorNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
}

function isTerminalAnomalyMonitorStoreEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__ === true ||
      window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ === true ||
      window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ === true)
  );
}

export function isTerminalAnomalyMonitorEnabled(): boolean {
  return isTerminalAnomalyMonitorStoreEnabled();
}

export function installTerminalAnomalyMonitor(): void {
  attachTerminalAnomalyMonitorStore();
}

function attachTerminalAnomalyMonitorStore(): void {
  if (!isTerminalAnomalyMonitorStoreEnabled() || typeof window === 'undefined') {
    return;
  }

  if (window.__parallelCodeTerminalAnomalyMonitor) {
    return;
  }

  window.__parallelCodeTerminalAnomalyMonitor = {
    getSnapshot: getTerminalAnomalyMonitorSnapshot,
    reset: resetTerminalAnomalyMonitorForTests,
  };
}

function createCandidateRecord(): Record<TerminalAnomalyKind, number | null> {
  return Object.fromEntries(TERMINAL_ANOMALY_KINDS.map((kind) => [kind, null])) as Record<
    TerminalAnomalyKind,
    number | null
  >;
}

function createAnomalyCountRecord(): Record<TerminalAnomalyKind, number> {
  return Object.fromEntries(TERMINAL_ANOMALY_KINDS.map((kind) => [kind, 0])) as Record<
    TerminalAnomalyKind,
    number
  >;
}

function trimEvents(events: TerminalAnomalyMonitorEvent[], limit: number): void {
  while (events.length > limit) {
    events.shift();
  }
}

function pushTerminalAnomalyEvent(
  entry: TerminalAnomalyMonitorEntry,
  event: Omit<TerminalAnomalyMonitorEvent, 'agentId' | 'key' | 'taskId'>,
): void {
  const nextEvent: TerminalAnomalyMonitorEvent = {
    agentId: entry.agentId,
    key: entry.key,
    taskId: entry.taskId,
    ...event,
  };
  entry.recentEvents.push(nextEvent);
  trimEvents(entry.recentEvents, MAX_TERMINAL_EVENTS);
  terminalAnomalyMonitorEvents.push(nextEvent);
  trimEvents(terminalAnomalyMonitorEvents, MAX_GLOBAL_EVENTS);
}

function clearTerminalAnomalyMonitorTimer(): void {
  if (terminalAnomalyMonitorTimer === undefined) {
    return;
  }

  clearTimeout(terminalAnomalyMonitorTimer);
  terminalAnomalyMonitorTimer = undefined;
}

function notifyTerminalAnomalyMonitorListeners(): void {
  attachTerminalAnomalyMonitorStore();
  for (const listener of terminalAnomalyMonitorListeners) {
    listener();
  }
}

function isLifecycleStateEqual(
  left: TerminalAnomalyLifecycleState,
  right: TerminalAnomalyLifecycleState,
): boolean {
  return (
    left.cursorBlink === right.cursorBlink &&
    left.hasPeerController === right.hasPeerController &&
    left.isFocused === right.isFocused &&
    left.isSelected === right.isSelected &&
    left.isVisible === right.isVisible &&
    left.liveRenderReady === right.liveRenderReady &&
    left.presentationMode === right.presentationMode &&
    left.renderHibernating === right.renderHibernating &&
    left.restoreBlocked === right.restoreBlocked &&
    left.sessionDormant === right.sessionDormant &&
    left.status === right.status &&
    left.surfaceTier === right.surfaceTier
  );
}

function getActiveAnomalyKinds(
  entry: TerminalAnomalyMonitorEntry,
  now: number,
): Set<TerminalAnomalyKind> {
  const activeAnomalies = new Set<TerminalAnomalyKind>();
  for (const kind of TERMINAL_ANOMALY_KINDS) {
    const startedAtMs = entry.candidateSinceMs[kind];
    if (startedAtMs === null) {
      continue;
    }

    const definition = TERMINAL_ANOMALY_DEFINITIONS[kind];
    if (now - startedAtMs >= definition.thresholdMs) {
      activeAnomalies.add(kind);
    }
  }

  return activeAnomalies;
}

function reconcileEntryAnomalies(entry: TerminalAnomalyMonitorEntry, now: number): boolean {
  const nextActiveAnomalies = getActiveAnomalyKinds(entry, now);
  const entered: TerminalAnomalyKind[] = [];
  const cleared: TerminalAnomalyKind[] = [];

  for (const kind of nextActiveAnomalies) {
    if (!entry.visibleAnomalies.has(kind)) {
      entered.push(kind);
    }
  }

  for (const kind of entry.visibleAnomalies) {
    if (!nextActiveAnomalies.has(kind)) {
      cleared.push(kind);
    }
  }

  if (entered.length === 0 && cleared.length === 0) {
    return false;
  }

  entry.visibleAnomalies = nextActiveAnomalies;
  for (const kind of entered) {
    pushTerminalAnomalyEvent(entry, {
      anomalyKind: kind,
      atMs: now,
      type: 'anomaly-entered',
    });
  }
  for (const kind of cleared) {
    pushTerminalAnomalyEvent(entry, {
      anomalyKind: kind,
      atMs: now,
      type: 'anomaly-cleared',
    });
  }

  return true;
}

function scheduleTerminalAnomalyMonitorTimer(now: number): void {
  clearTerminalAnomalyMonitorTimer();
  let nextTimerDelayMs: number | null = null;

  for (const entry of terminalEntries.values()) {
    for (const kind of TERMINAL_ANOMALY_KINDS) {
      const startedAtMs = entry.candidateSinceMs[kind];
      if (startedAtMs === null || entry.visibleAnomalies.has(kind)) {
        continue;
      }

      const thresholdMs = TERMINAL_ANOMALY_DEFINITIONS[kind].thresholdMs;
      if (thresholdMs <= 0) {
        continue;
      }

      const remainingMs = Math.max(0, startedAtMs + thresholdMs - now);
      if (nextTimerDelayMs === null || remainingMs < nextTimerDelayMs) {
        nextTimerDelayMs = remainingMs;
      }
    }
  }

  if (nextTimerDelayMs === null) {
    return;
  }

  terminalAnomalyMonitorTimer = setTimeout(() => {
    terminalAnomalyMonitorTimer = undefined;
    syncTerminalAnomalyMonitor();
  }, nextTimerDelayMs);
}

function syncTerminalAnomalyMonitor(): boolean {
  const now = getTerminalAnomalyMonitorNow();
  let didChange = false;
  for (const entry of terminalEntries.values()) {
    if (reconcileEntryAnomalies(entry, now)) {
      didChange = true;
    }
  }

  scheduleTerminalAnomalyMonitorTimer(now);
  if (didChange) {
    notifyTerminalAnomalyMonitorListeners();
  }

  return didChange;
}

function notifyTerminalAnomalyMonitorMutation(): void {
  const didChange = syncTerminalAnomalyMonitor();
  if (!didChange) {
    notifyTerminalAnomalyMonitorListeners();
  }
}

function getOrCreateTerminalEntry(
  key: string,
  taskId: string,
  agentId: string,
): TerminalAnomalyMonitorEntry {
  const existingEntry = terminalEntries.get(key);
  if (existingEntry) {
    return existingEntry;
  }

  const now = getTerminalAnomalyMonitorNow();
  const createdEntry: TerminalAnomalyMonitorEntry = {
    agentId,
    candidateSinceMs: createCandidateRecord(),
    counters: {
      blockedInputAttempts: 0,
      readOnlyInputAttempts: 0,
      statusTransitions: 0,
    },
    key,
    lastStatus: null,
    lifecycle: { ...DEFAULT_LIFECYCLE_STATE },
    recentEvents: [],
    taskId,
    updatedAtMs: now,
    visibleAnomalies: new Set<TerminalAnomalyKind>(),
  };
  terminalEntries.set(key, createdEntry);
  pushTerminalAnomalyEvent(createdEntry, {
    atMs: now,
    type: 'registered',
  });
  return createdEntry;
}

function updateEntryLifecycle(
  entry: TerminalAnomalyMonitorEntry,
  nextLifecycle: TerminalAnomalyLifecycleState,
): void {
  if (isLifecycleStateEqual(entry.lifecycle, nextLifecycle)) {
    return;
  }

  const now = getTerminalAnomalyMonitorNow();
  if (entry.lastStatus !== null && entry.lastStatus !== nextLifecycle.status) {
    entry.counters.statusTransitions += 1;
    pushTerminalAnomalyEvent(entry, {
      atMs: now,
      nextStatus: nextLifecycle.status,
      previousStatus: entry.lastStatus,
      type: 'status-change',
    });
  }

  entry.lifecycle = { ...nextLifecycle };
  entry.lastStatus = nextLifecycle.status;
  entry.updatedAtMs = now;
  for (const kind of TERMINAL_ANOMALY_KINDS) {
    entry.candidateSinceMs[kind] = TERMINAL_ANOMALY_DEFINITIONS[kind].isActive(nextLifecycle)
      ? (entry.candidateSinceMs[kind] ?? now)
      : null;
  }
}

function createTerminalAnomalySnapshot(
  entry: TerminalAnomalyMonitorEntry,
  key: TerminalAnomalyKind,
  now: number,
): TerminalAnomalySnapshot | null {
  const activeSinceMs = entry.candidateSinceMs[key];
  if (activeSinceMs === null) {
    return null;
  }

  const definition = TERMINAL_ANOMALY_DEFINITIONS[key];
  if (now - activeSinceMs < definition.thresholdMs) {
    return null;
  }

  return {
    activeSinceMs,
    durationMs: Math.max(0, now - activeSinceMs),
    key,
    label: definition.label,
    severity: definition.severity,
    thresholdMs: definition.thresholdMs,
  };
}

function createTerminalSnapshot(
  entry: TerminalAnomalyMonitorEntry,
  now: number,
): TerminalAnomalyTerminalSnapshot {
  const anomalies = TERMINAL_ANOMALY_KINDS.map((kind) =>
    createTerminalAnomalySnapshot(entry, kind, now),
  ).filter((snapshot): snapshot is TerminalAnomalySnapshot => snapshot !== null);

  return {
    agentId: entry.agentId,
    anomalies,
    counters: {
      blockedInputAttempts: entry.counters.blockedInputAttempts,
      readOnlyInputAttempts: entry.counters.readOnlyInputAttempts,
      statusTransitions: entry.counters.statusTransitions,
    },
    key: entry.key,
    lifecycle: {
      ...entry.lifecycle,
      updatedAtMs: entry.updatedAtMs,
    },
    recentEvents: entry.recentEvents.map((event) => ({ ...event })),
    taskId: entry.taskId,
  };
}

export function subscribeTerminalAnomalyMonitorChanges(
  callback: TerminalAnomalyMonitorListener,
): () => void {
  terminalAnomalyMonitorListeners.add(callback);
  return () => {
    terminalAnomalyMonitorListeners.delete(callback);
  };
}

export function registerTerminalAnomalyMonitorTerminal(details: {
  agentId: string;
  key: string;
  taskId: string;
}): TerminalAnomalyMonitorRegistration {
  const entry = getOrCreateTerminalEntry(details.key, details.taskId, details.agentId);
  notifyTerminalAnomalyMonitorMutation();

  return {
    recordInteraction(kind): void {
      const now = getTerminalAnomalyMonitorNow();
      if (kind === 'blocked-input') {
        entry.counters.blockedInputAttempts += 1;
      } else {
        entry.counters.readOnlyInputAttempts += 1;
      }
      pushTerminalAnomalyEvent(entry, {
        atMs: now,
        type: kind,
      });
      notifyTerminalAnomalyMonitorMutation();
    },
    unregister(): void {
      const currentEntry = terminalEntries.get(details.key);
      if (!currentEntry) {
        return;
      }

      pushTerminalAnomalyEvent(currentEntry, {
        atMs: getTerminalAnomalyMonitorNow(),
        type: 'unregistered',
      });
      terminalEntries.delete(details.key);
      notifyTerminalAnomalyMonitorMutation();
    },
    updateLifecycle(state): void {
      updateEntryLifecycle(entry, state);
      notifyTerminalAnomalyMonitorMutation();
    },
  };
}

export function getTerminalAnomalyTerminalSnapshot(
  key: string,
): TerminalAnomalyTerminalSnapshot | null {
  syncTerminalAnomalyMonitor();
  const entry = terminalEntries.get(key);
  if (!entry) {
    return null;
  }

  return createTerminalSnapshot(entry, getTerminalAnomalyMonitorNow());
}

export function getTerminalAnomalyMonitorSnapshot(): TerminalAnomalyMonitorSnapshot {
  attachTerminalAnomalyMonitorStore();
  syncTerminalAnomalyMonitor();
  const now = getTerminalAnomalyMonitorNow();
  const summary = {
    anomalyCounts: createAnomalyCountRecord(),
    terminalsTracked: terminalEntries.size,
    terminalsWithAnomalies: 0,
    totalAnomalies: 0,
  };
  const terminals = [...terminalEntries.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => createTerminalSnapshot(entry, now));

  for (const terminal of terminals) {
    if (terminal.anomalies.length > 0) {
      summary.terminalsWithAnomalies += 1;
    }
    for (const anomaly of terminal.anomalies) {
      summary.anomalyCounts[anomaly.key] += 1;
      summary.totalAnomalies += 1;
    }
  }

  return {
    capturedAtMs: now,
    outputSummary: getTerminalOutputDiagnosticsSummary(),
    recentEvents: terminalAnomalyMonitorEvents.map((event) => ({ ...event })),
    rendererRuntime: getRendererRuntimeDiagnosticsSnapshot(),
    summary,
    terminals,
  };
}

export function resetTerminalAnomalyMonitorForTests(): void {
  resetTerminalAnomalyMonitor();
}

export function resetTerminalAnomalyMonitor(): void {
  clearTerminalAnomalyMonitorTimer();
  terminalEntries.clear();
  terminalAnomalyMonitorEvents.length = 0;
  terminalAnomalyMonitorListeners.clear();
  attachTerminalAnomalyMonitorStore();
}
