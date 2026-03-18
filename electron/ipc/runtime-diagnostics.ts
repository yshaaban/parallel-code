import type {
  NumericTraceSummary,
  TerminalInputTraceClientUpdate,
  TerminalInputTraceDiagnosticsSnapshot,
  TerminalInputTraceMessage,
  TerminalInputTraceSample,
  TerminalInputTraceStageTimes,
  TerminalInputTraceSummary,
} from '../../src/domain/terminal-input-tracing.js';

export interface BackendRuntimeDiagnosticsSnapshot {
  browserChannels: {
    coalescedBytesSaved: number;
    coalescedMessages: number;
    degradedClientChannels: number;
    droppedDataMessages: number;
    maxQueueAgeMs: number;
    maxQueuedBytes: number;
    recoveredClientChannels: number;
    resetBindings: number;
    transportBusyDeferrals: number;
  };
  browserControl: {
    backpressureRejects: number;
    delayedQueueMaxAgeMs: number;
    delayedQueueMaxBytes: number;
    delayedQueueMaxDepth: number;
    notOpenRejects: number;
    sendErrors: number;
  };
  ptyInput: {
    clearedQueues: number;
    coalescedMessages: number;
    enqueuedChars: number;
    enqueuedMessages: number;
    flushes: number;
    maxQueuedChars: number;
    writeFailures: number;
  };
  previewValidation: {
    cacheHits: number;
    lastProbeDurationMs: number | null;
    probeFailures: number;
    probeSuccesses: number;
    revalidations: number;
  };
  reconnectSnapshots: {
    cacheHits: number;
    cacheInvalidations: number;
    cacheMisses: number;
  };
  scrollbackReplay: {
    batchRequests: number;
    cacheHits: number;
    cacheMisses: number;
    lastDurationMs: number | null;
    maxDurationMs: number;
    requestedAgents: number;
    returnedBytes: number;
  };
  terminalInputTracing: TerminalInputTraceDiagnosticsSnapshot;
}

let backendRuntimeDiagnostics: BackendRuntimeDiagnosticsSnapshot = createInitialSnapshot();
const MAX_COMPLETED_TERMINAL_INPUT_TRACES = 200;
const MAX_ACTIVE_TERMINAL_INPUT_TRACES = 512;
const TERMINAL_INPUT_TRACE_TIMEOUT_MS = 30_000;

const activeTerminalInputTraces = new Map<string, TerminalInputTraceSample>();
const completedTerminalInputTraces: TerminalInputTraceSample[] = [];
let droppedTerminalInputTraces = 0;

function getTraceNowMs(): number {
  return performance.timeOrigin + performance.now();
}

function createTraceKey(agentId: string, requestId: string): string {
  return `${agentId}:${requestId}`;
}

function createEmptyTraceStageTimes(): TerminalInputTraceStageTimes {
  return {
    bufferedAtMs: null,
    outputReceivedAtMs: null,
    outputRenderedAtMs: null,
    ptyEnqueuedAtMs: null,
    ptyFlushedAtMs: null,
    ptyWrittenAtMs: null,
    sendStartedAtMs: null,
    serverReceivedAtMs: null,
    startedAtMs: null,
  };
}

function createEmptyNumericTraceSummary(): NumericTraceSummary {
  return {
    avg: 0,
    count: 0,
    max: 0,
    min: 0,
    p50: 0,
    p95: 0,
  };
}

function createEmptyTerminalInputTraceSummary(): TerminalInputTraceSummary {
  return {
    clientBufferMs: createEmptyNumericTraceSummary(),
    clientSendMs: createEmptyNumericTraceSummary(),
    count: 0,
    endToEndMs: createEmptyNumericTraceSummary(),
    renderMs: createEmptyNumericTraceSummary(),
    sendToEchoMs: createEmptyNumericTraceSummary(),
    serverQueueMs: createEmptyNumericTraceSummary(),
    transportResidualMs: createEmptyNumericTraceSummary(),
  };
}

