import type { TerminalDiagnosticsCaptureSnapshot } from './terminal-diagnostics-capture';

interface TerminalDiagnosticsRuntime {
  capture: typeof import('./terminal-diagnostics-capture');
  fluidity: typeof import('./ui-fluidity-diagnostics');
}

let runtimePromise: Promise<TerminalDiagnosticsRuntime> | null = null;

function isTerminalDiagnosticsRequested(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ === true ||
      window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__ === true ||
      window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ === true ||
      window.__TERMINAL_OUTPUT_DIAGNOSTICS__ === true)
  );
}

function enableTerminalDiagnosticsFlags(): void {
  window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
  window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__ = true;
  window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ = true;
  window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;
}

function loadTerminalDiagnosticsRuntime(): Promise<TerminalDiagnosticsRuntime> {
  runtimePromise ??= Promise.all([
    import('./terminal-diagnostics-capture'),
    import('./ui-fluidity-diagnostics'),
  ])
    .then(([capture, fluidity]) => ({ capture, fluidity }))
    .catch((error: unknown) => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
}

function installTerminalDiagnosticsFacade(): void {
  if (typeof window === 'undefined' || window.__parallelCodeTerminalDiagnosticsCapture) {
    return;
  }

  window.__parallelCodeTerminalDiagnosticsCapture = {
    capture(terminalKey?: string | null): Promise<TerminalDiagnosticsCaptureSnapshot> {
      return loadTerminalDiagnosticsRuntime().then(({ capture }) =>
        capture.getTerminalDiagnosticsCaptureSnapshot(terminalKey),
      );
    },
    captureFocused(): Promise<TerminalDiagnosticsCaptureSnapshot> {
      return loadTerminalDiagnosticsRuntime().then(({ capture }) =>
        capture.getTerminalDiagnosticsCaptureSnapshot(),
      );
    },
    enable(): Promise<void> {
      enableTerminalDiagnosticsFlags();
      return loadTerminalDiagnosticsRuntime().then(({ capture, fluidity }) => {
        capture.enableTerminalDiagnosticsCapture();
        fluidity.installUiFluidityDiagnostics();
      });
    },
    reset(): Promise<void> {
      return loadTerminalDiagnosticsRuntime().then(({ capture }) => {
        capture.resetTerminalDiagnosticsCaptureForTests();
        installTerminalDiagnosticsFacade();
      });
    },
  };
}

/**
 * Installs the tiny on-demand facade. When diagnostics were enabled before the
 * application script ran, the full runtime is awaited so startup samples are
 * not lost; normal product startup never downloads or evaluates that runtime.
 */
export function installTerminalDiagnosticsLoader(): Promise<void> | null {
  if (typeof window === 'undefined') {
    return null;
  }

  installTerminalDiagnosticsFacade();
  if (!isTerminalDiagnosticsRequested()) {
    return null;
  }

  return loadTerminalDiagnosticsRuntime().then(({ fluidity }) => {
    fluidity.installUiFluidityDiagnostics();
  });
}

export function resetTerminalDiagnosticsLoaderForTests(): void {
  runtimePromise = null;
  if (typeof window !== 'undefined') {
    Reflect.deleteProperty(window, '__parallelCodeTerminalDiagnosticsCapture');
  }
}
