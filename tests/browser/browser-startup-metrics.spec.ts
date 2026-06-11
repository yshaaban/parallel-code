import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from './harness/fixtures.js';
import {
  createInteractiveNodeScenario,
  createPromptReadyScenario,
  createRenderStressScenario,
} from './harness/scenarios.js';
import { getRendererDiagnostics, openDiagnosticSession } from './harness/terminal-render.js';
import type { RendererRuntimeDiagnosticsSnapshot } from '../../src/app/runtime-diagnostics.js';

const RUN_BROWSER_STARTUP_METRICS = process.env.RUN_BROWSER_STARTUP_METRICS === '1';
const startupMetricsDescribe = RUN_BROWSER_STARTUP_METRICS ? test.describe : test.describe.skip;

// Asserted CI budgets for the gated startup-metrics lane (benchmark runner).
// Re-baselining any number requires an explicit note in docs/TESTING.md.
const SELECTED_QUEUED_TO_INTERACTIVE_BUDGET_MS = {
  1: 250,
  8: 350,
  24: 800,
} as const;
const RECONNECT_RESTORE_TOTAL_BUDGET_MS = 500;

function expectSelectedQueuedToInteractiveWithinBudget(
  selectedAttachTrace: TerminalAttachTraceEntrySnapshot | null,
  terminalCount: keyof typeof SELECTED_QUEUED_TO_INTERACTIVE_BUDGET_MS,
): void {
  expect(selectedAttachTrace).toBeTruthy();
  expect(selectedAttachTrace?.readyAtMs).not.toBeNull();
  const queuedToInteractiveMs =
    (selectedAttachTrace?.readyAtMs ?? Number.POSITIVE_INFINITY) -
    (selectedAttachTrace?.attachQueuedAtMs ?? 0);
  expect(queuedToInteractiveMs).toBeLessThanOrEqual(
    SELECTED_QUEUED_TO_INTERACTIVE_BUDGET_MS[terminalCount],
  );
}

interface StartupMetricsPayload {
  attachTrace: {
    attachBoundAtMs: number | null;
    attachQueuedAtMs: number | null;
    attachStartedAtMs: number | null;
    bindToReadyMs: number | null;
    queuedToStartMs: number | null;
    readyAtMs: number | null;
    startToBindMs: number | null;
    status: string | null;
  } | null;
  replayTrace: {
    applyMs: number;
    chunkCount: number;
    postApplyFitMs: number;
    preRecoveryFitMs: number;
    primaryReadinessWaitMs: number;
    reason: string;
    recoveryFetchMs: number;
    recoveryKind: string;
    revealSettleMs: number;
    requestStateBytes: number;
    restoreTotalMs: number;
    resumeMs: number;
    selectedVisibleFastPath: boolean;
    visiblePaintWaitMs: number;
    waitForOutputIdleMs: number;
    writtenBytes: number;
  } | null;
  bootstrap: RendererRuntimeDiagnosticsSnapshot['bootstrap'] | null;
  browserStartup: RendererRuntimeDiagnosticsSnapshot['browserStartup'] | null;
  browserSync: RendererRuntimeDiagnosticsSnapshot['browserSync'] | null;
  terminalRecovery: {
    kindCounts: RendererRuntimeDiagnosticsSnapshot['terminalRecovery']['kindCounts'];
    requestCounts: RendererRuntimeDiagnosticsSnapshot['terminalRecovery']['requestCounts'];
    stableRevealWaits: number;
    visibleSteadyStateSnapshotCounts: RendererRuntimeDiagnosticsSnapshot['terminalRecovery']['visibleSteadyStateSnapshotCounts'];
  } | null;
  terminalStartupPaint: {
    logicalReadyLastMs: {
      selected: number | null;
    };
    paintReadyLastMs: {
      selected: number | null;
    };
  };
}

interface TerminalAttachTraceEntrySnapshot {
  agentId: string;
  attachBoundAtMs: number | null;
  attachQueuedAtMs: number;
  attachStartedAtMs: number | null;
  readyAtMs: number | null;
  status: 'attaching' | 'binding' | 'error' | 'queued' | 'ready' | 'restoring';
}

