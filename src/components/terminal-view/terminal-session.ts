import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { getTerminalFontFamily } from '../../lib/fonts';
import {
  Channel,
  fireAndForget,
  invoke,
  isElectronRuntime,
  onBrowserTransportEvent,
} from '../../lib/ipc';
import {
  detectProbeInOutput,
  hasPendingProbes,
  recordFlowEvent,
  recordOutputReceived,
  recordOutputWritten,
} from '../../lib/terminalLatency';
import { registerTerminal, unregisterTerminal } from '../../lib/terminalFitManager';
import { requestScrollbackRestore } from '../../lib/scrollbackRestore';
import { matchesGlobalShortcut } from '../../lib/shortcuts';
import { getTerminalTheme } from '../../lib/theme';
import { acquireWebglAddon, releaseWebglAddon, touchWebglAddon } from '../../lib/webglPool';
import { isMac } from '../../lib/platform';
import { showNotification } from '../../store/notification';
import { store } from '../../store/store';
import type { PtyOutput } from '../../ipc/types';
import type { TerminalViewProps } from './types';
import {
  DEFAULT_MAX_PENDING_CHARS,
  getTerminalInputBatchPlan,
  mergePendingInputCharLimit,
  splitTerminalInputChunks,
  takeQueuedTerminalInputBatch,
} from '../../lib/terminal-input-batching';

const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

const PROBE_TEXT_DECODER = new TextDecoder();
const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;
const INPUT_RETRY_DELAY_MS = 50;
const OUTPUT_WRITE_CALLBACK_TIMEOUT_MS = 2_000;

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
    if (outputIndex < output.length) output[outputIndex++] = (triplet >>> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = triplet & 0xff;
  }
  return output;
}

interface TerminalSession {
  cleanup(): void;
  fitAddon: FitAddon;
  term: Terminal;
}

interface StartTerminalSessionOptions {
  containerRef: HTMLDivElement;
  props: TerminalViewProps;
}

