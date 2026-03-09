import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { createEffect, onCleanup, onMount, type JSX } from 'solid-js';
import { Channel, fireAndForget, invoke, isElectronRuntime } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { getTerminalFontFamily } from '../lib/fonts';
import { getTerminalTheme } from '../lib/theme';
import { matchesGlobalShortcut } from '../lib/shortcuts';
import { isMac } from '../lib/platform';
import { showNotification } from '../store/notification';
import { store } from '../store/store';
import { registerTerminal, unregisterTerminal, markDirty } from '../lib/terminalFitManager';
import { acquireWebglAddon, releaseWebglAddon, touchWebglAddon } from '../lib/webglPool';
import {
  recordOutputReceived,
  recordOutputWritten,
  hasPendingProbes,
  detectProbeInOutput,
  recordFlowEvent,
} from '../lib/terminalLatency';
import type { PtyOutput } from '../ipc/types';

// Pre-computed base64 lookup table — avoids atob() intermediate string allocation.
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}
const PROBE_TEXT_DECODER = new TextDecoder();

function base64ToUint8Array(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61 /* '=' */) end--;
  const out = new Uint8Array((end * 3) >>> 2);
  let j = 0;
  for (let i = 0; i < end; ) {
    const a = B64_LOOKUP[b64.charCodeAt(i++)];
    const b = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const c = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const d = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    out[j++] = (triplet >>> 16) & 0xff;
    if (j < out.length) out[j++] = (triplet >>> 8) & 0xff;
    if (j < out.length) out[j++] = triplet & 0xff;
  }
  return out;
}

interface TerminalViewProps {
  taskId: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  isShell?: boolean;
  onExit?: (exitInfo: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  }) => void;
  onData?: (data: Uint8Array) => void;
  onPromptDetected?: (text: string) => void;
  onReady?: (focusFn: () => void) => void;
  onBufferReady?: (getBuffer: () => string) => void;
  fontSize?: number;
  autoFocus?: boolean;
  initialCommand?: string;
  isFocused?: boolean;
}

// Status parsing only needs recent output. Capping forwarded bytes avoids
// expensive full-chunk decoding during large terminal bursts.
const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;
const INPUT_RETRY_DELAY_MS = 50;
const OUTPUT_WRITE_CALLBACK_TIMEOUT_MS = 2_000;

