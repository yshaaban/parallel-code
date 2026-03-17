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
}

let backendRuntimeDiagnostics: BackendRuntimeDiagnosticsSnapshot = createInitialSnapshot();

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
  };
}

export function resetBackendRuntimeDiagnostics(): void {
  backendRuntimeDiagnostics = createInitialSnapshot();
}

export function getBackendRuntimeDiagnosticsSnapshot(): BackendRuntimeDiagnosticsSnapshot {
  return {
    browserChannels: { ...backendRuntimeDiagnostics.browserChannels },
    browserControl: { ...backendRuntimeDiagnostics.browserControl },
    ptyInput: { ...backendRuntimeDiagnostics.ptyInput },
    previewValidation: { ...backendRuntimeDiagnostics.previewValidation },
    reconnectSnapshots: { ...backendRuntimeDiagnostics.reconnectSnapshots },
    scrollbackReplay: { ...backendRuntimeDiagnostics.scrollbackReplay },
  };
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
