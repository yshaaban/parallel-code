export interface BackendRuntimeDiagnosticsSnapshot {
  browserControl: {
    backpressureRejects: number;
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
}

let backendRuntimeDiagnostics: BackendRuntimeDiagnosticsSnapshot = createInitialSnapshot();

function createInitialSnapshot(): BackendRuntimeDiagnosticsSnapshot {
  return {
    browserControl: {
      backpressureRejects: 0,
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
  };
}

export function resetBackendRuntimeDiagnostics(): void {
  backendRuntimeDiagnostics = createInitialSnapshot();
}

export function getBackendRuntimeDiagnosticsSnapshot(): BackendRuntimeDiagnosticsSnapshot {
  return {
    browserControl: { ...backendRuntimeDiagnostics.browserControl },
    ptyInput: { ...backendRuntimeDiagnostics.ptyInput },
    previewValidation: { ...backendRuntimeDiagnostics.previewValidation },
  };
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
