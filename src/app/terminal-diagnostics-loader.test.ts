import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const diagnosticsMocks = vi.hoisted(() => ({
  enableCapture: vi.fn(),
  getCapture: vi.fn(() => ({ enabled: true })),
  installFluidity: vi.fn(),
  resetCapture: vi.fn(),
}));

vi.mock('./terminal-diagnostics-capture', () => ({
  enableTerminalDiagnosticsCapture: diagnosticsMocks.enableCapture,
  getTerminalDiagnosticsCaptureSnapshot: diagnosticsMocks.getCapture,
  resetTerminalDiagnosticsCaptureForTests: diagnosticsMocks.resetCapture,
}));

vi.mock('./ui-fluidity-diagnostics', () => ({
  installUiFluidityDiagnostics: diagnosticsMocks.installFluidity,
}));

import {
  installTerminalDiagnosticsLoader,
  resetTerminalDiagnosticsLoaderForTests,
} from './terminal-diagnostics-loader';

describe('terminal diagnostics loader', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    diagnosticsMocks.enableCapture.mockClear();
    diagnosticsMocks.getCapture.mockClear();
    diagnosticsMocks.installFluidity.mockClear();
    diagnosticsMocks.resetCapture.mockClear();
    resetTerminalDiagnosticsLoaderForTests();
  });

  afterEach(() => {
    resetTerminalDiagnosticsLoaderForTests();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('leaves the diagnostics runtime unloaded during normal startup', () => {
    expect(installTerminalDiagnosticsLoader()).toBeNull();
    expect(window.__parallelCodeTerminalDiagnosticsCapture).toBeDefined();
    expect(diagnosticsMocks.installFluidity).not.toHaveBeenCalled();
    expect(diagnosticsMocks.enableCapture).not.toHaveBeenCalled();
  });

  it('loads and installs fluidity diagnostics when a pre-launch flag requests them', async () => {
    window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ = true;

    await installTerminalDiagnosticsLoader();

    expect(diagnosticsMocks.installFluidity).toHaveBeenCalledOnce();
  });

  it('enables flags synchronously and loads the full capture runtime on demand', async () => {
    installTerminalDiagnosticsLoader();

    await window.__parallelCodeTerminalDiagnosticsCapture?.enable();

    expect(window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__).toBe(true);
    expect(window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__).toBe(true);
    expect(window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__).toBe(true);
    expect(window.__TERMINAL_OUTPUT_DIAGNOSTICS__).toBe(true);
    expect(diagnosticsMocks.enableCapture).toHaveBeenCalledOnce();
    expect(diagnosticsMocks.installFluidity).toHaveBeenCalledOnce();
  });

  it('delegates on-demand captures through the loaded runtime', async () => {
    installTerminalDiagnosticsLoader();

    const snapshot = await window.__parallelCodeTerminalDiagnosticsCapture?.capture('terminal-1');

    expect(diagnosticsMocks.getCapture).toHaveBeenCalledWith('terminal-1');
    expect(snapshot).toEqual({ enabled: true });
  });
});
