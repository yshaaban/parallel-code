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
  outputCursor?: number | null;
  renderedTail?: string | null;
  snapshotByteLimit?: number | null;
}

interface TerminalRecoveryDispatchOptions {
  immediate?: boolean;
}

interface PendingRestore {
  agentId: string;
  outputCursor: number | null;
  renderedTail: string | null;
  requestId: string;
  snapshotByteLimit: number | null;
  resolve: (entry: TerminalRecoveryBatchEntry) => void;
  reject: (reason: unknown) => void;
}

interface PendingStartupRestore {
  agentId: string;
  requestId: string;
  role: TerminalStartupRecoveryRole;
  resolve: (entry: TerminalRecoveryBatchEntry) => void;
  reject: (reason: unknown) => void;
}

interface PendingRecoveryListener {
  agentId: string;
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

function createTerminalRecoveryFallbackEntry(
  agentId: string,
  requestId: string,
): TerminalRecoveryBatchEntry {
  return {
    agentId,
    cols: 80,
    outputCursor: 0,
    recovery: {
      kind: 'snapshot',
      data: null,
    },
    requestId,
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
    entry ?? createTerminalRecoveryFallbackEntry(listener.agentId, listener.requestId),
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

  return entry ?? createTerminalRecoveryFallbackEntry(agentId, requestId);
}

async function requestImmediateTerminalStartupRecoveryEntry(
  agentId: string,
  role: TerminalStartupRecoveryRole,
): Promise<TerminalRecoveryBatchEntry> {
  const requestId = createRandomId();
  const [entry] = await invokeTerminalStartupRecoveryBatch([
    createTerminalStartupRecoveryRequestEntry(agentId, requestId, role),
  ]);

  return entry ?? createTerminalRecoveryFallbackEntry(agentId, requestId);
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
    return requestImmediateTerminalStartupRecoveryEntry(agentId, role);
  }

  return new Promise<TerminalRecoveryBatchEntry>((resolve, reject) => {
    startupAttachRestoreState.pending.push({
      agentId,
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
    return requestImmediateTerminalRecoveryEntry(agentId, options);
  }

  return requestBatchedTerminalRecovery(reconnectRestoreState, agentId, options);
}
