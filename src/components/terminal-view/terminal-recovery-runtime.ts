import type { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import { assertNever } from '../../lib/assert-never';
import type { BrowserControlConnectionState } from '../../lib/browser-control-client';
import {
  requestAttachTerminalRecovery,
  requestReconnectTerminalRecovery,
  requestTerminalRecovery,
} from '../../lib/scrollbackRestore';
import type { TerminalRecoveryBatchEntry } from '../../ipc/types';
import type { TerminalViewStatus } from './types';
import type { TerminalOutputPriority } from '../../lib/terminal-output-priority';
import type { TerminalOutputPipeline } from './terminal-output-pipeline';
import type { TerminalInputPipeline } from './terminal-input-pipeline';

const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

const OUTPUT_WRITE_CALLBACK_TIMEOUT_MS = 2_000;
// Larger replay chunks materially reduce startup replay/apply time without changing recovery truth.
const RESTORE_CHUNK_BYTES_BY_PRIORITY = {
  'active-visible': 256 * 1024,
  focused: 256 * 1024,
  hidden: 64 * 1024,
  'visible-background': 128 * 1024,
} as const;

interface TerminalReplayTraceEntry {
  agentId: string;
  applyMs: number;
  chunkCount: number;
  outputPriority: TerminalOutputPriority;
  pauseMs: number;
  reason: 'attach' | 'backpressure' | 'reconnect' | 'renderer-loss';
  recoveryFetchMs: number;
  recoveryKind: TerminalRecoveryBatchEntry['recovery']['kind'];
  requestStateBytes: number;
  requestedAtMs: number;
  restoreTotalMs: number;
  resumeMs: number;
  waitForOutputIdleMs: number;
  writtenBytes: number;
}

declare global {
  interface Window {
    __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: TerminalReplayTraceEntry[];
  }
}

function shouldRecordTerminalReplayTrace(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return Array.isArray(window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__);
}

function recordTerminalReplayTrace(entry: TerminalReplayTraceEntry): void {
  if (!shouldRecordTerminalReplayTrace() || typeof window === 'undefined') {
    return;
  }

  const traceEntries = window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ ?? [];
  traceEntries.push(entry);
  window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ = traceEntries;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface TerminalRecoveryRuntime {
  handleBrowserTransportConnectionState(state: ReconnectAwareBrowserTransportConnectionState): void;
  isRestoreBlocked(): boolean;
  restoreTerminalOutput(
    reason?: 'attach' | 'backpressure' | 'reconnect' | 'renderer-loss',
  ): Promise<void>;
}

interface CreateTerminalRecoveryRuntimeOptions {
  agentId: string;
  channelId: string;
  ensureTerminalFitReady: () => Promise<boolean>;
  getCurrentStatus: () => TerminalViewStatus;
  getOutputPriority: () => TerminalOutputPriority;
  inputPipeline: TerminalInputPipeline;
  isDisposed: () => boolean;
  isSpawnFailed: () => boolean;
  isSpawnReady: () => boolean;
  markTerminalReady: () => void;
  onRestoreSettled: () => void;
  outputPipeline: TerminalOutputPipeline;
  setStatus: (status: TerminalViewStatus) => void;
  term: Terminal;
}

type ReconnectAwareBrowserTransportConnectionState = Extract<
  BrowserControlConnectionState,
  'connected' | 'disconnected' | 'reconnecting'
>;

function base64ToUint8Array(base64: string): Uint8Array {
  let end = base64.length;
  while (end > 0 && base64.charCodeAt(end - 1) === 61) {
    end--;
  }
  const output = new Uint8Array((end * 3) >>> 2);
  let outputIndex = 0;
  for (let index = 0; index < end; ) {
    const a = B64_LOOKUP[base64.charCodeAt(index++)];
    const b = index < end ? B64_LOOKUP[base64.charCodeAt(index++)] : 0;
    const c = index < end ? B64_LOOKUP[base64.charCodeAt(index++)] : 0;
    const d = index < end ? B64_LOOKUP[base64.charCodeAt(index++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    output[outputIndex++] = (triplet >>> 16) & 0xff;
    if (outputIndex < output.length) {
      output[outputIndex++] = (triplet >>> 8) & 0xff;
    }
    if (outputIndex < output.length) {
      output[outputIndex++] = triplet & 0xff;
    }
  }
  return output;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    for (const value of chunk) {
      binary += String.fromCharCode(value);
    }
  }

  return btoa(binary);
}

export function createTerminalRecoveryRuntime(
  options: CreateTerminalRecoveryRuntimeOptions,
): TerminalRecoveryRuntime {
  const { agentId, inputPipeline, outputPipeline, term } = options;

  let hasConnected = false;
  let browserTransportState: ReconnectAwareBrowserTransportConnectionState = 'disconnected';
  let needsRestore = false;
  let queuedReconnectRestore = false;
  let restoreInFlight = false;
  let restoreGeneration = 0;
  let restoringScrollback = false;
  let restorePauseApplied = false;
  let restoreWriteChunkCount = 0;
  let restoreWrittenBytes = 0;

  function shouldBlockTerminalRecoveryUIForStatus(status: TerminalViewStatus): boolean {
    switch (status) {
      case 'attaching':
        return false;
      case 'binding':
      case 'error':
      case 'ready':
      case 'restoring':
        return true;
      default:
        return assertNever(status, 'Unhandled terminal recovery UI status');
    }
  }

  function shouldUseHiddenRestoreYield(): boolean {
    if (options.getOutputPriority() === 'hidden') {
      return true;
    }

    return document.visibilityState === 'hidden';
  }

  async function waitForRestoreYield(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (shouldUseHiddenRestoreYield()) {
        window.setTimeout(resolve, 0);
        return;
      }

      requestAnimationFrame(() => resolve());
    });
  }

  async function waitForOutputIdle(): Promise<void> {
    while (
      (outputPipeline.hasWriteInFlight() || outputPipeline.hasPendingFlowTransitions()) &&
      !options.isDisposed()
    ) {
      await waitForRestoreYield();
    }
  }

  function isActiveRestoreGeneration(generation: number): boolean {
    return generation === restoreGeneration && !options.isDisposed();
  }

  function getRestoreChunkSize(): number {
    const outputPriority = options.getOutputPriority();
    switch (outputPriority) {
      case 'focused':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY.focused;
      case 'active-visible':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY['active-visible'];
      case 'visible-background':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY['visible-background'];
      case 'hidden':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY.hidden;
    }

    return assertNever(outputPriority, 'Unhandled terminal output priority');
  }

  async function writeTerminalRestoreChunk(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finishWrite = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeoutId);
        resolve();
      };
      const timeoutId = window.setTimeout(finishWrite, OUTPUT_WRITE_CALLBACK_TIMEOUT_MS);
      term.write(chunk, finishWrite);
    });
  }

  async function writeTerminalPayloadChunked(
    payload: Uint8Array,
    chunkSize: number,
  ): Promise<void> {
    if (payload.length === 0) {
      return;
    }

    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const chunk = payload.subarray(offset, Math.min(payload.length, offset + chunkSize));
      restoreWriteChunkCount += 1;
      restoreWrittenBytes += chunk.length;
      await writeTerminalRestoreChunk(chunk);
      if (offset + chunkSize < payload.length) {
        await waitForRestoreYield();
      }
    }
  }

  async function restoreTerminalScrollbackData(scrollback: Uint8Array): Promise<void> {
    term.reset();
    await writeTerminalPayloadChunked(scrollback, getRestoreChunkSize());
    outputPipeline.setRenderedOutputHistory(scrollback);
  }

  function buildTerminalRecoveryHistory(overlapBytes: number, delta: Uint8Array): Uint8Array {
    const history = outputPipeline.getRenderedOutputHistory();
    const safeOverlapBytes = Math.min(Math.max(overlapBytes, 0), history.length);
    if (safeOverlapBytes === 0) {
      return delta.slice();
    }

    const preservedHistory = history.subarray(history.length - safeOverlapBytes);
    const nextHistory = new Uint8Array(preservedHistory.length + delta.length);
    nextHistory.set(preservedHistory, 0);
    nextHistory.set(delta, preservedHistory.length);
    return nextHistory;
  }

  function getTerminalRecoveryRequestState(): {
    outputCursor: number;
    renderedTail: string | null;
  } {
    const history = outputPipeline.getRenderedOutputHistory();
    return {
      outputCursor: outputPipeline.getRenderedOutputCursor(),
      renderedTail: history.length > 0 ? uint8ArrayToBase64(history) : null,
    };
  }

  function shouldShowBlockingRestoreUI(entry: TerminalRecoveryBatchEntry): boolean {
    return (
      isSnapshotRecovery(entry) &&
      shouldBlockTerminalRecoveryUIForStatus(options.getCurrentStatus())
    );
  }

  function shouldScrollToBottomAfterRecovery(entry: TerminalRecoveryBatchEntry): boolean {
    return isSnapshotRecovery(entry);
  }

  function isSnapshotRecovery(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.recovery.kind === 'snapshot';
  }

  function getTerminalRecoveryRequest(
    reason: 'attach' | 'backpressure' | 'reconnect' | 'renderer-loss',
  ): typeof requestTerminalRecovery {
    switch (reason) {
      case 'attach':
        return requestAttachTerminalRecovery;
      case 'reconnect':
        return requestReconnectTerminalRecovery;
      case 'backpressure':
      case 'renderer-loss':
        return requestTerminalRecovery;
    }

    return assertNever(reason, 'Unhandled terminal recovery reason');
  }

  function canStartReconnectRestore(): boolean {
    return (
      hasConnected &&
      needsRestore &&
      !restoreInFlight &&
      browserTransportState === 'connected' &&
      options.isSpawnReady() &&
      !options.isDisposed()
    );
  }

  function startReconnectRestoreIfReady(): boolean {
    if (!canStartReconnectRestore()) {
      return false;
    }

    queuedReconnectRestore = false;
    needsRestore = false;
    void restoreTerminalOutput('reconnect');
    return true;
  }

  async function applyTerminalRecoveryEntry(entry: TerminalRecoveryBatchEntry): Promise<void> {
    switch (entry.recovery.kind) {
      case 'noop':
        outputPipeline.setRenderedOutputCursor(entry.outputCursor);
        return;
      case 'delta': {
        const delta = base64ToUint8Array(entry.recovery.data);
        if (delta.length > 0) {
          await writeTerminalPayloadChunked(delta, getRestoreChunkSize());
        }
        if (entry.recovery.source === 'cursor') {
          outputPipeline.appendRenderedOutputHistory(delta);
        } else {
          outputPipeline.setRenderedOutputHistory(
            buildTerminalRecoveryHistory(entry.recovery.overlapBytes, delta),
          );
        }
        outputPipeline.setRenderedOutputCursor(entry.outputCursor);
        return;
      }
      case 'snapshot': {
        const scrollback = entry.recovery.data
          ? base64ToUint8Array(entry.recovery.data)
          : new Uint8Array(0);
        await restoreTerminalScrollbackData(scrollback);
        outputPipeline.setRenderedOutputCursor(entry.outputCursor);
        return;
      }
    }

    return assertNever(entry.recovery, 'Unhandled terminal recovery entry');
  }

  async function restoreTerminalOutput(
    reason: 'attach' | 'backpressure' | 'reconnect' | 'renderer-loss' = 'renderer-loss',
  ): Promise<void> {
    if (options.isDisposed() || restoreInFlight) {
      return;
    }

    const generation = ++restoreGeneration;
    restoreInFlight = true;
    restoringScrollback = true;
    restoreWriteChunkCount = 0;
    restoreWrittenBytes = 0;
    const restoreStartedAtMs = performance.now();
    const outputPriority = options.getOutputPriority();
    let waitForOutputIdleMs = 0;
    let pauseMs = 0;
    let recoveryFetchMs = 0;
    let applyMs = 0;
    let resumeMs = 0;
    let recoveryKind: TerminalRecoveryBatchEntry['recovery']['kind'] = 'noop';
    let requestStateBytes = 0;
    let terminalMarkedReady = false;
    let shouldRestartQueuedRestore = false;
    try {
      if (reason === 'renderer-loss') {
        await options.ensureTerminalFitReady();
        if (generation !== restoreGeneration || options.isDisposed()) {
          return;
        }
        term.refresh(0, Math.max(term.rows - 1, 0));
        options.markTerminalReady();
        terminalMarkedReady = true;
        return;
      }

      await options.ensureTerminalFitReady();
      if (!isActiveRestoreGeneration(generation)) {
        return;
      }
      const waitForOutputIdleStartedAtMs = performance.now();
      await waitForOutputIdle();
      waitForOutputIdleMs = performance.now() - waitForOutputIdleStartedAtMs;
      if (!isActiveRestoreGeneration(generation)) {
        return;
      }

      const pauseStartedAtMs = performance.now();
      await invoke(IPC.PauseAgent, { agentId, reason: 'restore', channelId: options.channelId });
      pauseMs = performance.now() - pauseStartedAtMs;
      restorePauseApplied = true;
      const recoveryRequest = getTerminalRecoveryRequest(reason);
      const requestState = getTerminalRecoveryRequestState();
      requestStateBytes =
        requestState.renderedTail === null
          ? 0
          : Math.floor((requestState.renderedTail.length * 3) / 4);
      const recoveryFetchStartedAtMs = performance.now();
      const recoveryEntry = await recoveryRequest(agentId, requestState);
      recoveryFetchMs = performance.now() - recoveryFetchStartedAtMs;
      recoveryKind = recoveryEntry.recovery.kind;
      if (!isActiveRestoreGeneration(generation)) {
        return;
      }

      if (shouldShowBlockingRestoreUI(recoveryEntry)) {
        options.setStatus('restoring');
      }

      outputPipeline.dropQueuedOutputForRecovery();
      const applyStartedAtMs = performance.now();
      await applyTerminalRecoveryEntry(recoveryEntry);
      applyMs = performance.now() - applyStartedAtMs;
      await options.ensureTerminalFitReady();
      if (generation !== restoreGeneration || options.isDisposed()) {
        return;
      }
      if (shouldScrollToBottomAfterRecovery(recoveryEntry)) {
        term.scrollToBottom();
      }
    } catch (error) {
      console.warn('[terminal] Failed to restore scrollback', error);
    } finally {
      if (restorePauseApplied) {
        try {
          const resumeStartedAtMs = performance.now();
          await invoke(IPC.ResumeAgent, {
            agentId,
            reason: 'restore',
            channelId: options.channelId,
          });
          resumeMs = performance.now() - resumeStartedAtMs;
        } catch (error) {
          console.warn('[terminal] Failed to resume after scrollback restore', error);
        } finally {
          restorePauseApplied = false;
        }
      }

      restoringScrollback = false;
      restoreInFlight = false;
      if (outputPipeline.hasQueuedOutput()) {
        outputPipeline.scheduleOutputFlush();
      }
      recordTerminalReplayTrace({
        agentId,
        applyMs: roundMilliseconds(applyMs),
        chunkCount: restoreWriteChunkCount,
        outputPriority,
        pauseMs: roundMilliseconds(pauseMs),
        reason,
        recoveryFetchMs: roundMilliseconds(recoveryFetchMs),
        recoveryKind,
        requestStateBytes,
        requestedAtMs: roundMilliseconds(restoreStartedAtMs),
        restoreTotalMs: roundMilliseconds(performance.now() - restoreStartedAtMs),
        resumeMs: roundMilliseconds(resumeMs),
        waitForOutputIdleMs: roundMilliseconds(waitForOutputIdleMs),
        writtenBytes: restoreWrittenBytes,
      });
      options.onRestoreSettled();
      if (queuedReconnectRestore && startReconnectRestoreIfReady()) {
        shouldRestartQueuedRestore = true;
        outputPipeline.recoverFlowControlIfIdle();
      }
      if (
        !shouldRestartQueuedRestore &&
        !terminalMarkedReady &&
        isActiveRestoreGeneration(generation) &&
        !options.isSpawnFailed()
      ) {
        options.markTerminalReady();
        inputPipeline.flushPendingResize();
        inputPipeline.flushPendingInput();
        inputPipeline.drainInputQueue();
      }
      outputPipeline.recoverFlowControlIfIdle();
    }

    if (shouldRestartQueuedRestore) {
      return;
    }
  }

  return {
    handleBrowserTransportConnectionState(
      state: ReconnectAwareBrowserTransportConnectionState,
    ): void {
      browserTransportState = state;
      switch (state) {
        case 'connected':
          if (needsRestore) {
            if (!startReconnectRestoreIfReady()) {
              queuedReconnectRestore = restoreInFlight;
            }
          }
          hasConnected = true;
          return;
        case 'disconnected':
        case 'reconnecting':
          if (hasConnected) {
            needsRestore = true;
            restoreGeneration += 1;
          }
          return;
      }

      return assertNever(state, 'Unhandled browser transport connection state');
    },
    isRestoreBlocked(): boolean {
      return restoreInFlight || restoringScrollback;
    },
    restoreTerminalOutput,
  };
}
