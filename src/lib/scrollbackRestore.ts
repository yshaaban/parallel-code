import { IPC } from '../../electron/ipc/channels';
import { invoke } from './ipc';
import { createRandomId } from './random-id';

import type {
  TerminalRecoveryBatchEntry,
  TerminalRecoveryRequestEntry,
  TerminalStartupRecoveryRequestEntry,
  TerminalStartupRecoveryRole,
} from '../ipc/types';

const ATTACH_BATCH_WINDOW_MS = 12;
const RECONNECT_BATCH_WINDOW_MS = 12;
const STARTUP_ATTACH_BATCH_WINDOW_MS = 8;

interface TerminalRecoveryRequestOptions {
  fallbackCols?: number;
  fallbackRows?: number;
  outputCursor?: number | null;
  renderedTail?: string | null;
  snapshotByteLimit?: number | null;
}

interface TerminalRecoveryDispatchOptions {
  fallbackCols?: number;
  fallbackRows?: number;
  immediate?: boolean;
}

interface TerminalRecoveryFallbackGeometry {
  cols: number;
  rows: number;
}

interface PendingRestore {
  agentId: string;
  fallbackGeometry: TerminalRecoveryFallbackGeometry;
  outputCursor: number | null;
  renderedTail: string | null;
  requestId: string;
  snapshotByteLimit: number | null;
  resolve: (entry: TerminalRecoveryBatchEntry) => void;
  reject: (reason: unknown) => void;
}

interface PendingStartupRestore {
  agentId: string;
  fallbackGeometry: TerminalRecoveryFallbackGeometry;
  requestId: string;
  role: TerminalStartupRecoveryRole;
  resolve: (entry: TerminalRecoveryBatchEntry) => void;
  reject: (reason: unknown) => void;
}

interface PendingRecoveryListener {
  agentId: string;
  fallbackGeometry: TerminalRecoveryFallbackGeometry;
  requestId: string;
  resolve: (entry: TerminalRecoveryBatchEntry) => void;
}

interface BatchedTerminalRecoveryState {
  inFlight: boolean;
  pending: PendingRestore[];
  timer: number | null;
  windowMs: number;
}

interface BatchedTerminalStartupRecoveryState {
  inFlight: boolean;
  pending: PendingStartupRestore[];
  timer: number | null;
  windowMs: number;
}

const attachRestoreState = createBatchedTerminalRecoveryState(ATTACH_BATCH_WINDOW_MS);
const reconnectRestoreState = createBatchedTerminalRecoveryState(RECONNECT_BATCH_WINDOW_MS);
const startupAttachRestoreState = createBatchedTerminalStartupRecoveryState(
  STARTUP_ATTACH_BATCH_WINDOW_MS,
);

function createBatchedTerminalRecoveryState(windowMs: number): BatchedTerminalRecoveryState {
  return {
    inFlight: false,
    pending: [],
    timer: null,
    windowMs,
  };
}

function createBatchedTerminalStartupRecoveryState(
  windowMs: number,
): BatchedTerminalStartupRecoveryState {
  return {
    inFlight: false,
    pending: [],
    timer: null,
    windowMs,
  };
}

function createTerminalRecoveryRequestEntry(
  agentId: string,
  requestId: string,
  options: TerminalRecoveryRequestOptions,
): TerminalRecoveryRequestEntry {
  return {
    agentId,
    outputCursor: options.outputCursor ?? null,
    renderedTail: options.renderedTail ?? null,
    requestId,
    snapshotByteLimit: options.snapshotByteLimit ?? null,
  };
}

function getTerminalRecoveryFallbackGeometry(
  options: TerminalRecoveryRequestOptions | TerminalRecoveryDispatchOptions,
): TerminalRecoveryFallbackGeometry {
  return {
    cols: options.fallbackCols ?? 80,
    rows: options.fallbackRows ?? 24,
  };
}