function createTraceSummary(values: number[]): NumericTraceSummary {
  if (values.length === 0) {
    return createEmptyNumericTraceSummary();
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((accumulator, value) => accumulator + value, 0);
  const getValue = (index: number): number => sorted[index] ?? 0;
  const getPercentile = (fraction: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return getValue(index);
  };

  return {
    avg: Math.round((sum / sorted.length) * 100) / 100,
    count: sorted.length,
    max: getValue(sorted.length - 1),
    min: getValue(0),
    p50: getPercentile(0.5),
    p95: getPercentile(0.95),
  };
}

function pushCompletedTerminalInputTrace(sample: TerminalInputTraceSample): void {
  completedTerminalInputTraces.push(sample);
  while (completedTerminalInputTraces.length > MAX_COMPLETED_TERMINAL_INPUT_TRACES) {
    completedTerminalInputTraces.shift();
  }
}

function finalizeTerminalInputTrace(
  traceKey: string,
  update: (sample: TerminalInputTraceSample) => TerminalInputTraceSample,
): void {
  const sample = activeTerminalInputTraces.get(traceKey);
  if (!sample) {
    return;
  }

  activeTerminalInputTraces.delete(traceKey);
  pushCompletedTerminalInputTrace(update(sample));
}

function trimActiveTerminalInputTraces(): void {
  while (activeTerminalInputTraces.size > MAX_ACTIVE_TERMINAL_INPUT_TRACES) {
    const oldestTraceKey = activeTerminalInputTraces.keys().next().value;
    if (typeof oldestTraceKey !== 'string') {
      break;
    }

    activeTerminalInputTraces.delete(oldestTraceKey);
    droppedTerminalInputTraces += 1;
  }
}

function pruneExpiredTerminalInputTraces(): void {
  const now = getTraceNowMs();
  for (const [traceKey, sample] of activeTerminalInputTraces) {
    const startedAtMs = sample.stages.startedAtMs ?? sample.stages.serverReceivedAtMs;
    if (startedAtMs === null || now - startedAtMs < TERMINAL_INPUT_TRACE_TIMEOUT_MS) {
      continue;
    }

    finalizeTerminalInputTrace(traceKey, (currentSample) => ({
      ...currentSample,
      completed: false,
      failureReason: currentSample.failureReason ?? 'timeout',
    }));
  }
}

function buildTerminalInputTraceSummary(
  samples: readonly TerminalInputTraceSample[],
): TerminalInputTraceSummary {
  const clientBufferMs: number[] = [];
  const clientSendMs: number[] = [];
  const serverQueueMs: number[] = [];
  const sendToEchoMs: number[] = [];
  const transportResidualMs: number[] = [];
  const renderMs: number[] = [];
  const endToEndMs: number[] = [];

  for (const sample of samples) {
    if (!sample.completed) {
      continue;
    }

    const {
      bufferedAtMs,
      outputReceivedAtMs,
      outputRenderedAtMs,
      ptyWrittenAtMs,
      sendStartedAtMs,
      serverReceivedAtMs,
      startedAtMs,
    } = sample.stages;

    if (startedAtMs !== null && bufferedAtMs !== null) {
      clientBufferMs.push(Math.max(0, bufferedAtMs - startedAtMs));
    }

    if (bufferedAtMs !== null && sendStartedAtMs !== null) {
      clientSendMs.push(Math.max(0, sendStartedAtMs - bufferedAtMs));
    }

    if (serverReceivedAtMs !== null && ptyWrittenAtMs !== null) {
      serverQueueMs.push(Math.max(0, ptyWrittenAtMs - serverReceivedAtMs));
    }

    if (sendStartedAtMs !== null && outputReceivedAtMs !== null) {
      sendToEchoMs.push(Math.max(0, outputReceivedAtMs - sendStartedAtMs));
      if (serverReceivedAtMs !== null && ptyWrittenAtMs !== null) {
        transportResidualMs.push(
          Math.max(0, outputReceivedAtMs - sendStartedAtMs - (ptyWrittenAtMs - serverReceivedAtMs)),
        );
      }
    }

    if (outputReceivedAtMs !== null && outputRenderedAtMs !== null) {
      renderMs.push(Math.max(0, outputRenderedAtMs - outputReceivedAtMs));
    }

    if (startedAtMs !== null && outputRenderedAtMs !== null) {
      endToEndMs.push(Math.max(0, outputRenderedAtMs - startedAtMs));
    }
  }

  return {
    clientBufferMs: createTraceSummary(clientBufferMs),
    clientSendMs: createTraceSummary(clientSendMs),
    count: samples.filter((sample) => sample.completed).length,
    endToEndMs: createTraceSummary(endToEndMs),
    renderMs: createTraceSummary(renderMs),
    sendToEchoMs: createTraceSummary(sendToEchoMs),
    serverQueueMs: createTraceSummary(serverQueueMs),
    transportResidualMs: createTraceSummary(transportResidualMs),
  };
}

function createInitialSnapshot(): BackendRuntimeDiagnosticsSnapshot {
  return {
    browserChannels: {
      coalescedBytesSaved: 0,
      coalescedMessages: 0,
      degradedClientChannels: 0,
      droppedDataMessages: 0,
      maxQueueAgeMs: 0,
      maxQueuedBytes: 0,
      recoveredClientChannels: 0,
      resetBindings: 0,
      transportBusyDeferrals: 0,
    },
    browserControl: {
      backpressureRejects: 0,
      delayedQueueMaxAgeMs: 0,
      delayedQueueMaxBytes: 0,
      delayedQueueMaxDepth: 0,
      notOpenRejects: 0,
      sendErrors: 0,
    },
    ptyInput: {
      clearedQueues: 0,
      coalescedMessages: 0,
      enqueuedChars: 0,
      enqueuedMessages: 0,
      flushes: 0,
      maxQueuedChars: 0,
      writeFailures: 0,
    },
    previewValidation: {
      cacheHits: 0,
      lastProbeDurationMs: null,
      probeFailures: 0,
      probeSuccesses: 0,
      revalidations: 0,
    },
    reconnectSnapshots: {
      cacheHits: 0,
      cacheInvalidations: 0,
      cacheMisses: 0,
    },
    scrollbackReplay: {
      batchRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastDurationMs: null,
      maxDurationMs: 0,
      requestedAgents: 0,
      returnedBytes: 0,
    },
    terminalInputTracing: {
      activeTraceCount: 0,
      completedTraces: [],
      droppedTraces: 0,
      summary: createEmptyTerminalInputTraceSummary(),
    },
  };
}

export function resetBackendRuntimeDiagnostics(): void {
  backendRuntimeDiagnostics = createInitialSnapshot();
  activeTerminalInputTraces.clear();
  completedTerminalInputTraces.length = 0;
  droppedTerminalInputTraces = 0;
}

export function getBackendRuntimeDiagnosticsSnapshot(): BackendRuntimeDiagnosticsSnapshot {
  pruneExpiredTerminalInputTraces();
  const completedTraces = completedTerminalInputTraces.map((sample) => ({
    ...sample,
    stages: { ...sample.stages },
  }));

  return {
    browserChannels: { ...backendRuntimeDiagnostics.browserChannels },
    browserControl: { ...backendRuntimeDiagnostics.browserControl },
    ptyInput: { ...backendRuntimeDiagnostics.ptyInput },
    previewValidation: { ...backendRuntimeDiagnostics.previewValidation },
    reconnectSnapshots: { ...backendRuntimeDiagnostics.reconnectSnapshots },
    scrollbackReplay: { ...backendRuntimeDiagnostics.scrollbackReplay },
    terminalInputTracing: {
      activeTraceCount: activeTerminalInputTraces.size,
      completedTraces,
      droppedTraces: droppedTerminalInputTraces,
      summary: buildTerminalInputTraceSummary(completedTraces),
    },
  };
}

export function recordTerminalInputTraceServerReceived(details: {
  agentId: string;
  clientId: string | null;
  requestId: string;
  taskId: string | null;
  trace: TerminalInputTraceMessage;
  inputPreview: string;
}): void {
  pruneExpiredTerminalInputTraces();
  activeTerminalInputTraces.set(createTraceKey(details.agentId, details.requestId), {
    agentId: details.agentId,
    clientId: details.clientId,
    completed: false,
    failureReason: null,
    inputChars: details.trace.inputChars,
    inputKind: details.trace.inputKind,
    inputPreview: details.inputPreview,
    requestId: details.requestId,
    stages: {
      ...createEmptyTraceStageTimes(),
      bufferedAtMs: details.trace.bufferedAtMs,
      sendStartedAtMs: details.trace.sendStartedAtMs,
      serverReceivedAtMs: getTraceNowMs(),
      startedAtMs: details.trace.startedAtMs,
    },
    taskId: details.taskId,
  });
  trimActiveTerminalInputTraces();
}

export function recordTerminalInputTraceClientDisconnected(clientId: string | null): void {
  if (!clientId) {
    return;
  }

  for (const [traceKey, sample] of activeTerminalInputTraces) {
    if (sample.clientId !== clientId) {
      continue;
    }

    finalizeTerminalInputTrace(traceKey, (currentSample) => ({
      ...currentSample,
      completed: false,
      failureReason: currentSample.failureReason ?? 'client-disconnected',
    }));
  }
}

export function recordTerminalInputTracePtyEnqueued(agentId: string, requestId: string): void {
  const sample = activeTerminalInputTraces.get(createTraceKey(agentId, requestId));
  if (!sample) {
    return;
  }

  sample.stages.ptyEnqueuedAtMs = getTraceNowMs();
}

export function recordTerminalInputTracePtyFlushed(agentId: string, requestId: string): void {
  const sample = activeTerminalInputTraces.get(createTraceKey(agentId, requestId));
  if (!sample) {
    return;
  }

  sample.stages.ptyFlushedAtMs = getTraceNowMs();
}

export function recordTerminalInputTracePtyWritten(agentId: string, requestId: string): void {
  const sample = activeTerminalInputTraces.get(createTraceKey(agentId, requestId));
  if (!sample) {
    return;
  }

  sample.stages.ptyWrittenAtMs = getTraceNowMs();
}

export function recordTerminalInputTraceFailure(
  agentId: string,
  requestId: string,
  reason: string,
): void {
  finalizeTerminalInputTrace(createTraceKey(agentId, requestId), (sample) => ({
    ...sample,
    completed: false,
    failureReason: reason,
  }));
}

export function recordTerminalInputTraceClientUpdate(update: TerminalInputTraceClientUpdate): void {
  finalizeTerminalInputTrace(createTraceKey(update.agentId, update.requestId), (sample) => ({
    ...sample,
    completed: true,
    stages: {
      ...sample.stages,
      outputReceivedAtMs: update.outputReceivedAtMs,
      outputRenderedAtMs: update.outputRenderedAtMs,
    },
  }));
}

export function recordBrowserChannelCoalesced(savedBytes: number): void {
  backendRuntimeDiagnostics.browserChannels.coalescedMessages += 1;
  backendRuntimeDiagnostics.browserChannels.coalescedBytesSaved += savedBytes;
}

export function recordBrowserChannelDegraded(queueAgeMs: number): void {
  backendRuntimeDiagnostics.browserChannels.degradedClientChannels += 1;
  if (queueAgeMs > backendRuntimeDiagnostics.browserChannels.maxQueueAgeMs) {
    backendRuntimeDiagnostics.browserChannels.maxQueueAgeMs = queueAgeMs;
  }
}

export function recordBrowserChannelDroppedData(): void {
  backendRuntimeDiagnostics.browserChannels.droppedDataMessages += 1;
}

export function recordBrowserChannelQueuedBytes(queuedBytes: number): void {
  if (queuedBytes > backendRuntimeDiagnostics.browserChannels.maxQueuedBytes) {
    backendRuntimeDiagnostics.browserChannels.maxQueuedBytes = queuedBytes;
  }
}

export function recordBrowserChannelQueueAge(queueAgeMs: number): void {
  if (queueAgeMs > backendRuntimeDiagnostics.browserChannels.maxQueueAgeMs) {
    backendRuntimeDiagnostics.browserChannels.maxQueueAgeMs = queueAgeMs;
  }
}

export function recordBrowserChannelRecovered(): void {
  backendRuntimeDiagnostics.browserChannels.recoveredClientChannels += 1;
}

export function recordBrowserChannelResetBinding(): void {
  backendRuntimeDiagnostics.browserChannels.resetBindings += 1;
}

export function recordBrowserChannelTransportBusyDeferral(): void {
  backendRuntimeDiagnostics.browserChannels.transportBusyDeferrals += 1;
}

export function recordReconnectSnapshotCacheHit(): void {
  backendRuntimeDiagnostics.reconnectSnapshots.cacheHits += 1;
}

export function recordReconnectSnapshotCacheMiss(): void {
  backendRuntimeDiagnostics.reconnectSnapshots.cacheMisses += 1;
}

export function recordReconnectSnapshotInvalidation(): void {
  backendRuntimeDiagnostics.reconnectSnapshots.cacheInvalidations += 1;
}

export function recordScrollbackReplay(
  agentCount: number,
  returnedBytes: number,
  durationMs: number,
): void {
  backendRuntimeDiagnostics.scrollbackReplay.batchRequests += 1;
  backendRuntimeDiagnostics.scrollbackReplay.requestedAgents += agentCount;
  backendRuntimeDiagnostics.scrollbackReplay.returnedBytes += returnedBytes;
  backendRuntimeDiagnostics.scrollbackReplay.lastDurationMs = durationMs;
  if (durationMs > backendRuntimeDiagnostics.scrollbackReplay.maxDurationMs) {
    backendRuntimeDiagnostics.scrollbackReplay.maxDurationMs = durationMs;
  }
}

export function recordScrollbackReplayCacheHit(): void {
  backendRuntimeDiagnostics.scrollbackReplay.cacheHits += 1;
}

export function recordScrollbackReplayCacheMiss(): void {
  backendRuntimeDiagnostics.scrollbackReplay.cacheMisses += 1;
}

export function recordPtyInputEnqueue(chars: number, queuedChars: number): void {
  backendRuntimeDiagnostics.ptyInput.enqueuedMessages += 1;
  backendRuntimeDiagnostics.ptyInput.enqueuedChars += chars;
  if (queuedChars > backendRuntimeDiagnostics.ptyInput.maxQueuedChars) {
    backendRuntimeDiagnostics.ptyInput.maxQueuedChars = queuedChars;
  }
}

export function recordPtyInputFlush(messageCount: number): void {
  backendRuntimeDiagnostics.ptyInput.flushes += 1;
  if (messageCount > 1) {
    backendRuntimeDiagnostics.ptyInput.coalescedMessages += messageCount - 1;
  }
}

export function recordPtyInputQueueCleared(): void {
  backendRuntimeDiagnostics.ptyInput.clearedQueues += 1;
}

export function recordPtyInputWriteFailure(): void {
  backendRuntimeDiagnostics.ptyInput.writeFailures += 1;
}

export function recordPreviewCacheHit(): void {
  backendRuntimeDiagnostics.previewValidation.cacheHits += 1;
}

export function recordPreviewProbeResult(success: boolean, durationMs: number): void {
  backendRuntimeDiagnostics.previewValidation.lastProbeDurationMs = durationMs;
  if (success) {
    backendRuntimeDiagnostics.previewValidation.probeSuccesses += 1;
    return;
  }

  backendRuntimeDiagnostics.previewValidation.probeFailures += 1;
}

export function recordPreviewRevalidation(): void {
  backendRuntimeDiagnostics.previewValidation.revalidations += 1;
}

export function recordBrowserControlSendResult(
  reason: 'backpressure' | 'not-open' | 'send-error',
): void {
  switch (reason) {
    case 'backpressure':
      backendRuntimeDiagnostics.browserControl.backpressureRejects += 1;
      return;
    case 'not-open':
      backendRuntimeDiagnostics.browserControl.notOpenRejects += 1;
      return;
    case 'send-error':
      backendRuntimeDiagnostics.browserControl.sendErrors += 1;
      return;
  }
}

export function recordBrowserControlDelayedQueue(
  queueDepth: number,
  queuedBytes: number,
  queueAgeMs: number,
): void {
  if (queueDepth > backendRuntimeDiagnostics.browserControl.delayedQueueMaxDepth) {
    backendRuntimeDiagnostics.browserControl.delayedQueueMaxDepth = queueDepth;
  }

  if (queuedBytes > backendRuntimeDiagnostics.browserControl.delayedQueueMaxBytes) {
    backendRuntimeDiagnostics.browserControl.delayedQueueMaxBytes = queuedBytes;
  }

  if (queueAgeMs > backendRuntimeDiagnostics.browserControl.delayedQueueMaxAgeMs) {
    backendRuntimeDiagnostics.browserControl.delayedQueueMaxAgeMs = queueAgeMs;
  }
}
