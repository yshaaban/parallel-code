import type {
  NumericTraceSummary,
  TerminalInputTraceClientUpdate,
  TerminalInputTraceDiagnosticsSnapshot,
  TerminalInputTraceMessage,
  TerminalInputTraceSample,
  TerminalInputTraceStageTimes,
  TerminalInputTraceSummary,
} from '../../src/domain/terminal-input-tracing.js';
import { stripAnsi } from '../../src/lib/prompt-detection.js';
import {
  getBackendWorkQueueDiagnostics,
  type BackendWorkQueueDiagnostics,
} from './backend-work-queue.js';

export type PreviewProbeFailureReason = 'connection-error' | 'timeout';

export interface BackendRuntimeDiagnosticsSnapshot {
  backendWorkQueue?: BackendWorkQueueDiagnostics;
  gitSubprocessCount: number;
  browserChannels: {
    coalescedBytesSaved: number;
    coalescedMessages: number;
    degradedClientChannels: number;
    droppedDataMessages: number;
    maxQueueAgeMs: number;
    maxQueuedBytes: number;
    recoveredClientChannels: number;
    recoveryRequiredClientChannels: number;
    recoveryRequiredPendingChannels: number;
    resetBindings: number;
    transportBusyDeferrals: number;
  };
  browserControl: {
    backpressureRejects: number;
    delayedQueueMaxAgeMs: number;
    delayedQueueMaxBytes: number;
    delayedQueueMaxDepth: number;
    maxBufferedAmountBytes: number;
    notOpenRejects: number;
    sendErrors: number;
    simulatedDroppedSends: number;
  };
  agentSessionStartup: {
    admissionWaits: number;
    batchRequests: number;
    createdSessions: number;
    existingSessions: number;
    maxActiveSpawns: number;
    maxAdmissionWaitMs: number;
    maxPendingSpawns: number;
    maxSpawnDurationMs: number;
    requestedSessions: number;
    spawnDurationCount: number;
    totalAdmissionWaitMs: number;
    totalSpawnDurationMs: number;
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
    connectionFailures: number;
    lastProbeFailureReason: PreviewProbeFailureReason | null;
    lastProbeDurationMs: number | null;
    lastProbeTarget: string | null;
    maxProbeDurationMs: number;
    probeFailures: number;
    probeSuccesses: number;
    revalidations: number;
    timeoutFailures: number;
  };
  reconnectSnapshots: {
    cacheHits: number;
    cacheInvalidations: number;
    cacheMisses: number;
    revisionSkips: number;
  };
  terminalScrollback: {
    growAllocatedBytes: number;
    growAllocations: number;
    initialAllocatedBytes: number;
    initialAllocations: number;
    maxAllocatedCapacityBytes: number;
  };
  scrollbackReplay: {
    batchRequests: number;
    cacheHits: number;
    cacheMisses: number;
    deltaResponses: number;
    lastDurationMs: number | null;
    maxDurationMs: number;
    noopResponses: number;
    requestedAgents: number;
    returnedBytes: number;
    snapshotResponses: number;
  };
  terminalRecovery: {
    cursorDeltaResponses: number;
    deltaResponses: number;
    lastDurationMs: number | null;
    maxDurationMs: number;
    noopResponses: number;
    requests: number;
    returnedBytes: number;
    snapshotResponses: number;
    tailDeltaResponses: number;
    tailNeededResponses: number;
    terminalStateFallbacks: number;
    terminalStateResponses: number;
  };
  terminalStateMirror: {
    instances: number;
    maxPendingOperations: number;
    outputBytes: number;
    outputEnqueues: number;
    operationDrainCount: number;
    operationDrainMaxDurationMs: number;
    operationDrainTotalDurationMs: number;
    resizeEnqueues: number;
    serializeCacheHits: number;
    serializeRequests: number;
    serializeTotalBytes: number;
    serializeTotalDurationMs: number;
    serializeLastDurationMs: number | null;
    serializeMaxDurationMs: number;
  };
  terminalInputTracing: TerminalInputTraceDiagnosticsSnapshot;
}