export function startTerminalSession(options: StartTerminalSessionOptions): TerminalSession {
  const { containerRef, props } = options;
  const taskId = props.taskId;
  const agentId = props.agentId;
  const initialFontSize = props.fontSize ?? 13;
  const browserMode = !isElectronRuntime();

  const term = new Terminal({
    cursorBlink: true,
    fontSize: initialFontSize,
    fontFamily: getTerminalFontFamily(store.terminalFont),
    theme: getTerminalTheme(store.themePreset),
    allowProposedApi: true,
    scrollback: 3000,
  });

  const fitAddon = new FitAddon();
  let outputRaf: number | undefined;
  let outputQueue: Uint8Array[] = [];
  let outputQueuedBytes = 0;
  let outputQueueFirstReceiveTs = 0;
  let outputWriteInFlight = false;
  let outputWriteWatchdog: number | undefined;
  let watermark = 0;
  let flowPauseApplied = false;
  let flowPauseInFlight = false;
  let flowResumeInFlight = false;
  let flowRetryTimer: number | undefined;
  let spawnReady = false;
  let spawnFailed = false;
  let disposed = false;
  let processExited = false;
  let pendingExitPayload: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  } | null = null;
  let initialCommandSent = false;
  let inputBuffer = '';
  let pendingInput = '';
  let pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
  const inputQueue: Array<{ data: string }> = [];
  let inputFlushTimer: number | undefined;
  let inputSendInFlight = false;
  let resizeFlushTimer: number | undefined;
  let pendingResize: { cols: number; rows: number } | null = null;
  let lastSentCols = -1;
  let lastSentRows = -1;
  let restoreInFlight = false;
  let restoringScrollback = false;
  let restorePauseApplied = false;
  let browserTransportCleanup: (() => void) | undefined;

  const FLOW_HIGH = 256 * 1024;
  const FLOW_LOW = 32 * 1024;

  term.loadAddon(fitAddon);
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      try {
        const parsed = new URL(uri);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          window.open(uri, '_blank');
        }
      } catch {
        // ignore invalid URL
      }
    }),
  );

  term.open(containerRef);
  props.onReady?.(() => term.focus());
  props.onBufferReady?.(() => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index <= buffer.length - 1; index++) {
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

  const clearSelectionAfterCopy = (): void => {
    queueMicrotask(() => term.clearSelection());
  };

  async function copySelectionToClipboard(): Promise<void> {
    const selection = term.getSelection();
    if (!selection) return;

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(selection);
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

  async function pasteFromClipboard(): Promise<void> {
    if (!navigator.clipboard?.readText) {
      showNotification('Paste failed. Use your browser paste shortcut or the context menu.');
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        term.paste(text);
      }
    } catch (error) {
      console.warn('[terminal] Failed to read clipboard text', error);
      showNotification('Paste failed. Use your browser paste shortcut or the context menu.');
    }
  }

  if (browserMode) {
    containerRef.addEventListener('copy', clearSelectionAfterCopy);
  }

  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== 'keydown') return true;
    if (matchesGlobalShortcut(event)) return false;

    const key = event.key.toLowerCase();
    const hasSelection = term.hasSelection();
    const isPrimaryCopy = isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'c'
      : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === 'c';
    const isPrimaryPaste = isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'v'
      : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === 'v';
    const isPrimaryFind =
      (isMac ? event.metaKey : event.ctrlKey) &&
      !event.altKey &&
      !(isMac ? event.ctrlKey : event.metaKey) &&
      !event.shiftKey &&
      key === 'f';
    const isExplicitTerminalCopy =
      !isMac && event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && key === 'c';
    const isExplicitTerminalPaste =
      !isMac && event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && key === 'v';

    if (browserMode) {
      if (isPrimaryFind) return false;
      if ((isMac && isPrimaryCopy) || (!isMac && isPrimaryCopy && hasSelection)) return false;
      if (isPrimaryPaste) {
        event.preventDefault();
        return false;
      }

      if (isExplicitTerminalCopy) {
        event.preventDefault();
        void copySelectionToClipboard();
        return false;
      }

      if (isExplicitTerminalPaste) {
        event.preventDefault();
        void pasteFromClipboard();
        return false;
      }
    }

    const shouldHandleCopy = isMac
      ? isPrimaryCopy
      : isExplicitTerminalCopy || (isPrimaryCopy && hasSelection);
    if (shouldHandleCopy) {
      event.preventDefault();
      void copySelectionToClipboard();
      return false;
    }

    const shouldHandlePaste = isMac
      ? isPrimaryPaste
      : isExplicitTerminalPaste || (!browserMode && isPrimaryPaste);
    if (shouldHandlePaste) {
      event.preventDefault();
      void pasteFromClipboard();
      return false;
    }

    return true;
  });

  fitAddon.fit();
  registerTerminal(agentId, containerRef, fitAddon, term);

  if (props.autoFocus) {
    term.focus();
  }

  function emitExit(payload: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  }): void {
    processExited = true;
    pendingInput = '';
    inputQueue.length = 0;
    term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
    props.onExit?.(payload);
  }

  function clearOutputWriteWatchdog(): void {
    if (outputWriteWatchdog === undefined) return;
    clearTimeout(outputWriteWatchdog);
    outputWriteWatchdog = undefined;
  }

  function scheduleFlowRetry(): void {
    if (flowRetryTimer !== undefined || disposed) return;
    flowRetryTimer = window.setTimeout(() => {
      flowRetryTimer = undefined;
      if (watermark > FLOW_HIGH && !flowPauseApplied) {
        requestPtyPause();
      } else if (watermark < FLOW_LOW && flowPauseApplied) {
        requestPtyResume();
      }
    }, INPUT_RETRY_DELAY_MS);
  }

  function requestPtyPause(): void {
    if (disposed || flowPauseApplied || flowPauseInFlight) return;
    flowPauseInFlight = true;
    recordFlowEvent('pause');
    invoke(IPC.PauseAgent, { agentId, reason: 'flow-control', channelId: onOutput.id })
      .then(() => {
        flowPauseApplied = true;
        if (watermark < FLOW_LOW) {
          requestPtyResume();
        }
      })
      .catch(() => {
        scheduleFlowRetry();
      })
      .finally(() => {
        flowPauseInFlight = false;
      });
  }

  function requestPtyResume(): void {
    if (disposed || !flowPauseApplied || flowResumeInFlight) return;
    flowResumeInFlight = true;
    recordFlowEvent('resume');
    invoke(IPC.ResumeAgent, { agentId, reason: 'flow-control', channelId: onOutput.id })
      .then(() => {
        flowPauseApplied = false;
        if (watermark > FLOW_HIGH) {
          requestPtyPause();
        }
      })
      .catch(() => {
        scheduleFlowRetry();
      })
      .finally(() => {
        flowResumeInFlight = false;
      });
  }

  function flushOutputQueue(): void {
    if (restoringScrollback || outputWriteInFlight || outputQueue.length === 0) return;

    const chunks = outputQueue;
    const totalBytes = outputQueuedBytes;
    const batchReceiveTs = outputQueueFirstReceiveTs;
    outputQueue = [];
    outputQueuedBytes = 0;
    outputQueueFirstReceiveTs = 0;

    let payload: Uint8Array;
    if (chunks.length === 1) {
      payload = chunks[0];
    } else {
      payload = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        payload.set(chunk, offset);
        offset += chunk.length;
      }
    }

    const statusPayload =
      payload.length > STATUS_ANALYSIS_MAX_BYTES
        ? payload.subarray(payload.length - STATUS_ANALYSIS_MAX_BYTES)
        : payload;

    outputWriteInFlight = true;
    let writeCompleted = false;
    const finishWrite = (): void => {
      if (writeCompleted) return;
      writeCompleted = true;
      clearOutputWriteWatchdog();
      outputWriteInFlight = false;
      watermark = Math.max(watermark - payload.length, 0);
      recordOutputWritten(batchReceiveTs);

      if (watermark < FLOW_LOW && flowPauseApplied) {
        requestPtyResume();
      }

      if (disposed) return;

      props.onData?.(statusPayload);
      if (outputQueue.length > 0) {
        scheduleOutputFlush();
        return;
      }
      if (pendingExitPayload) {
        const exit = pendingExitPayload;
        pendingExitPayload = null;
        emitExit(exit);
      }
    };

    outputWriteWatchdog = window.setTimeout(finishWrite, OUTPUT_WRITE_CALLBACK_TIMEOUT_MS);
    term.write(payload, finishWrite);
  }

  function scheduleOutputFlush(): void {
    if (outputRaf !== undefined) return;
    outputRaf = requestAnimationFrame(() => {
      outputRaf = undefined;
      flushOutputQueue();
    });
  }

  function enqueueOutput(chunk: Uint8Array, receiveTs = 0): void {
    watermark += chunk.length;
    if (watermark > FLOW_HIGH && !flowPauseApplied) {
      requestPtyPause();
    }
    if (chunk.length > 0) {
      touchWebglAddon(agentId);
    }

    if (
      !restoringScrollback &&
      chunk.length < 256 &&
      !outputWriteInFlight &&
      outputQueue.length === 0
    ) {
      outputWriteInFlight = true;
      let writeCompleted = false;
      const statusPayload =
        chunk.length > STATUS_ANALYSIS_MAX_BYTES
          ? chunk.subarray(chunk.length - STATUS_ANALYSIS_MAX_BYTES)
          : chunk;
      const finishWrite = (): void => {
        if (writeCompleted) return;
        writeCompleted = true;
        clearOutputWriteWatchdog();
        outputWriteInFlight = false;
        watermark = Math.max(watermark - chunk.length, 0);
        recordOutputWritten(receiveTs);
        if (watermark < FLOW_LOW && flowPauseApplied) {
          requestPtyResume();
        }
        if (disposed) return;
        props.onData?.(statusPayload);
        if (outputQueue.length > 0) {
          scheduleOutputFlush();
        } else if (pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      };
      outputWriteWatchdog = window.setTimeout(finishWrite, OUTPUT_WRITE_CALLBACK_TIMEOUT_MS);
      term.write(chunk, finishWrite);
      return;
    }

    outputQueue.push(chunk);
    outputQueuedBytes += chunk.length;
    if (receiveTs && !outputQueueFirstReceiveTs) {
      outputQueueFirstReceiveTs = receiveTs;
    }

    if (restoringScrollback) return;
    if (outputQueuedBytes >= 64 * 1024) {
      flushOutputQueue();
    } else {
      scheduleOutputFlush();
    }
  }

  const onOutput = new Channel<PtyOutput>();
  onOutput.onmessage = (message) => {
    if (message.type === 'Data') {
      const receiveTs = recordOutputReceived();
      const decoded =
        typeof message.data === 'string' ? base64ToUint8Array(message.data) : message.data;
      if (hasPendingProbes()) {
        detectProbeInOutput(PROBE_TEXT_DECODER.decode(decoded));
      }
      enqueueOutput(decoded, receiveTs);
      if (!initialCommandSent && props.initialCommand) {
        initialCommandSent = true;
        setTimeout(() => enqueueInput(props.initialCommand + '\r'), 50);
      }
      return;
    }

    if (message.type === 'Exit') {
      pendingExitPayload = message.data;
      flushOutputQueue();
      if (
        !restoringScrollback &&
        !outputWriteInFlight &&
        outputQueue.length === 0 &&
        pendingExitPayload
      ) {
        const exit = pendingExitPayload;
        pendingExitPayload = null;
        emitExit(exit);
      }
      return;
    }

    if (message.type === 'ResetRequired') {
      void restoreScrollback('reconnect');
    }
  };

  function scheduleInputFlush(delay = 8): void {
    if (disposed) return;
    if (inputFlushTimer !== undefined) return;
    inputFlushTimer = window.setTimeout(() => {
      inputFlushTimer = undefined;
      flushPendingInput();
      drainInputQueue();
    }, delay);
  }

  function drainInputQueue(): void {
    if (disposed || spawnFailed || processExited || inputSendInFlight || inputQueue.length === 0) {
      return;
    }
    if (!spawnReady) {
      scheduleInputFlush(INPUT_RETRY_DELAY_MS);
      return;
    }

    const queuedBatch = takeQueuedTerminalInputBatch(inputQueue);
    if (!queuedBatch) {
      inputQueue.shift();
      drainInputQueue();
      return;
    }

    inputSendInFlight = true;
    invoke(IPC.WriteToAgent, { agentId, data: queuedBatch.batch })
      .then(() => {
        inputQueue.splice(0, queuedBatch.count);
      })
      .catch(() => {
        if (!disposed && !spawnFailed && !processExited) {
          scheduleInputFlush(INPUT_RETRY_DELAY_MS);
        }
      })
      .finally(() => {
        inputSendInFlight = false;
        if (!disposed && !processExited && inputQueue.length > 0) {
          if (spawnReady) {
            drainInputQueue();
          } else {
            scheduleInputFlush(INPUT_RETRY_DELAY_MS);
          }
        }
      });
  }

  function flushPendingInput(): void {
    if (inputFlushTimer !== undefined) {
      clearTimeout(inputFlushTimer);
      inputFlushTimer = undefined;
    }
    if (!pendingInput) return;
    inputQueue.push(...splitTerminalInputChunks(pendingInput));
    pendingInput = '';
    pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
  }

  function enqueueInput(data: string): void {
    if (processExited) {
      return;
    }
    const plan = getTerminalInputBatchPlan(data);
    pendingInput += data;
    pendingInputCharLimit = mergePendingInputCharLimit(pendingInputCharLimit, data);
    if (plan.flushImmediately || pendingInput.length >= pendingInputCharLimit) {
      flushPendingInput();
      drainInputQueue();
      return;
    }
    scheduleInputFlush(plan.flushDelayMs);
  }

  term.onData((data) => {
    if (props.onPromptDetected) {
      for (const char of data) {
        if (char === '\r') {
          const trimmed = inputBuffer.trim();
          if (trimmed) {
            props.onPromptDetected(trimmed);
          }
          inputBuffer = '';
        } else if (char === '\x7f') {
          inputBuffer = inputBuffer.slice(0, -1);
        } else if (char === '\x03' || char === '\x15') {
          inputBuffer = '';
        } else if (char === '\x1b') {
          break;
        } else if (char >= ' ') {
          inputBuffer += char;
        }
      }
    }
    enqueueInput(data);
  });

  function flushPendingResize(): void {
    if (!pendingResize) return;
    if (!spawnReady && !spawnFailed && !disposed) {
      if (resizeFlushTimer === undefined) {
        resizeFlushTimer = window.setTimeout(() => {
          resizeFlushTimer = undefined;
          flushPendingResize();
        }, 33);
      }
      return;
    }

    const { cols, rows } = pendingResize;
    pendingResize = null;
    if (cols === lastSentCols && rows === lastSentRows) return;
    lastSentCols = cols;
    lastSentRows = rows;
    fireAndForget(IPC.ResizeAgent, { agentId, cols, rows });
  }

  term.onResize(({ cols, rows }) => {
    pendingResize = { cols, rows };
    if (resizeFlushTimer !== undefined) return;
    resizeFlushTimer = window.setTimeout(() => {
      resizeFlushTimer = undefined;
      flushPendingResize();
    }, 33);
  });

  async function restoreScrollback(
    reason: 'renderer-loss' | 'reconnect' = 'renderer-loss',
  ): Promise<void> {
    if (disposed || restoreInFlight) return;
    restoreInFlight = true;
    restoringScrollback = true;
    try {
      if (outputRaf !== undefined) {
        cancelAnimationFrame(outputRaf);
        outputRaf = undefined;
      }

      while ((outputWriteInFlight || flowPauseInFlight || flowResumeInFlight) && !disposed) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      if (disposed) return;

      let scrollback: string | null = null;
      if (reason === 'reconnect') {
        scrollback = (await requestScrollbackRestore(agentId)).scrollback;
      } else {
        await invoke(IPC.PauseAgent, { agentId, reason: 'restore', channelId: onOutput.id });
        restorePauseApplied = true;
        scrollback = await invoke<string | null>(IPC.GetAgentScrollback, { agentId });
      }
      if (disposed || !scrollback) return;

      if (reason === 'reconnect') {
        const droppedBytes = outputQueuedBytes;
        outputQueue = [];
        outputQueuedBytes = 0;
        watermark = Math.max(watermark - droppedBytes, 0);
        if (watermark < FLOW_LOW && flowPauseApplied) {
          requestPtyResume();
        }
      }
      outputQueueFirstReceiveTs = 0;

      term.reset();
      await new Promise<void>((resolve) => {
        term.write(base64ToUint8Array(scrollback), resolve);
      });
      term.scrollToBottom();
      touchWebglAddon(agentId);
    } catch (error) {
      console.warn('[terminal] Failed to restore scrollback', error);
    } finally {
      if (restorePauseApplied) {
        try {
          await invoke(IPC.ResumeAgent, { agentId, reason: 'restore' });
        } catch (error) {
          console.warn('[terminal] Failed to resume after scrollback restore', error);
        } finally {
          restorePauseApplied = false;
        }
      }

      restoringScrollback = false;
      restoreInFlight = false;
      if (outputQueue.length > 0) {
        flushOutputQueue();
      }
      if (pendingExitPayload && !outputWriteInFlight && outputQueue.length === 0) {
        const exit = pendingExitPayload;
        pendingExitPayload = null;
        emitExit(exit);
      }
    }
  }

  acquireWebglAddon(agentId, term, () => restoreScrollback('renderer-loss'));

  if (!isElectronRuntime()) {
    let hasConnected = false;
    let needsRestore = false;
    browserTransportCleanup = onBrowserTransportEvent((event) => {
      if (event.kind !== 'connection') return;
      if (event.state === 'connected') {
        if (needsRestore && spawnReady && !disposed) {
          needsRestore = false;
          void restoreScrollback('reconnect');
        }
        hasConnected = true;
        return;
      }
      if (hasConnected && (event.state === 'disconnected' || event.state === 'reconnecting')) {
        needsRestore = true;
      }
    });
  }

  void (async () => {
    try {
      await onOutput.ready;
      if (disposed) return;
      await invoke(IPC.SpawnAgent, {
        taskId,
        agentId,
        command: props.command,
        args: props.args,
        adapter: props.adapter,
        cwd: props.cwd,
        env: props.env ?? {},
        cols: term.cols,
        rows: term.rows,
        isShell: props.isShell,
        onOutput,
      });
      spawnReady = true;
      flushPendingResize();
      flushPendingInput();
      drainInputQueue();
    } catch (error) {
      if (disposed) return;
      spawnFailed = true;
      // eslint-disable-next-line no-control-regex -- intentionally stripping control characters from terminal error output
      const safeError = String(error).replace(/[\x00-\x1f\x7f]/g, '');
      term.write(`\x1b[31mFailed to spawn: ${safeError}\x1b[0m\r\n`);
      props.onExit?.({
        exit_code: null,
        signal: 'spawn_failed',
        last_output: [`Failed to spawn: ${safeError}`],
      });
    }
  })();

  return {
    fitAddon,
    term,
    cleanup(): void {
      flushPendingInput();
      disposed = true;
      flushPendingResize();
      if (inputFlushTimer !== undefined) clearTimeout(inputFlushTimer);
      if (resizeFlushTimer !== undefined) clearTimeout(resizeFlushTimer);
      if (outputRaf !== undefined) cancelAnimationFrame(outputRaf);
      if (flowRetryTimer !== undefined) clearTimeout(flowRetryTimer);
      clearOutputWriteWatchdog();
      if (flowPauseApplied || flowResumeInFlight || flowPauseInFlight) {
        fireAndForget(IPC.ResumeAgent, {
          agentId,
          reason: 'flow-control',
          channelId: onOutput.id,
        });
      }
      fireAndForget(IPC.DetachAgentOutput, { agentId, channelId: onOutput.id });
      onOutput.cleanup?.();
      browserTransportCleanup?.();
      releaseWebglAddon(agentId);
      if (browserMode) {
        containerRef.removeEventListener('copy', clearSelectionAfterCopy);
      }
      unregisterTerminal(agentId);
      term.dispose();
    },
  };
}