interface TerminalReplayTraceEntrySnapshot {
  agentId: string;
  applyMs: number;
  chunkCount: number;
  postApplyFitMs: number;
  preRecoveryFitMs: number;
  primaryReadinessWaitMs: number;
  reason: 'attach' | 'backpressure' | 'hibernate' | 'reconnect' | 'renderer-loss';
  recoveryFetchMs: number;
  recoveryKind: 'delta' | 'noop' | 'snapshot' | 'terminal-state';
  revealSettleMs: number;
  requestStateBytes: number;
  restoreTotalMs: number;
  resumeMs: number;
  selectedVisibleFastPath: boolean;
  visiblePaintWaitMs: number;
  waitForOutputIdleMs: number;
  writtenBytes: number;
}

function buildSelectedAttachTracePayload(
  entry: TerminalAttachTraceEntrySnapshot | null,
): StartupMetricsPayload['attachTrace'] {
  if (!entry) {
    return null;
  }

  return {
    attachBoundAtMs: entry.attachBoundAtMs,
    attachQueuedAtMs: entry.attachQueuedAtMs,
    attachStartedAtMs: entry.attachStartedAtMs,
    bindToReadyMs:
      entry.attachBoundAtMs === null || entry.readyAtMs === null
        ? null
        : Math.max(0, entry.readyAtMs - entry.attachBoundAtMs),
    queuedToStartMs:
      entry.attachStartedAtMs === null
        ? null
        : Math.max(0, entry.attachStartedAtMs - entry.attachQueuedAtMs),
    readyAtMs: entry.readyAtMs,
    startToBindMs:
      entry.attachStartedAtMs === null || entry.attachBoundAtMs === null
        ? null
        : Math.max(0, entry.attachBoundAtMs - entry.attachStartedAtMs),
    status: entry.status,
  };
}

async function getSelectedTerminalAgentId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const terminal = document.querySelector('[data-terminal-agent-id]');
    return terminal?.getAttribute('data-terminal-agent-id') ?? null;
  });
}

async function getSelectedAttachTrace(
  page: Page,
  selectedAgentId: string | null,
): Promise<TerminalAttachTraceEntrySnapshot | null> {
  return page.evaluate((agentId) => {
    const traceStore = (
      window as typeof window & {
        __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, TerminalAttachTraceEntrySnapshot>;
      }
    ).__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__;
    if (!traceStore || !agentId) {
      return null;
    }

    return Object.values(traceStore).find((entry) => entry.agentId === agentId) ?? null;
  }, selectedAgentId);
}

async function getSelectedReplayTrace(
  page: Page,
  selectedAgentId: string | null,
  reason: TerminalReplayTraceEntrySnapshot['reason'],
): Promise<TerminalReplayTraceEntrySnapshot | null> {
  return page.evaluate(
    ({ agentId, recoveryReason }) => {
      const traceStore = (
        window as typeof window & {
          __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: TerminalReplayTraceEntrySnapshot[];
        }
      ).__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__;
      if (!traceStore || !agentId) {
        return null;
      }

      const matchingEntries = traceStore.filter(
        (entry) => entry.agentId === agentId && entry.reason === recoveryReason,
      );
      return matchingEntries.at(-1) ?? null;
    },
    { agentId: selectedAgentId, recoveryReason: reason },
  );
}

async function getSelectedVisibleRecoveryTrace(
  page: Page,
  selectedAgentId: string | null,
): Promise<TerminalReplayTraceEntrySnapshot | null> {
  return page.evaluate((agentId) => {
    const traceStore = (
      window as typeof window & {
        __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: TerminalReplayTraceEntrySnapshot[];
      }
    ).__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__;
    if (!traceStore || !agentId) {
      return null;
    }

    const matchingEntries = traceStore.filter(
      (entry) =>
        entry.agentId === agentId && (entry.reason === 'attach' || entry.reason === 'reconnect'),
    );
    if (matchingEntries.length === 0) {
      return null;
    }

    const reconnectEntry = [...matchingEntries]
      .reverse()
      .find((entry) => entry.reason === 'reconnect');
    return reconnectEntry ?? matchingEntries.at(-1) ?? null;
  }, selectedAgentId);
}

