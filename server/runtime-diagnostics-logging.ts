import type { BackendRuntimeDiagnosticsSnapshot } from '../electron/ipc/runtime-diagnostics.js';

export interface RuntimeDiagnosticsLoggingConfig {
  intervalMs: number;
  resetAfterLog: boolean;
}

interface RuntimeDiagnosticsLoggingEnv {
  [key: string]: string | undefined;
  RUNTIME_DIAGNOSTICS_LOG_INTERVAL_MS?: string;
  RUNTIME_DIAGNOSTICS_LOG_RESET?: string;
}

export interface StartRuntimeDiagnosticsLoggingOptions extends RuntimeDiagnosticsLoggingConfig {
  getSnapshot: () => BackendRuntimeDiagnosticsSnapshot;
  log: (message: string) => void;
  now?: () => Date;
  resetSnapshot: () => void;
}

function createRuntimeDiagnosticsLogMessage(
  diagnostics: BackendRuntimeDiagnosticsSnapshot,
  recordedAt: string,
): string {
  return `[runtime-diagnostics] ${JSON.stringify({
    diagnostics,
    recordedAt,
    type: 'runtime-diagnostics',
  })}`;
}

export function getRuntimeDiagnosticsLoggingConfigFromEnv(
  env: RuntimeDiagnosticsLoggingEnv,
): RuntimeDiagnosticsLoggingConfig | null {
  const rawIntervalMs = env.RUNTIME_DIAGNOSTICS_LOG_INTERVAL_MS;
  if (rawIntervalMs === undefined) {
    return null;
  }

  const intervalMs = Number(rawIntervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      'RUNTIME_DIAGNOSTICS_LOG_INTERVAL_MS must be a positive number of milliseconds',
    );
  }

  return {
    intervalMs,
    resetAfterLog: env.RUNTIME_DIAGNOSTICS_LOG_RESET === 'true',
  };
}

export function startRuntimeDiagnosticsLogging(
  options: StartRuntimeDiagnosticsLoggingOptions,
): () => void {
  const now = options.now ?? (() => new Date());
  const timer = setInterval(() => {
    options.log(createRuntimeDiagnosticsLogMessage(options.getSnapshot(), now().toISOString()));
    if (options.resetAfterLog) {
      options.resetSnapshot();
    }
  }, options.intervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
