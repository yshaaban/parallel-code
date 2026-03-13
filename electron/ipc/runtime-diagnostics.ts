export interface BackendRuntimeDiagnosticsSnapshot {
  browserControl: {
    backpressureRejects: number;
    notOpenRejects: number;
    sendErrors: number;
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
    previewValidation: { ...backendRuntimeDiagnostics.previewValidation },
  };
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