function buildStartupMetricsPayload(
  diagnostics: RendererRuntimeDiagnosticsSnapshot | null,
  selectedAttachTrace: TerminalAttachTraceEntrySnapshot | null,
  selectedReplayTrace: TerminalReplayTraceEntrySnapshot | null,
): StartupMetricsPayload {
  return {
    attachTrace: buildSelectedAttachTracePayload(selectedAttachTrace),
    replayTrace: selectedReplayTrace,
    bootstrap: diagnostics?.bootstrap ?? null,
    browserStartup: diagnostics?.browserStartup ?? null,
    browserSync: diagnostics?.browserSync ?? null,
    terminalRecovery: diagnostics
      ? {
          kindCounts: diagnostics.terminalRecovery.kindCounts,
          requestCounts: diagnostics.terminalRecovery.requestCounts,
          stableRevealWaits: diagnostics.terminalRecovery.stableRevealWaits,
          visibleSteadyStateSnapshotCounts:
            diagnostics.terminalRecovery.visibleSteadyStateSnapshotCounts,
        }
      : null,
    terminalStartupPaint: {
      logicalReadyLastMs: {
        selected: diagnostics?.terminalStartupPaint.logicalReadyLastMs.selected ?? null,
      },
      paintReadyLastMs: {
        selected: diagnostics?.terminalStartupPaint.paintReadyLastMs.selected ?? null,
      },
    },
  };
}

function logStartupMetrics(
  label: string,
  diagnostics: RendererRuntimeDiagnosticsSnapshot | null,
  selectedAttachTrace: TerminalAttachTraceEntrySnapshot | null,
  selectedReplayTrace: TerminalReplayTraceEntrySnapshot | null,
): void {
  console.warn(
    JSON.stringify(
      {
        label,
        ...buildStartupMetricsPayload(diagnostics, selectedAttachTrace, selectedReplayTrace),
      },
      null,
      2,
    ),
  );
}

function expectColdBootstrapDiagnostics(
  diagnostics: RendererRuntimeDiagnosticsSnapshot | null,
): void {
  expect(diagnostics).toBeTruthy();
  expect(diagnostics?.browserStartup.modeCompleteCounts['cold-bootstrap']).toBe(1);
  expect(diagnostics?.browserStartup.modeCompleteCounts['reconnect-restore']).toBe(0);
  expect(diagnostics?.browserStartup.tierCounts.shell).toBeGreaterThan(0);
  expect(diagnostics?.browserStartup.tierCounts.summary).toBeGreaterThan(0);
  expect(diagnostics?.browserStartup.tierCounts['selected-task']).toBeGreaterThan(0);
  expect(diagnostics?.browserStartup.tierCounts['selected-terminal']).toBeGreaterThan(0);
  expect(diagnostics?.browserStartup.tierCounts.background).toBeGreaterThan(0);
  expect(diagnostics?.browserStartup.tierLastReachedMs.summary).not.toBeNull();
  expect(diagnostics?.browserStartup.tierLastReachedMs['selected-task']).not.toBeNull();
  expect(diagnostics?.browserStartup.tierLastReachedMs['selected-terminal']).not.toBeNull();
  expect(diagnostics?.browserStartup.tierLastReachedMs.background).not.toBeNull();
  expect(diagnostics?.terminalStartupPaint.logicalReadyLastMs.selected).not.toBeNull();
  expect(diagnostics?.terminalStartupPaint.paintReadyLastMs.selected).not.toBeNull();
}