export function TerminalView(props: TerminalViewProps): JSX.Element {
  let containerRef!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;

  onMount(() => {
    // Capture props eagerly so cleanup/callbacks always use the original values
    const taskId = props.taskId;
    const agentId = props.agentId;
    const initialFontSize = props.fontSize ?? 13;
    const browserMode = !isElectronRuntime();

    term = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: getTerminalFontFamily(store.terminalFont),
      theme: getTerminalTheme(store.themePreset),
      allowProposedApi: true,
      scrollback: 3000,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        try {
          const parsed = new URL(uri);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            window.open(uri, '_blank');
          }
        } catch {
          // Invalid URL, ignore
        }
      }),
    );

    term.open(containerRef);
    props.onReady?.(() => term?.focus());
    props.onBufferReady?.(() => {
      if (!term) return '';
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i <= buf.length - 1; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines.join('\n');
    });

    const clearSelectionAfterCopy = () => {
      queueMicrotask(() => term?.clearSelection());
    };

    async function copySelectionToClipboard(): Promise<void> {
      const selection = term?.getSelection();
      if (!selection) return;

      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(selection);
          term?.clearSelection();
          return;
        } catch (error) {
          console.warn('[terminal] Failed to write clipboard text', error);
        }
      }

      try {
        if (document.execCommand('copy')) {
          term?.clearSelection();
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
        if (text) term?.paste(text);
      } catch (error) {
        console.warn('[terminal] Failed to read clipboard text', error);
        showNotification('Paste failed. Use your browser paste shortcut or the context menu.');
      }
    }

    if (browserMode) {
      containerRef.addEventListener('copy', clearSelectionAfterCopy);
    }

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;

      // Let global app shortcuts pass through to the window handler
      if (matchesGlobalShortcut(e)) return false;

      const key = e.key.toLowerCase();
      const hasSelection = term?.hasSelection() ?? false;
      const isPrimaryCopy = isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key === 'c'
        : e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'c';
      const isPrimaryPaste = isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key === 'v'
        : e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'v';
      const isPrimaryFind =
        (isMac ? e.metaKey : e.ctrlKey) &&
        !e.altKey &&
        !(isMac ? e.ctrlKey : e.metaKey) &&
        !e.shiftKey &&
        key === 'f';
      const isExplicitTerminalCopy =
        !isMac && e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && key === 'c';
      const isExplicitTerminalPaste =
        !isMac && e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && key === 'v';

      // In browsers, prefer native copy/paste/find shortcuts and only fall back
      // to the Clipboard API for Ctrl+Shift+C/V on Windows/Linux.
      if (browserMode) {
        if (isPrimaryFind) return false;
        if ((isMac && isPrimaryCopy) || (!isMac && isPrimaryCopy && hasSelection)) return false;
        if (isPrimaryPaste) return false;

        if (isExplicitTerminalCopy) {
          e.preventDefault();
          void copySelectionToClipboard();
          return false;
        }

        if (isExplicitTerminalPaste) {
          e.preventDefault();
          void pasteFromClipboard();
          return false;
        }
      }

      const shouldHandleCopy = isMac
        ? isPrimaryCopy
        : isExplicitTerminalCopy || (isPrimaryCopy && hasSelection);
      if (shouldHandleCopy) {
        e.preventDefault();
        void copySelectionToClipboard();
        return false;
      }

      const shouldHandlePaste = isMac
        ? isPrimaryPaste
        : isExplicitTerminalPaste || (!browserMode && isPrimaryPaste);
      if (shouldHandlePaste) {
        e.preventDefault();
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
    const FLOW_HIGH = 256 * 1024; // 256KB — pause PTY reader
    const FLOW_LOW = 32 * 1024; // 32KB — resume PTY reader
    let spawnReady = false;
    let spawnFailed = false;
    let disposed = false;
    let pendingExitPayload: {
      exit_code: number | null;
      signal: string | null;
      last_output: string[];
    } | null = null;

    function emitExit(payload: {
      exit_code: number | null;
      signal: string | null;
      last_output: string[];
    }) {
      if (!term) return;
      term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
      props.onExit?.(payload);
    }

    function clearOutputWriteWatchdog() {
      if (outputWriteWatchdog === undefined) return;
      clearTimeout(outputWriteWatchdog);
      outputWriteWatchdog = undefined;
    }

    function scheduleFlowRetry() {
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

    function requestPtyPause() {
      if (disposed || flowPauseApplied || flowPauseInFlight) return;
      flowPauseInFlight = true;
      recordFlowEvent('pause');
      invoke(IPC.PauseAgent, { agentId, reason: 'flow-control' })
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

    function requestPtyResume() {
      if (disposed || !flowPauseApplied || flowResumeInFlight) return;
      flowResumeInFlight = true;
      recordFlowEvent('resume');
      invoke(IPC.ResumeAgent, { agentId, reason: 'flow-control' })
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

    function flushOutputQueue() {
      if (restoringScrollback || !term || outputWriteInFlight || outputQueue.length === 0) return;

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
      const finishWrite = () => {
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

    function scheduleOutputFlush() {
      if (outputRaf !== undefined) return;
      outputRaf = requestAnimationFrame(() => {
        outputRaf = undefined;
        flushOutputQueue();
      });
    }

    function enqueueOutput(chunk: Uint8Array, receiveTs = 0) {
      watermark += chunk.length;

      // Pause PTY reader when xterm.js falls behind
      if (watermark > FLOW_HIGH && !flowPauseApplied) {
        requestPtyPause();
      }
      if (chunk.length > 0) touchWebglAddon(agentId);

      // Fast path: small interactive chunk (echo), no write in flight, queue empty.
      // Write synchronously to avoid RAF delay (~16ms).
      // Skip fast path while restoring scrollback — chunks must queue until restore completes.
      if (
        !restoringScrollback &&
        chunk.length < 256 &&
        !outputWriteInFlight &&
        outputQueue.length === 0 &&
        term
      ) {
        outputWriteInFlight = true;
        let writeCompleted = false;
        const statusPayload =
          chunk.length > STATUS_ANALYSIS_MAX_BYTES
            ? chunk.subarray(chunk.length - STATUS_ANALYSIS_MAX_BYTES)
            : chunk;
        const finishWrite = () => {
          if (writeCompleted) return;
          writeCompleted = true;
          clearOutputWriteWatchdog();
          outputWriteInFlight = false;
          watermark = Math.max(watermark - chunk.length, 0);
          recordOutputWritten(receiveTs);
          if (watermark < FLOW_LOW && flowPauseApplied) requestPtyResume();
          if (disposed) return;
          props.onData?.(statusPayload);
          if (outputQueue.length > 0) scheduleOutputFlush();
          else if (pendingExitPayload) {
            const exit = pendingExitPayload;
            pendingExitPayload = null;
            emitExit(exit);
          }
        };
        outputWriteWatchdog = window.setTimeout(finishWrite, OUTPUT_WRITE_CALLBACK_TIMEOUT_MS);
        term.write(chunk, finishWrite);
        return;
      }

      // Batched path for larger chunks
      outputQueue.push(chunk);
      outputQueuedBytes += chunk.length;
      if (receiveTs && !outputQueueFirstReceiveTs) outputQueueFirstReceiveTs = receiveTs;

      // While restoring scrollback, queue chunks but don't flush — the
      // restore finally block will flush them all at once.
      if (restoringScrollback) return;

      // Flush large bursts promptly to keep perceived latency low.
      if (outputQueuedBytes >= 64 * 1024) {
        flushOutputQueue();
      } else {
        scheduleOutputFlush();
      }
    }

    const onOutput = new Channel<PtyOutput>();
    let initialCommandSent = false;
    onOutput.onmessage = (msg) => {
      if (msg.type === 'Data') {
        const receiveTs = recordOutputReceived();
        const decoded = typeof msg.data === 'string' ? base64ToUint8Array(msg.data) : msg.data;
        // Only pay for UTF-8 decode when there are active latency probes.
        if (hasPendingProbes()) {
          detectProbeInOutput(PROBE_TEXT_DECODER.decode(decoded));
        }
        enqueueOutput(decoded, receiveTs);
        if (!initialCommandSent && props.initialCommand) {
          const cmd = props.initialCommand;
          initialCommandSent = true;
          setTimeout(() => enqueueInput(cmd + '\r'), 50);
        }
      } else if (msg.type === 'Exit') {
        pendingExitPayload = msg.data;
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
      }
    };

    let inputBuffer = '';
    let pendingInput = '';
    const inputQueue: string[] = [];
    let inputFlushTimer: number | undefined;
    let inputSendInFlight = false;

    function scheduleInputFlush(delay = 8) {
      if (inputFlushTimer !== undefined || disposed) return;
      inputFlushTimer = window.setTimeout(() => {
        inputFlushTimer = undefined;
        flushPendingInput();
        drainInputQueue();
      }, delay);
    }

    function drainInputQueue() {
      if (disposed || spawnFailed || inputSendInFlight || inputQueue.length === 0) return;
      if (!spawnReady) {
        scheduleInputFlush(INPUT_RETRY_DELAY_MS);
        return;
      }

      const data = inputQueue[0];
      if (!data) {
        inputQueue.shift();
        drainInputQueue();
        return;
      }

      inputSendInFlight = true;
      invoke(IPC.WriteToAgent, { agentId, data })
        .then(() => {
          inputQueue.shift();
        })
        .catch(() => {
          if (!disposed && !spawnFailed) {
            scheduleInputFlush(INPUT_RETRY_DELAY_MS);
          }
        })
        .finally(() => {
          inputSendInFlight = false;
          if (!disposed && inputQueue.length > 0) {
            if (spawnReady) drainInputQueue();
            else scheduleInputFlush(INPUT_RETRY_DELAY_MS);
          }
        });
    }

    function flushPendingInput() {
      if (inputFlushTimer !== undefined) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = undefined;
      }
      if (!pendingInput) return;
      inputQueue.push(pendingInput);
      pendingInput = '';
    }

    function enqueueInput(data: string) {
      pendingInput += data;
      if (pendingInput.length >= 2048) {
        flushPendingInput();
        drainInputQueue();
        return;
      }
      // Single character = interactive keystroke, flush immediately (setTimeout 0 ≈ 1-4ms)
      // Multi-char = paste or escape sequence, batch with 8ms delay
      scheduleInputFlush(data.length <= 1 ? 0 : 8);
    }

    // eslint-disable-next-line solid/reactivity -- event handler reads current prop values intentionally
    term.onData((data) => {
      if (props.onPromptDetected) {
        for (const ch of data) {
          if (ch === '\r') {
            const trimmed = inputBuffer.trim();
            if (trimmed) props.onPromptDetected?.(trimmed);
            inputBuffer = '';
          } else if (ch === '\x7f') {
            inputBuffer = inputBuffer.slice(0, -1);
          } else if (ch === '\x03' || ch === '\x15') {
            inputBuffer = '';
          } else if (ch === '\x1b') {
            // Skip escape sequences — break out, rest of data may contain seq chars
            break;
          } else if (ch >= ' ') {
            inputBuffer += ch;
          }
        }
      }
      enqueueInput(data);
    });

    let resizeFlushTimer: number | undefined;
    let pendingResize: { cols: number; rows: number } | null = null;
    let lastSentCols = -1;
    let lastSentRows = -1;

    function flushPendingResize() {
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

    // Only disable cursor blink for non-focused terminals to save one RAF
    // loop per terminal.
    createEffect(() => {
      if (!term) return;
      term.options.cursorBlink = props.isFocused === true;
      if (props.isFocused === true) touchWebglAddon(agentId);
    });

    // Restore terminal viewport from server-side scrollback buffer.
    // Called when the renderer is lost (WebGL context loss) or on
    // WebSocket reconnection. Fences new output during the restore to
    // prevent races between live chunks and term.reset().
    let restoreInFlight = false;
    let restoringScrollback = false;
    let restorePauseApplied = false;
    async function restoreScrollback() {
      if (disposed || !term || restoreInFlight) return;
      restoreInFlight = true;
      restoringScrollback = true;
      try {
        // Cancel any pending RAF flush — the guard in flushOutputQueue also
        // prevents it, but cancelling avoids unnecessary RAF callbacks.
        if (outputRaf !== undefined) {
          cancelAnimationFrame(outputRaf);
          outputRaf = undefined;
        }

        // Wait for any in-flight xterm.write() to complete.
        while ((outputWriteInFlight || flowPauseInFlight || flowResumeInFlight) && !disposed) {
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (disposed || !term) return;

        await invoke(IPC.PauseAgent, { agentId, reason: 'restore' });
        restorePauseApplied = true;

        const scrollback = await invoke<string | null>(IPC.GetAgentScrollback, { agentId });
        if (disposed || !term || !scrollback) return;

        // The restore snapshot already contains any queued output emitted
        // before the restore pause landed, so discard it and drop the
        // corresponding watermark bytes to avoid a stuck paused PTY.
        watermark = Math.max(watermark - outputQueuedBytes, 0);
        outputQueue = [];
        outputQueuedBytes = 0;
        outputQueueFirstReceiveTs = 0;
        if (watermark < FLOW_LOW && flowPauseApplied) {
          requestPtyResume();
        }

        term.reset();
        await new Promise<void>((resolve) => {
          term?.write(base64ToUint8Array(scrollback), resolve);
        });
        term?.scrollToBottom();
        touchWebglAddon(agentId);

        // Re-emit exit banner if the process already exited
        if (pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
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
        // Flush any output that arrived while we were restoring.
        if (outputQueue.length > 0) {
          flushOutputQueue();
        }
        // If Exit arrived during restore, emit the banner now that output is flushed.
        if (pendingExitPayload && !outputWriteInFlight && outputQueue.length === 0) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      }
    }

    // Load WebGL addon via pool to prevent context exhaustion across terminals.
    // The onRendererLost callback fires when this terminal's WebGL context is
    // evicted by the pool or lost by the browser — the DOM fallback renderer
    // takes over but the viewport is blank, so we restore from scrollback.
    acquireWebglAddon(agentId, term, restoreScrollback);

    // On WebSocket reconnection, the server flushes pending channel messages
    // on bind-channel. We do NOT call restoreScrollback() here because the
    // scrollback buffer overlaps with the pending queue, causing duplicate
    // output. The pending queue may lose ancient history beyond 2MB, but
    // duplication is worse UX. restoreScrollback() is reserved for WebGL
    // context loss where the viewport goes genuinely blank.

    void (async () => {
      try {
        await onOutput.ready;
        if (disposed) return;
        await invoke(IPC.SpawnAgent, {
          taskId,
          agentId,
          command: props.command,
          args: props.args,
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
      } catch (err) {
        if (disposed) return;
        spawnFailed = true;
        // Strip control/escape characters to prevent terminal escape injection
        // eslint-disable-next-line no-control-regex -- intentionally stripping control/escape chars to prevent terminal injection
        const safeErr = String(err).replace(/[\x00-\x1f\x7f]/g, '');
        term?.write(`\x1b[31mFailed to spawn: ${safeErr}\x1b[0m\r\n`);
        props.onExit?.({
          exit_code: null,
          signal: 'spawn_failed',
          last_output: [`Failed to spawn: ${safeErr}`],
        });
      }
    })();

    onCleanup(() => {
      flushPendingInput();
      disposed = true;
      flushPendingResize();
      if (inputFlushTimer !== undefined) clearTimeout(inputFlushTimer);
      if (resizeFlushTimer !== undefined) clearTimeout(resizeFlushTimer);
      if (outputRaf !== undefined) cancelAnimationFrame(outputRaf);
      if (flowRetryTimer !== undefined) clearTimeout(flowRetryTimer);
      clearOutputWriteWatchdog();
      if (flowPauseApplied || flowResumeInFlight || flowPauseInFlight) {
        fireAndForget(IPC.ResumeAgent, { agentId, reason: 'flow-control' });
      }
      if (restorePauseApplied) {
        fireAndForget(IPC.ResumeAgent, { agentId, reason: 'restore' });
      }
      fireAndForget(IPC.DetachAgentOutput, { agentId, channelId: onOutput.id });
      onOutput.cleanup?.();

      releaseWebglAddon(agentId);
      if (browserMode) containerRef.removeEventListener('copy', clearSelectionAfterCopy);
      unregisterTerminal(agentId);
      term?.dispose();
    });
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size === undefined || size === null || !term || !fitAddon) return;
    term.options.fontSize = size;
    markDirty(props.agentId);
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!term || !fitAddon) return;
    term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(props.agentId);
  });

  createEffect(() => {
    const preset = store.themePreset;
    if (!term) return;
    term.options.theme = getTerminalTheme(preset);
    markDirty(props.agentId);
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        padding: '4px 0 0 4px',
        contain: 'strict',
      }}
    />
  );
}