function mergeTerminalRecoveryFallbackOptions(
  options: TerminalRecoveryRequestOptions,
  dispatchOptions: TerminalRecoveryDispatchOptions,
): TerminalRecoveryRequestOptions {
  const mergedOptions: TerminalRecoveryRequestOptions = { ...options };
  if (mergedOptions.fallbackCols === undefined && dispatchOptions.fallbackCols !== undefined) {
    mergedOptions.fallbackCols = dispatchOptions.fallbackCols;
  }
  if (mergedOptions.fallbackRows === undefined && dispatchOptions.fallbackRows !== undefined) {
    mergedOptions.fallbackRows = dispatchOptions.fallbackRows;
  }
  return mergedOptions;
}

function createTerminalRecoveryFallbackEntry(
  agentId: string,
  requestId: string,
  geometry: TerminalRecoveryFallbackGeometry,
): TerminalRecoveryBatchEntry {
  return {
    agentId,
    cols: geometry.cols,
    outputCursor: 0,
    recovery: {
      kind: 'snapshot',
      data: null,
    },
    requestId,
    rows: geometry.rows,
  };
}

function createTerminalStartupRecoveryRequestEntry(
  agentId: string,
  requestId: string,
  role: TerminalStartupRecoveryRole,
): TerminalStartupRecoveryRequestEntry {
  return {
    agentId,
    requestId,
    role,
  };
}

function scheduleTerminalRecoveryBatchFlush(state: BatchedTerminalRecoveryState): void {
  if (state.timer !== null || typeof window === 'undefined') {
    return;
  }

  state.timer = window.setTimeout(() => {
    state.timer = null;
    void flushTerminalRecoveryBatch(state);
  }, state.windowMs);
}

async function flushTerminalRecoveryBatch(state: BatchedTerminalRecoveryState): Promise<void> {
  if (state.inFlight || state.pending.length === 0) {
    return;
  }

  state.inFlight = true;
  const currentBatch = state.pending.splice(0, state.pending.length);

  try {
    const results = await invokeTerminalRecoveryBatch(
      currentBatch.map((entry) =>
        createTerminalRecoveryRequestEntry(entry.agentId, entry.requestId, entry),
      ),
    );
    const recoveryByRequestId = new Map(results.map((entry) => [entry.requestId, entry] as const));
    for (const listener of currentBatch) {
      resolvePendingTerminalRecovery(listener, recoveryByRequestId.get(listener.requestId));
    }
  } catch (error) {
    for (const listener of currentBatch) {
      listener.reject(error);
    }
  } finally {
    state.inFlight = false;
    if (state.pending.length > 0) {
      scheduleTerminalRecoveryBatchFlush(state);
    }
  }
}

function resolvePendingTerminalRecovery(
  listener: PendingRecoveryListener,
  entry: TerminalRecoveryBatchEntry | undefined,
): void {
  listener.resolve(
    entry ??
      createTerminalRecoveryFallbackEntry(
        listener.agentId,
        listener.requestId,
        listener.fallbackGeometry,
      ),
  );
}

async function invokeTerminalRecoveryBatch(
  requests: TerminalRecoveryRequestEntry[],
): Promise<TerminalRecoveryBatchEntry[]> {
  return invoke(IPC.GetTerminalRecoveryBatch, { requests });
}

async function invokeTerminalStartupRecoveryBatch(
  requests: TerminalStartupRecoveryRequestEntry[],
): Promise<TerminalRecoveryBatchEntry[]> {
  return invoke(IPC.GetTerminalStartupRecoveryBatch, { requests });
}

async function requestImmediateTerminalRecoveryEntry(
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  const requestId = createRandomId();
  const [entry] = await invokeTerminalRecoveryBatch([
    createTerminalRecoveryRequestEntry(agentId, requestId, options),
  ]);

  return (
    entry ??
    createTerminalRecoveryFallbackEntry(
      agentId,
      requestId,
      getTerminalRecoveryFallbackGeometry(options),
    )
  );
}