function expectReconnectRestoreDiagnostics(
  diagnostics: RendererRuntimeDiagnosticsSnapshot | null,
  selectedAttachTrace: TerminalAttachTraceEntrySnapshot | null,
  selectedReplayTrace: TerminalReplayTraceEntrySnapshot | null,
): void {
  expect(diagnostics).toBeTruthy();
  expect(diagnostics?.browserStartup.modeCompleteCounts['cold-bootstrap']).toBe(0);
  // Reconnects within continuity may take the short-disconnect skip or the
  // revision-keyed full restore; both are valid reconnect outcomes, and
  // terminal recovery is channel-level so the replay trace exists either way.
  const fullRestores = diagnostics?.browserStartup.modeCompleteCounts['reconnect-restore'] ?? 0;
  const skipRestores =
    diagnostics?.browserReconnect.restoreOutcomeCounts['short-disconnect-skip'] ?? 0;
  expect(fullRestores + skipRestores).toBeGreaterThan(0);
  if (fullRestores > 0) {
    expect(diagnostics?.browserStartup.modeLastDurationMs['reconnect-restore']).not.toBeNull();
    expect(diagnostics?.browserSync.started).toBeGreaterThan(0);
    expect(diagnostics?.browserSync.completed).toBeGreaterThan(0);
    expect(diagnostics?.browserSync.failed).toBe(0);
    expect(diagnostics?.browserSync.lastDurationMs).not.toBeNull();
  }
  expect(diagnostics?.browserStartup.tierCounts.shell).toBe(0);
  expect(diagnostics?.browserStartup.tierCounts.summary).toBe(0);
  expect(diagnostics?.browserStartup.tierCounts['selected-task']).toBe(0);
  expect(diagnostics?.browserStartup.tierLastReachedMs.shell).toBeNull();
  expect(diagnostics?.browserStartup.tierLastReachedMs.summary).toBeNull();
  expect(diagnostics?.browserStartup.tierLastReachedMs['selected-task']).toBeNull();
  expect(selectedReplayTrace).toBeTruthy();
  const visibleRecoveryReason = selectedReplayTrace?.reason;
  if (visibleRecoveryReason === 'reconnect') {
    expect(diagnostics?.terminalRecovery.requestCounts.reconnect).toBeGreaterThan(0);
  } else {
    expect(visibleRecoveryReason).toBe('attach');
    expect(diagnostics?.terminalRecovery.requestCounts.attach).toBeGreaterThan(0);
    expect(selectedAttachTrace).toBeTruthy();
  }
  expect(selectedReplayTrace?.restoreTotalMs).toBeGreaterThanOrEqual(
    selectedReplayTrace?.recoveryFetchMs ?? 0,
  );
  expect(selectedReplayTrace?.restoreTotalMs).toBeGreaterThanOrEqual(
    selectedReplayTrace?.applyMs ?? 0,
  );
  expect(selectedReplayTrace?.restoreTotalMs).toBeGreaterThanOrEqual(
    selectedReplayTrace?.resumeMs ?? 0,
  );
  // A reconnect that resolves to cursor-continuity (noop/delta) does not
  // repaint the already-ready terminal, so a fresh paint-ready sample only
  // exists when the restore actually re-ran the startup paint flow.
  const paintReadyLastMs = diagnostics?.terminalStartupPaint.paintReadyLastMs.selected ?? null;
  if (paintReadyLastMs !== null) {
    expect(paintReadyLastMs).toBeGreaterThanOrEqual(
      diagnostics?.terminalStartupPaint.logicalReadyLastMs.selected ?? 0,
    );
  }
}

async function waitForShellAndSelectedTerminalReady(
  browserLab: {
    waitForTerminalInteractiveReady: (
      page: Page,
      terminalIndex?: number,
      options?: {
        requireLiveRenderReady?: boolean;
        timeoutMs?: number;
      },
    ) => Promise<void>;
  },
  page: Page,
): Promise<void> {
  await page.locator('.app-shell').waitFor({ state: 'visible' });
  await browserLab.waitForTerminalInteractiveReady(page, 0, {
    requireLiveRenderReady: true,
  });
}

async function initializeTerminalTraceStores(
  context: BrowserContext,
  options: {
    includeAttachTrace: boolean;
  },
): Promise<void> {
  await context.addInitScript(({ includeAttachTrace }) => {
    if (includeAttachTrace) {
      (
        window as typeof window & {
          __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, unknown>;
        }
      ).__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ = {};
    }

    (
      window as typeof window & {
        __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: unknown[];
      }
    ).__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ = [];
  }, options);
}