let backendRuntimeDiagnostics: BackendRuntimeDiagnosticsSnapshot = createInitialSnapshot();
let backendRuntimeDiagnosticsGeneration = 0;
const MAX_COMPLETED_TERMINAL_INPUT_TRACES = 200;
const MAX_ACTIVE_TERMINAL_INPUT_TRACES = 512;
const TERMINAL_INPUT_TRACE_TIMEOUT_MS = 30_000;
const INPUT_TRACE_OUTPUT_TAIL_MAX_CHARS = 4 * 1024;

const activeTerminalInputTraces = new Map<string, TerminalInputTraceSample>();
const completedTerminalInputTraces: TerminalInputTraceSample[] = [];
const terminalInputTraceOutputTails = new Map<string, string>();
let droppedTerminalInputTraces = 0;

function getTraceNowMs(): number {
  return performance.timeOrigin + performance.now();
}

function createTraceKey(agentId: string, requestId: string): string {
  return `${agentId}:${requestId}`;
}

function createEmptyTraceStageTimes(): TerminalInputTraceStageTimes {
  return {
    backendOutputFlushedAtMs: null,
    bufferedAtMs: null,
    commandResultSentAtMs: null,
    outputReceivedAtMs: null,
    outputRenderedAtMs: null,
    outputTransportReceivedAtMs: null,
    ptyEnqueuedAtMs: null,
    ptyFlushedAtMs: null,
    ptyOutputReceivedAtMs: null,
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
    backendOutputBufferMs: createEmptyNumericTraceSummary(),
    browserChannelDispatchMs: createEmptyNumericTraceSummary(),
    browserDeliveryMs: createEmptyNumericTraceSummary(),
    browserTransportDeliveryMs: createEmptyNumericTraceSummary(),
    clientBufferMs: createEmptyNumericTraceSummary(),
    clientSendMs: createEmptyNumericTraceSummary(),
    commandAckMs: createEmptyNumericTraceSummary(),
    count: 0,
    endToEndMs: createEmptyNumericTraceSummary(),
    ptyEchoMs: createEmptyNumericTraceSummary(),
    ptyWriteToCommandAckMs: createEmptyNumericTraceSummary(),
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

function hasActiveTerminalInputTraceForAgent(agentId: string): boolean {
  for (const sample of activeTerminalInputTraces.values()) {
    if (sample.agentId === agentId) {
      return true;
    }
  }

  return false;
}

function pruneTerminalInputTraceOutputTail(agentId: string): void {
  if (!hasActiveTerminalInputTraceForAgent(agentId)) {
    terminalInputTraceOutputTails.delete(agentId);
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
  pruneTerminalInputTraceOutputTail(sample.agentId);
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
  const backendOutputBufferMs: number[] = [];
  const browserChannelDispatchMs: number[] = [];
  const browserDeliveryMs: number[] = [];
  const browserTransportDeliveryMs: number[] = [];
  const clientBufferMs: number[] = [];
  const clientSendMs: number[] = [];
  const commandAckMs: number[] = [];
  const ptyEchoMs: number[] = [];
  const ptyWriteToCommandAckMs: number[] = [];
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
      backendOutputFlushedAtMs,
      bufferedAtMs,
      commandResultSentAtMs,
      outputReceivedAtMs,
      outputRenderedAtMs,
      outputTransportReceivedAtMs,
      ptyOutputReceivedAtMs,
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

    if (serverReceivedAtMs !== null && commandResultSentAtMs !== null) {
      commandAckMs.push(Math.max(0, commandResultSentAtMs - serverReceivedAtMs));
    }

    if (ptyWrittenAtMs !== null && commandResultSentAtMs !== null) {
      ptyWriteToCommandAckMs.push(Math.max(0, commandResultSentAtMs - ptyWrittenAtMs));
    }

    if (ptyWrittenAtMs !== null && ptyOutputReceivedAtMs !== null) {
      ptyEchoMs.push(Math.max(0, ptyOutputReceivedAtMs - ptyWrittenAtMs));
    }

    if (ptyOutputReceivedAtMs !== null && backendOutputFlushedAtMs !== null) {
      backendOutputBufferMs.push(Math.max(0, backendOutputFlushedAtMs - ptyOutputReceivedAtMs));
    }

    if (backendOutputFlushedAtMs !== null && outputReceivedAtMs !== null) {
      browserDeliveryMs.push(Math.max(0, outputReceivedAtMs - backendOutputFlushedAtMs));
    }

    if (backendOutputFlushedAtMs !== null && outputTransportReceivedAtMs !== null) {
      browserTransportDeliveryMs.push(
        Math.max(0, outputTransportReceivedAtMs - backendOutputFlushedAtMs),
      );
    }

    if (outputTransportReceivedAtMs !== null && outputReceivedAtMs !== null) {
      browserChannelDispatchMs.push(Math.max(0, outputReceivedAtMs - outputTransportReceivedAtMs));
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
    backendOutputBufferMs: createTraceSummary(backendOutputBufferMs),
    browserChannelDispatchMs: createTraceSummary(browserChannelDispatchMs),
    browserDeliveryMs: createTraceSummary(browserDeliveryMs),
    browserTransportDeliveryMs: createTraceSummary(browserTransportDeliveryMs),
    clientBufferMs: createTraceSummary(clientBufferMs),
    clientSendMs: createTraceSummary(clientSendMs),
    commandAckMs: createTraceSummary(commandAckMs),
    count: samples.filter((sample) => sample.completed).length,
    endToEndMs: createTraceSummary(endToEndMs),
    ptyEchoMs: createTraceSummary(ptyEchoMs),
    ptyWriteToCommandAckMs: createTraceSummary(ptyWriteToCommandAckMs),
    renderMs: createTraceSummary(renderMs),
    sendToEchoMs: createTraceSummary(sendToEchoMs),
    serverQueueMs: createTraceSummary(serverQueueMs),
    transportResidualMs: createTraceSummary(transportResidualMs),
  };
}

function createInitialSnapshot(): BackendRuntimeDiagnosticsSnapshot {
  return {
    gitSubprocessCount: 0,
    browserChannels: {
      coalescedBytesSaved: 0,
      coalescedMessages: 0,
      degradedClientChannels: 0,
      droppedDataMessages: 0,
      maxQueueAgeMs: 0,
      maxQueuedBytes: 0,
      recoveredClientChannels: 0,
      recoveryRequiredClientChannels: 0,
      recoveryRequiredPendingChannels: 0,
      resetBindings: 0,
      transportBusyDeferrals: 0,
    },
    browserControl: {
      backpressureRejects: 0,
      delayedQueueMaxAgeMs: 0,
      delayedQueueMaxBytes: 0,
      delayedQueueMaxDepth: 0,
      maxBufferedAmountBytes: 0,
      notOpenRejects: 0,
      sendErrors: 0,
      simulatedDroppedSends: 0,
    },
    agentSessionStartup: {
      admissionWaits: 0,
      batchRequests: 0,
      createdSessions: 0,
      existingSessions: 0,
      maxActiveSpawns: 0,
      maxAdmissionWaitMs: 0,
      maxPendingSpawns: 0,
      maxSpawnDurationMs: 0,
      requestedSessions: 0,
      spawnDurationCount: 0,
      totalAdmissionWaitMs: 0,
      totalSpawnDurationMs: 0,
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
      connectionFailures: 0,
      lastProbeFailureReason: null,
      lastProbeDurationMs: null,
      lastProbeTarget: null,
      maxProbeDurationMs: 0,
      probeFailures: 0,
      probeSuccesses: 0,
      revalidations: 0,
      timeoutFailures: 0,
    },
    reconnectSnapshots: {
      cacheHits: 0,
      cacheInvalidations: 0,
      cacheMisses: 0,
      revisionSkips: 0,
    },
    terminalScrollback: {
      growAllocatedBytes: 0,
      growAllocations: 0,
      initialAllocatedBytes: 0,
      initialAllocations: 0,
      maxAllocatedCapacityBytes: 0,
    },
    scrollbackReplay: {
      batchRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      deltaResponses: 0,
      lastDurationMs: null,
      maxDurationMs: 0,
      noopResponses: 0,
      requestedAgents: 0,
      returnedBytes: 0,
      snapshotResponses: 0,
    },
    terminalRecovery: {
      cursorDeltaResponses: 0,
      deltaResponses: 0,
      lastDurationMs: null,
      maxDurationMs: 0,
      noopResponses: 0,
      requests: 0,
      returnedBytes: 0,
      snapshotResponses: 0,
      tailDeltaResponses: 0,
      tailNeededResponses: 0,
      terminalStateFallbacks: 0,
      terminalStateResponses: 0,
    },
    terminalStateMirror: {
      instances: 0,
      maxPendingOperations: 0,
      outputBytes: 0,
      outputEnqueues: 0,
      operationDrainCount: 0,
      operationDrainMaxDurationMs: 0,
      operationDrainTotalDurationMs: 0,
      resizeEnqueues: 0,
      serializeCacheHits: 0,
      serializeRequests: 0,
      serializeTotalBytes: 0,
      serializeTotalDurationMs: 0,
      serializeLastDurationMs: null,
      serializeMaxDurationMs: 0,
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
  backendRuntimeDiagnosticsGeneration += 1;
  activeTerminalInputTraces.clear();
  completedTerminalInputTraces.length = 0;
  terminalInputTraceOutputTails.clear();
  droppedTerminalInputTraces = 0;
}

export function getBackendRuntimeDiagnosticsGeneration(): number {
  return backendRuntimeDiagnosticsGeneration;
}

export function getBackendRuntimeDiagnosticsSnapshot(): BackendRuntimeDiagnosticsSnapshot {
  pruneExpiredTerminalInputTraces();
  const completedTraces = completedTerminalInputTraces.map((sample) => ({
    ...sample,
    stages: { ...sample.stages },
  }));

  return {
    backendWorkQueue: getBackendWorkQueueDiagnostics(),
    gitSubprocessCount: backendRuntimeDiagnostics.gitSubprocessCount,
    browserChannels: { ...backendRuntimeDiagnostics.browserChannels },
    browserControl: { ...backendRuntimeDiagnostics.browserControl },
    agentSessionStartup: { ...backendRuntimeDiagnostics.agentSessionStartup },
    ptyInput: { ...backendRuntimeDiagnostics.ptyInput },
    previewValidation: { ...backendRuntimeDiagnostics.previewValidation },
    reconnectSnapshots: { ...backendRuntimeDiagnostics.reconnectSnapshots },
    terminalScrollback: { ...backendRuntimeDiagnostics.terminalScrollback },
    scrollbackReplay: { ...backendRuntimeDiagnostics.scrollbackReplay },
    terminalRecovery: { ...backendRuntimeDiagnostics.terminalRecovery },
    terminalStateMirror: { ...backendRuntimeDiagnostics.terminalStateMirror },
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
  const traceKey = createTraceKey(details.agentId, details.requestId);
  const existingSample = activeTerminalInputTraces.get(traceKey);
  const serverReceivedAtMs = existingSample?.stages.serverReceivedAtMs ?? getTraceNowMs();
  activeTerminalInputTraces.set(traceKey, {
    agentId: details.agentId,
    clientId: details.clientId,
    completed: false,
    echoText: details.trace.echoText ?? null,
    failureReason: null,
    inputChars: details.trace.inputChars,
    inputKind: details.trace.inputKind,
    inputPreview: details.inputPreview,
    requestId: details.requestId,
    stages: {
      ...createEmptyTraceStageTimes(),
      ...existingSample?.stages,
      bufferedAtMs: details.trace.bufferedAtMs,
      sendStartedAtMs: details.trace.sendStartedAtMs,
      serverReceivedAtMs,
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

export function recordTerminalInputTraceCommandResultSent(
  agentId: string,
  requestId: string,
): void {
  const sample = activeTerminalInputTraces.get(createTraceKey(agentId, requestId));
  if (!sample || sample.stages.commandResultSentAtMs !== null) {
    return;
  }

  sample.stages.commandResultSentAtMs = getTraceNowMs();
}

function updateTerminalInputTraceOutputTail(agentId: string, outputText: string): string {
  const visibleOutputText = stripAnsi(outputText).replace(/\r/g, '');
  const nextTail = `${terminalInputTraceOutputTails.get(agentId) ?? ''}${visibleOutputText}`.slice(
    -INPUT_TRACE_OUTPUT_TAIL_MAX_CHARS,
  );
  terminalInputTraceOutputTails.set(agentId, nextTail);
  return nextTail;
}

function getTerminalInputTraceOutputTail(agentId: string, outputText: string): string {
  if (terminalInputTraceOutputTails.has(agentId)) {
    return terminalInputTraceOutputTails.get(agentId) ?? '';
  }

  return updateTerminalInputTraceOutputTail(agentId, outputText);
}

function traceEchoTextMatches(
  sample: TerminalInputTraceSample,
  visibleOutputTail: string,
): boolean {
  return sample.echoText !== null && visibleOutputTail.includes(sample.echoText);
}

export function recordTerminalInputTracePtyOutput(agentId: string, outputText: string): void {
  if (outputText.length === 0 || !hasActiveTerminalInputTraceForAgent(agentId)) {
    return;
  }

  const visibleOutputTail = updateTerminalInputTraceOutputTail(agentId, outputText);
  const now = getTraceNowMs();
  for (const sample of activeTerminalInputTraces.values()) {
    if (
      sample.agentId !== agentId ||
      sample.stages.ptyWrittenAtMs === null ||
      sample.stages.ptyOutputReceivedAtMs !== null ||
      !traceEchoTextMatches(sample, visibleOutputTail)
    ) {
      continue;
    }

    sample.stages.ptyOutputReceivedAtMs = now;
  }
}

export function recordTerminalInputTraceBackendOutputFlushed(
  agentId: string,
  outputText: string,
): void {
  if (outputText.length === 0 || !hasActiveTerminalInputTraceForAgent(agentId)) {
    return;
  }

  const visibleOutputTail = getTerminalInputTraceOutputTail(agentId, outputText);
  const now = getTraceNowMs();
  for (const sample of activeTerminalInputTraces.values()) {
    if (
      sample.agentId !== agentId ||
      sample.stages.ptyWrittenAtMs === null ||
      !traceEchoTextMatches(sample, visibleOutputTail) ||
      sample.stages.backendOutputFlushedAtMs !== null
    ) {
      continue;
    }

    if (sample.stages.ptyOutputReceivedAtMs === null) {
      sample.stages.ptyOutputReceivedAtMs = now;
    }
    sample.stages.backendOutputFlushedAtMs = now;
  }
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
      outputTransportReceivedAtMs: update.outputTransportReceivedAtMs ?? null,
    },
  }));
}

export function recordGitSubprocessStarted(): void {
  backendRuntimeDiagnostics.gitSubprocessCount += 1;
}

export function getGitSubprocessCount(): number {
  return backendRuntimeDiagnostics.gitSubprocessCount;
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

export function recordBrowserChannelRecoveryRequired(kind: 'client' | 'pending'): void {
  if (kind === 'client') {
    backendRuntimeDiagnostics.browserChannels.recoveryRequiredClientChannels += 1;
    return;
  }

  backendRuntimeDiagnostics.browserChannels.recoveryRequiredPendingChannels += 1;
}

export function recordBrowserChannelResetBinding(): void {
  backendRuntimeDiagnostics.browserChannels.resetBindings += 1;
}

export function recordBrowserChannelTransportBusyDeferral(): void {
  backendRuntimeDiagnostics.browserChannels.transportBusyDeferrals += 1;
}

export function recordAgentSessionEnsureBatch(requestedSessions: number): void {
  backendRuntimeDiagnostics.agentSessionStartup.batchRequests += 1;
  backendRuntimeDiagnostics.agentSessionStartup.requestedSessions += requestedSessions;
}

export function recordAgentSessionEnsureResult(kind: 'created' | 'existing'): void {
  if (kind === 'created') {
    backendRuntimeDiagnostics.agentSessionStartup.createdSessions += 1;
    return;
  }

  backendRuntimeDiagnostics.agentSessionStartup.existingSessions += 1;
}

export function recordAgentSessionSpawnAdmissionState(details: {
  activeSpawns: number;
  pendingSpawns: number;
}): void {
  if (details.activeSpawns > backendRuntimeDiagnostics.agentSessionStartup.maxActiveSpawns) {
    backendRuntimeDiagnostics.agentSessionStartup.maxActiveSpawns = details.activeSpawns;
  }
  if (details.pendingSpawns > backendRuntimeDiagnostics.agentSessionStartup.maxPendingSpawns) {
    backendRuntimeDiagnostics.agentSessionStartup.maxPendingSpawns = details.pendingSpawns;
  }
}

export function recordAgentSessionSpawnAdmissionWait(durationMs: number): void {
  backendRuntimeDiagnostics.agentSessionStartup.admissionWaits += 1;
  backendRuntimeDiagnostics.agentSessionStartup.totalAdmissionWaitMs += durationMs;
  if (durationMs > backendRuntimeDiagnostics.agentSessionStartup.maxAdmissionWaitMs) {
    backendRuntimeDiagnostics.agentSessionStartup.maxAdmissionWaitMs = durationMs;
  }
}

export function recordAgentSessionSpawnDuration(durationMs: number): void {
  backendRuntimeDiagnostics.agentSessionStartup.spawnDurationCount += 1;
  backendRuntimeDiagnostics.agentSessionStartup.totalSpawnDurationMs += durationMs;
  if (durationMs > backendRuntimeDiagnostics.agentSessionStartup.maxSpawnDurationMs) {
    backendRuntimeDiagnostics.agentSessionStartup.maxSpawnDurationMs = durationMs;
  }
}

export function recordReconnectSnapshotCacheHit(): void {
  backendRuntimeDiagnostics.reconnectSnapshots.cacheHits += 1;
}

export function recordReconnectSnapshotCacheMiss(): void {
  backendRuntimeDiagnostics.reconnectSnapshots.cacheMisses += 1;
}

export function recordReconnectSnapshotRevisionSkip(): void {
  backendRuntimeDiagnostics.reconnectSnapshots.revisionSkips += 1;
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

export function recordTerminalRecoveryBatch(
  entries: Array<{
    recovery:
      | { kind: 'delta'; data: string; source: 'cursor' | 'tail' }
      | { kind: 'noop' }
      | { kind: 'snapshot'; data: string | null }
      | { kind: 'tail-needed' }
      | { kind: 'terminal-state'; data: string };
  }>,
  durationMs: number,
): void {
  let returnedBytes = 0;

  backendRuntimeDiagnostics.terminalRecovery.requests += entries.length;
  backendRuntimeDiagnostics.terminalRecovery.lastDurationMs = durationMs;
  if (durationMs > backendRuntimeDiagnostics.terminalRecovery.maxDurationMs) {
    backendRuntimeDiagnostics.terminalRecovery.maxDurationMs = durationMs;
  }

  for (const entry of entries) {
    switch (entry.recovery.kind) {
      case 'delta':
        backendRuntimeDiagnostics.terminalRecovery.deltaResponses += 1;
        if (entry.recovery.source === 'cursor') {
          backendRuntimeDiagnostics.terminalRecovery.cursorDeltaResponses += 1;
        } else {
          backendRuntimeDiagnostics.terminalRecovery.tailDeltaResponses += 1;
        }
        returnedBytes += Buffer.byteLength(entry.recovery.data, 'base64');
        break;
      case 'noop':
        backendRuntimeDiagnostics.terminalRecovery.noopResponses += 1;
        break;
      case 'snapshot':
        backendRuntimeDiagnostics.terminalRecovery.snapshotResponses += 1;
        returnedBytes += Buffer.byteLength(entry.recovery.data ?? '', 'base64');
        break;
      case 'tail-needed':
        backendRuntimeDiagnostics.terminalRecovery.tailNeededResponses += 1;
        break;
      case 'terminal-state':
        backendRuntimeDiagnostics.terminalRecovery.terminalStateResponses += 1;
        returnedBytes += Buffer.byteLength(entry.recovery.data, 'base64');
        break;
    }
  }

  backendRuntimeDiagnostics.terminalRecovery.returnedBytes += returnedBytes;
}

export function recordTerminalStateRecoveryFallback(): void {
  backendRuntimeDiagnostics.terminalRecovery.terminalStateFallbacks += 1;
}

export function recordTerminalScrollbackCapacityChange(details: {
  capacity: number;
  previousCapacity: number;
  reason: 'grow' | 'initial';
}): void {
  if (details.reason === 'initial') {
    backendRuntimeDiagnostics.terminalScrollback.initialAllocations += 1;
    backendRuntimeDiagnostics.terminalScrollback.initialAllocatedBytes += details.capacity;
  } else {
    backendRuntimeDiagnostics.terminalScrollback.growAllocations += 1;
    backendRuntimeDiagnostics.terminalScrollback.growAllocatedBytes += Math.max(
      0,
      details.capacity - details.previousCapacity,
    );
  }

  if (details.capacity > backendRuntimeDiagnostics.terminalScrollback.maxAllocatedCapacityBytes) {
    backendRuntimeDiagnostics.terminalScrollback.maxAllocatedCapacityBytes = details.capacity;
  }
}

export function recordTerminalStateMirrorInstance(): void {
  backendRuntimeDiagnostics.terminalStateMirror.instances += 1;
}

export function recordTerminalStateMirrorOutputEnqueue(
  bytes: number,
  pendingOperations: number,
): void {
  backendRuntimeDiagnostics.terminalStateMirror.outputEnqueues += 1;
  backendRuntimeDiagnostics.terminalStateMirror.outputBytes += bytes;
  if (pendingOperations > backendRuntimeDiagnostics.terminalStateMirror.maxPendingOperations) {
    backendRuntimeDiagnostics.terminalStateMirror.maxPendingOperations = pendingOperations;
  }
}

export function recordTerminalStateMirrorResizeEnqueue(pendingOperations: number): void {
  backendRuntimeDiagnostics.terminalStateMirror.resizeEnqueues += 1;
  if (pendingOperations > backendRuntimeDiagnostics.terminalStateMirror.maxPendingOperations) {
    backendRuntimeDiagnostics.terminalStateMirror.maxPendingOperations = pendingOperations;
  }
}

export function recordTerminalStateMirrorOperationDrain(durationMs: number): void {
  backendRuntimeDiagnostics.terminalStateMirror.operationDrainCount += 1;
  backendRuntimeDiagnostics.terminalStateMirror.operationDrainTotalDurationMs += durationMs;
  if (durationMs > backendRuntimeDiagnostics.terminalStateMirror.operationDrainMaxDurationMs) {
    backendRuntimeDiagnostics.terminalStateMirror.operationDrainMaxDurationMs = durationMs;
  }
}

export function recordTerminalStateMirrorSerialize(details: {
  bytes: number;
  cacheHit: boolean;
  durationMs: number;
}): void {
  backendRuntimeDiagnostics.terminalStateMirror.serializeRequests += 1;
  if (details.cacheHit) {
    backendRuntimeDiagnostics.terminalStateMirror.serializeCacheHits += 1;
  }
  backendRuntimeDiagnostics.terminalStateMirror.serializeTotalBytes += details.bytes;
  backendRuntimeDiagnostics.terminalStateMirror.serializeTotalDurationMs += details.durationMs;
  backendRuntimeDiagnostics.terminalStateMirror.serializeLastDurationMs = details.durationMs;
  if (details.durationMs > backendRuntimeDiagnostics.terminalStateMirror.serializeMaxDurationMs) {
    backendRuntimeDiagnostics.terminalStateMirror.serializeMaxDurationMs = details.durationMs;
  }
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

export function recordPreviewCacheHit(details?: { generation?: number }): void {
  if (
    details?.generation !== undefined &&
    details.generation !== backendRuntimeDiagnosticsGeneration
  ) {
    return;
  }

  backendRuntimeDiagnostics.previewValidation.cacheHits += 1;
}

export function recordPreviewProbeResult(
  success: boolean,
  durationMs: number,
  details?: {
    failureReason?: PreviewProbeFailureReason;
    generation?: number;
    target?: string;
  },
): void {
  if (
    details?.generation !== undefined &&
    details.generation !== backendRuntimeDiagnosticsGeneration
  ) {
    return;
  }

  backendRuntimeDiagnostics.previewValidation.lastProbeDurationMs = durationMs;
  backendRuntimeDiagnostics.previewValidation.lastProbeTarget = details?.target ?? null;
  if (durationMs > backendRuntimeDiagnostics.previewValidation.maxProbeDurationMs) {
    backendRuntimeDiagnostics.previewValidation.maxProbeDurationMs = durationMs;
  }

  if (success) {
    backendRuntimeDiagnostics.previewValidation.lastProbeFailureReason = null;
    backendRuntimeDiagnostics.previewValidation.probeSuccesses += 1;
    return;
  }

  const failureReason = details?.failureReason ?? 'connection-error';
  backendRuntimeDiagnostics.previewValidation.lastProbeFailureReason = failureReason;
  backendRuntimeDiagnostics.previewValidation.probeFailures += 1;
  if (failureReason === 'timeout') {
    backendRuntimeDiagnostics.previewValidation.timeoutFailures += 1;
  } else {
    backendRuntimeDiagnostics.previewValidation.connectionFailures += 1;
  }
}

export function recordPreviewRevalidation(): void {
  backendRuntimeDiagnostics.previewValidation.revalidations += 1;
}

export function recordBrowserControlSendResult(
  reason: 'backpressure' | 'not-open' | 'send-error',
  details?: { generation?: number },
): void {
  if (
    details?.generation !== undefined &&
    details.generation !== backendRuntimeDiagnosticsGeneration
  ) {
    return;
  }

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

export function recordBrowserControlSimulatedDrop(details?: { generation?: number }): void {
  if (
    details?.generation !== undefined &&
    details.generation !== backendRuntimeDiagnosticsGeneration
  ) {
    return;
  }

  backendRuntimeDiagnostics.browserControl.simulatedDroppedSends += 1;
}

export function recordBrowserControlDelayedQueue(
  queueDepth: number,
  queuedBytes: number,
  queueAgeMs: number,
  details?: { generation?: number },
): void {
  if (
    details?.generation !== undefined &&
    details.generation !== backendRuntimeDiagnosticsGeneration
  ) {
    return;
  }

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

export function recordBrowserControlBufferedAmount(
  bufferedAmountBytes: number,
  details?: { generation?: number },
): void {
  if (
    details?.generation !== undefined &&
    details.generation !== backendRuntimeDiagnosticsGeneration
  ) {
    return;
  }

  if (
    Number.isFinite(bufferedAmountBytes) &&
    bufferedAmountBytes > backendRuntimeDiagnostics.browserControl.maxBufferedAmountBytes
  ) {
    backendRuntimeDiagnostics.browserControl.maxBufferedAmountBytes = bufferedAmountBytes;
  }
}
