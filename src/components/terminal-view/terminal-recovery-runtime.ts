import type { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import {
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
const RESTORE_CHUNK_BYTES_BY_PRIORITY = [96 * 1024, 64 * 1024, 32 * 1024, 16 * 1024] as const;

export interface TerminalRecoveryRuntime {
  handleBrowserTransportConnectionState(state: 'connected' | 'disconnected' | 'reconnecting'): void;
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
  let needsRestore = false;
  let restoreInFlight = false;
  let restoringScrollback = false;
  let restorePauseApplied = false;

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

  function getRestoreChunkSize(): number {
    switch (options.getOutputPriority()) {
      case 'focused':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY[0];
      case 'active-visible':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY[1];
      case 'visible-background':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY[2];
      case 'hidden':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY[3];
    }
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
    return entry.recovery.kind === 'snapshot' && options.getCurrentStatus() !== 'attaching';
  }

  function shouldScrollToBottomAfterRecovery(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.recovery.kind === 'snapshot';
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
  }

  async function restoreTerminalOutput(
    reason: 'attach' | 'backpressure' | 'reconnect' | 'renderer-loss' = 'renderer-loss',
  ): Promise<void> {
    if (options.isDisposed() || restoreInFlight) {
      return;
    }

    restoreInFlight = true;
    restoringScrollback = true;
    try {
      if (reason === 'renderer-loss') {
        await options.ensureTerminalFitReady();
        term.refresh(0, Math.max(term.rows - 1, 0));
        options.markTerminalReady();
        return;
      }

      await options.ensureTerminalFitReady();
      await waitForOutputIdle();
      if (options.isDisposed()) {
        return;
      }

      await invoke(IPC.PauseAgent, { agentId, reason: 'restore', channelId: options.channelId });
      restorePauseApplied = true;
      const recoveryRequest =
        reason === 'reconnect' ? requestReconnectTerminalRecovery : requestTerminalRecovery;
      const recoveryEntry = await recoveryRequest(agentId, getTerminalRecoveryRequestState());
      if (options.isDisposed()) {
        return;
      }

      if (shouldShowBlockingRestoreUI(recoveryEntry)) {
        options.setStatus('restoring');
      }

      outputPipeline.dropQueuedOutputForRecovery();
      await applyTerminalRecoveryEntry(recoveryEntry);
      await options.ensureTerminalFitReady();
      if (shouldScrollToBottomAfterRecovery(recoveryEntry)) {
        term.scrollToBottom();
      }
    } catch (error) {
      console.warn('[terminal] Failed to restore scrollback', error);
    } finally {
      if (restorePauseApplied) {
        try {
          await invoke(IPC.ResumeAgent, {
            agentId,
            reason: 'restore',
            channelId: options.channelId,
          });
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
      options.onRestoreSettled();
      if (!options.isDisposed() && !options.isSpawnFailed() && !restoringScrollback) {
        options.markTerminalReady();
        inputPipeline.flushPendingResize();
        inputPipeline.flushPendingInput();
        inputPipeline.drainInputQueue();
      }
      outputPipeline.recoverFlowControlIfIdle();
    }
  }

  return {
    handleBrowserTransportConnectionState(
      state: 'connected' | 'disconnected' | 'reconnecting',
    ): void {
      if (state === 'connected') {
        if (needsRestore && options.isSpawnReady() && !options.isDisposed()) {
          needsRestore = false;
          void restoreTerminalOutput('reconnect');
        }
        hasConnected = true;
        return;
      }

      if (hasConnected && (state === 'disconnected' || state === 'reconnecting')) {
        needsRestore = true;
      }
    },
    isRestoreBlocked(): boolean {
      return restoreInFlight || restoringScrollback;
    },
    restoreTerminalOutput,
  };
}