async function readSelectedColdBootstrapMetrics(page: Page): Promise<{
  diagnostics: RendererRuntimeDiagnosticsSnapshot | null;
  selectedAttachTrace: TerminalAttachTraceEntrySnapshot | null;
  selectedReplayTrace: TerminalReplayTraceEntrySnapshot | null;
}> {
  const selectedAgentId = await getSelectedTerminalAgentId(page);
  const [diagnostics, selectedAttachTrace, selectedReplayTrace] = await Promise.all([
    getRendererDiagnostics(page),
    getSelectedAttachTrace(page, selectedAgentId),
    getSelectedReplayTrace(page, selectedAgentId, 'attach'),
  ]);

  return {
    diagnostics,
    selectedAttachTrace,
    selectedReplayTrace,
  };
}

async function readSelectedReconnectMetrics(page: Page): Promise<{
  diagnostics: RendererRuntimeDiagnosticsSnapshot | null;
  selectedAttachTrace: TerminalAttachTraceEntrySnapshot | null;
  selectedReplayTrace: TerminalReplayTraceEntrySnapshot | null;
}> {
  const selectedAgentId = await getSelectedTerminalAgentId(page);
  const [diagnostics, selectedAttachTrace, selectedReplayTrace] = await Promise.all([
    getRendererDiagnostics(page),
    getSelectedAttachTrace(page, selectedAgentId),
    getSelectedVisibleRecoveryTrace(page, selectedAgentId),
  ]);

  return {
    diagnostics,
    selectedAttachTrace,
    selectedReplayTrace,
  };
}

async function resetPageDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__parallelCodeRendererRuntimeDiagnostics?.reset();
    window.__parallelCodeTerminalOutputDiagnostics?.reset();
    window.__parallelCodeTerminalAnomalyMonitor?.reset();
    window.__parallelCodeUiFluidityDiagnostics?.reset();
    (
      window as typeof window & {
        __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, unknown>;
        __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: unknown[];
      }
    ).__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ = {};
    (
      window as typeof window & {
        __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: unknown[];
      }
    ).__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ = [];
  });
}

startupMetricsDescribe('browser startup metrics / cold bootstrap / prompt ready', () => {
  test.use({
    scenario: createPromptReadyScenario(320),
  });

  test('captures cold bootstrap and selected-terminal timings for a prompt-ready fixture', async ({
    browser,
    browserLab,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Startup Metrics Prompt Ready',
      prepareContext: async (context) => {
        await initializeTerminalTraceStores(context, { includeAttachTrace: true });
      },
    });

    try {
      await waitForShellAndSelectedTerminalReady(browserLab, page);

      const { diagnostics, selectedAttachTrace, selectedReplayTrace } =
        await readSelectedColdBootstrapMetrics(page);
      expectColdBootstrapDiagnostics(diagnostics);
      expectSelectedQueuedToInteractiveWithinBudget(selectedAttachTrace, 1);
      logStartupMetrics(
        'cold-bootstrap-prompt-ready',
        diagnostics,
        selectedAttachTrace,
        selectedReplayTrace,
      );
    } finally {
      await context.close();
    }
  });
});

function createTerminalFleetScenario(
  terminalCount: number,
): ReturnType<typeof createPromptReadyScenario> {
  const scenario = createPromptReadyScenario(320);
  return {
    ...scenario,
    additionalTaskNames: Array.from(
      { length: terminalCount - 1 },
      (_, index) => `Startup Fleet Task ${index + 2}`,
    ),
    name: `${scenario.name}-fleet-${terminalCount}`,
  };
}

startupMetricsDescribe('browser startup metrics / cold bootstrap / 8-terminal fleet', () => {
  test.use({
    scenario: createTerminalFleetScenario(8),
  });

  test('keeps selected-terminal queued-to-interactive within the 8-terminal budget', async ({
    browser,
    browserLab,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Startup Metrics 8 Terminals',
      prepareContext: async (context) => {
        await initializeTerminalTraceStores(context, { includeAttachTrace: true });
      },
    });

    try {
      await waitForShellAndSelectedTerminalReady(browserLab, page);

      const { diagnostics, selectedAttachTrace, selectedReplayTrace } =
        await readSelectedColdBootstrapMetrics(page);
      logStartupMetrics(
        'cold-bootstrap-8-terminals',
        diagnostics,
        selectedAttachTrace,
        selectedReplayTrace,
      );
      expectColdBootstrapDiagnostics(diagnostics);
      expectSelectedQueuedToInteractiveWithinBudget(selectedAttachTrace, 8);
    } finally {
      await context.close();
    }
  });
});