async function requestImmediateTerminalStartupRecoveryEntry(
  agentId: string,
  role: TerminalStartupRecoveryRole,
  options: TerminalRecoveryDispatchOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  const requestId = createRandomId();
  const [entry] = await invokeTerminalStartupRecoveryBatch([
    createTerminalStartupRecoveryRequestEntry(agentId, requestId, role),
  ]);

  return (
    entry ??
    createTerminalRecoveryFallbackEntry(
      agentId,
      requestId,
      getTerminalRecoveryFallbackGeometry(options),
    )
  );
}

export async function requestTerminalRecovery(
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  return requestImmediateTerminalRecoveryEntry(agentId, options);
}

function requestBatchedTerminalRecovery(
  state: BatchedTerminalRecoveryState,
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  return new Promise<TerminalRecoveryBatchEntry>((resolve, reject) => {
    state.pending.push({
      agentId,
      fallbackGeometry: getTerminalRecoveryFallbackGeometry(options),
      outputCursor: options.outputCursor ?? null,
      renderedTail: options.renderedTail ?? null,
      requestId: createRandomId(),
      snapshotByteLimit: options.snapshotByteLimit ?? null,
      resolve,
      reject,
    });
    scheduleTerminalRecoveryBatchFlush(state);
  });
}

async function flushTerminalStartupRecoveryBatch(
  state: BatchedTerminalStartupRecoveryState,
): Promise<void> {
  if (state.inFlight || state.pending.length === 0) {
    return;
  }

  state.inFlight = true;
  const currentBatch = state.pending.splice(0, state.pending.length);

  try {
    const results = await invokeTerminalStartupRecoveryBatch(
      currentBatch.map((entry) =>
        createTerminalStartupRecoveryRequestEntry(entry.agentId, entry.requestId, entry.role),
      ),
    );
    const recoveryByRequestId = new Map(results.map((entry) => [entry.requestId, entry] as const));
    for (const listener of currentBatch) {
      resolvePendingTerminalRecovery(listener, recoveryByRequestId.get(listener.requestId));
    }
  } catch (error) {
    for (const listener of currentBatch) {
      listener.reject(error);
    }
  } finally {
    state.inFlight = false;
    if (state.pending.length > 0) {
      scheduleTerminalStartupRecoveryBatchFlush(state);
    }
  }
}

function scheduleTerminalStartupRecoveryBatchFlush(
  state: BatchedTerminalStartupRecoveryState,
): void {
  if (state.timer !== null || typeof window === 'undefined') {
    return;
  }

  state.timer = window.setTimeout(() => {
    state.timer = null;
    void flushTerminalStartupRecoveryBatch(state);
  }, state.windowMs);
}

export function requestAttachTerminalRecovery(
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  return requestBatchedTerminalRecovery(attachRestoreState, agentId, options);
}

export function requestStartupTerminalRecovery(
  agentId: string,
  role: TerminalStartupRecoveryRole,
  dispatchOptions: TerminalRecoveryDispatchOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  if (role === 'selected' || dispatchOptions.immediate === true) {
    return requestImmediateTerminalStartupRecoveryEntry(agentId, role, dispatchOptions);
  }

  return new Promise<TerminalRecoveryBatchEntry>((resolve, reject) => {
    startupAttachRestoreState.pending.push({
      agentId,
      fallbackGeometry: getTerminalRecoveryFallbackGeometry(dispatchOptions),
      requestId: createRandomId(),
      role,
      resolve,
      reject,
    });
    scheduleTerminalStartupRecoveryBatchFlush(startupAttachRestoreState);
  });
}

export function requestReconnectTerminalRecovery(
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
  dispatchOptions: TerminalRecoveryDispatchOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  if (dispatchOptions.immediate === true) {
    return requestImmediateTerminalRecoveryEntry(
      agentId,
      mergeTerminalRecoveryFallbackOptions(options, dispatchOptions),
    );
  }

  return requestBatchedTerminalRecovery(reconnectRestoreState, agentId, options);
}