startupMetricsDescribe('browser startup metrics / cold bootstrap / 24-terminal fleet', () => {
  test.use({
    scenario: createTerminalFleetScenario(24),
  });

  test('keeps selected-terminal queued-to-interactive within the 24-terminal budget', async ({
    browser,
    browserLab,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Startup Metrics 24 Terminals',
      prepareContext: async (context) => {
        await initializeTerminalTraceStores(context, { includeAttachTrace: true });
      },
    });

    try {
      await waitForShellAndSelectedTerminalReady(browserLab, page);

      const { diagnostics, selectedAttachTrace, selectedReplayTrace } =
        await readSelectedColdBootstrapMetrics(page);
      logStartupMetrics(
        'cold-bootstrap-24-terminals',
        diagnostics,
        selectedAttachTrace,
        selectedReplayTrace,
      );
      expectColdBootstrapDiagnostics(diagnostics);
      expectSelectedQueuedToInteractiveWithinBudget(selectedAttachTrace, 24);
    } finally {
      await context.close();
    }
  });
});

startupMetricsDescribe('browser startup metrics / cold bootstrap / startup buffer', () => {
  test.use({
    scenario: createRenderStressScenario('startup-buffer', {
      frameCount: 96,
      frameDelayMs: 12,
      lineCount: 6_144,
      lineWidth: 140,
    }),
  });

  test('captures cold bootstrap timings for a heavier startup-buffer fixture', async ({
    browser,
    browserLab,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Startup Metrics Startup Buffer',
      prepareContext: async (context) => {
        await initializeTerminalTraceStores(context, { includeAttachTrace: true });
      },
    });

    try {
      await waitForShellAndSelectedTerminalReady(browserLab, page);

      const { diagnostics, selectedAttachTrace, selectedReplayTrace } =
        await readSelectedColdBootstrapMetrics(page);
      expectColdBootstrapDiagnostics(diagnostics);
      logStartupMetrics(
        'cold-bootstrap-startup-buffer',
        diagnostics,
        selectedAttachTrace,
        selectedReplayTrace,
      );
    } finally {
      await context.close();
    }
  });
});

startupMetricsDescribe('browser startup metrics / reconnect restore', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('captures reconnect restore timings after browser transport churn', async ({
    browser,
    browserLab,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Startup Metrics Reconnect Restore',
      prepareContext: async (context) => {
        await initializeTerminalTraceStores(context, { includeAttachTrace: true });
      },
    });

    try {
      await waitForShellAndSelectedTerminalReady(browserLab, page);
      await resetPageDiagnostics(page);

      await page.evaluate(() => {
        window.__parallelCodeBrowserTransportForTests__?.disconnect();
      });
      await expect
        .poll(() => browserLab.readConnectionBannerHistory(page), { timeout: 10_000 })
        .toContain('disconnected');
      await page.evaluate(() => {
        return window.__parallelCodeBrowserTransportForTests__?.ensureConnected();
      });
      await expect
        .poll(() => browserLab.readConnectionBannerHistory(page), { timeout: 10_000 })
        .toContain('restoring');
      await waitForShellAndSelectedTerminalReady(browserLab, page);

      const { diagnostics, selectedAttachTrace, selectedReplayTrace } =
        await readSelectedReconnectMetrics(page);
      logStartupMetrics(
        'reconnect-restore-transport-churn',
        diagnostics,
        selectedAttachTrace,
        selectedReplayTrace,
      );
      expectReconnectRestoreDiagnostics(diagnostics, selectedAttachTrace, selectedReplayTrace);
      expect(selectedReplayTrace?.restoreTotalMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
        RECONNECT_RESTORE_TOTAL_BUDGET_MS,
      );
    } finally {
      await context.close();
    }
  });
});
