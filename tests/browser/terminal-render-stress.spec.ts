import { IPC } from '../../electron/ipc/channels.js';
import type { TerminalOutputDiagnosticsSnapshot } from '../../src/lib/terminal-output-diagnostics.js';

import { expect, getTerminalLoadingOverlay, test } from './harness/fixtures.js';
import { assertInteractiveTerminalLifecycleInvariants } from './harness/lifecycle-invariants.js';
import {
  assertNoTerminalAnomalies,
  assertTerminalDiagnosticsWithinBudget,
  assertNoVisibleRecoveryChurn,
  beginTerminalAttributeHistory,
  beginTerminalPresentationModeHistory,
  captureTerminalDiagnostics,
  dragTerminalPanelResizeHandle,
  getBackendDiagnostics,
  getOutputDiagnostics,
  getRendererDiagnostics,
  getTerminalPresentationMode,
  getTerminalSurfaceTier,
  openDiagnosticSession,
  readTerminalAttributeHistory,
  readTerminalPresentationModeHistory,
  type BrowserLabRenderHarness,
} from './harness/terminal-render.js';
import {
  createInteractiveNodeScenario,
  createPromptReadyScenario,
  createRenderStressScenario,
} from './harness/scenarios.js';

async function waitForNewRunningAgentId(
  browserLab: Pick<BrowserLabRenderHarness, 'invokeIpc'>,
  request: unknown,
  initialRunningAgentIds: readonly string[],
  excludedAgentIds: readonly string[] = [],
): Promise<string> {
  await expect
    .poll(
      async () => {
        const runningAgentIds = await browserLab.invokeIpc<string[]>(
          request,
          IPC.ListRunningAgentIds,
        );
        return (
          runningAgentIds.find(
            (agentId) =>
              !initialRunningAgentIds.includes(agentId) && !excludedAgentIds.includes(agentId),
          ) ?? null
        );
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();

  const runningAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
  const agentId =
    runningAgentIds.find(
      (currentAgentId) =>
        !initialRunningAgentIds.includes(currentAgentId) &&
        !excludedAgentIds.includes(currentAgentId),
    ) ?? null;

  expect(agentId).toBeTruthy();
  return agentId ?? '';
}

function getTerminalOutputEntry(
  outputDiagnostics: TerminalOutputDiagnosticsSnapshot | null,
  agentId: string,
): TerminalOutputDiagnosticsSnapshot['terminals'][number] | null {
  return outputDiagnostics?.terminals.find((entry) => entry.agentId === agentId) ?? null;
}

test.describe('browser-lab terminal render stress', () => {
  test.describe('startup large buffer', () => {
    test.use({
      scenario: createRenderStressScenario('startup-buffer', {
        lineCount: 6_000,
        lineWidth: 96,
      }),
    });

    test('loads a large startup buffer without visible recovery churn', async ({
      browser,
      browserLab,
      request,
    }) => {
      test.setTimeout(180_000);

      const { context, page } = await openDiagnosticSession(browser, browserLab);
      try {
        await browserLab.beginTerminalStatusHistory(page);
        await browserLab.waitForTerminalReady(page);
        await browserLab.waitForAgentScrollback(
          request,
          browserLab.server.agentId,
          'startup buffer fixture ready',
          30_000,
        );

        const outputDiagnostics = await getOutputDiagnostics(page);
        const rendererDiagnostics = await getRendererDiagnostics(page);
        const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
        const terminal = getTerminalOutputEntry(outputDiagnostics, browserLab.server.agentId);

        expect(outputDiagnostics).not.toBeNull();
        expect(rendererDiagnostics).not.toBeNull();
        expect(outputDiagnostics?.summary.writes.totalBytes ?? 0).toBeGreaterThan(100_000);
        expect(terminal?.writes.calls ?? 0).toBeGreaterThan(0);
        expect(
          (terminal?.routed.directChunks ?? 0) + (terminal?.routed.queuedChunks ?? 0),
        ).toBeGreaterThan(0);
        expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
        await assertNoVisibleRecoveryChurn(page, browserLab);
        await assertNoTerminalAnomalies(page);
        assertTerminalDiagnosticsWithinBudget(
          await captureTerminalDiagnostics(page, browserLab, request),
          {
            maxBackendSnapshotResponses: 0,
            maxOverBudget50Frames: 12,
            maxRenderRefreshes: 0,
            maxTerminalsWithAnomalies: 0,
            maxTotalAnomalies: 0,
            maxVisibleSteadyStateSnapshots: 0,
          },
        );
      } finally {
        await context.close();
      }
    });
  });

  test.describe('resize flicker', () => {
    test.use({
      scenario: createRenderStressScenario('resize-flicker', {
        frameCount: 240,
        frameDelayMs: 18,
        lineWidth: 120,
      }),
    });

    test('keeps an alternate-screen TUI stable while the viewport changes rapidly', async ({
      browser,
      browserLab,
      request,
    }) => {
      test.setTimeout(180_000);

      const { context, page } = await openDiagnosticSession(browser, browserLab);
      try {
        await browserLab.waitForTerminalReady(page);
        await browserLab.beginTerminalStatusHistory(page);
        await beginTerminalPresentationModeHistory(page);
        await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
        await page.evaluate(() => {
          window.__parallelCodeRendererRuntimeDiagnostics?.reset();
        });

        const viewportSizes = [
          { width: 1280, height: 900 },
          { width: 1024, height: 760 },
          { width: 1366, height: 920 },
          { width: 960, height: 720 },
          { width: 1440, height: 960 },
          { width: 1100, height: 820 },
        ];

        for (const viewportSize of viewportSizes) {
          await page.setViewportSize(viewportSize);
          await page.waitForTimeout(80);
        }

        await page.waitForTimeout(250);

        const outputDiagnostics = await getOutputDiagnostics(page);
        const rendererDiagnostics = await getRendererDiagnostics(page);
        const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
        const presentationModeHistory = await readTerminalPresentationModeHistory(page);
        const terminal = getTerminalOutputEntry(outputDiagnostics, browserLab.server.agentId);

        expect(outputDiagnostics).not.toBeNull();
        expect(rendererDiagnostics).not.toBeNull();
        expect(terminal?.control.redrawChunks ?? 0).toBeGreaterThan(0);
        expect(
          (terminal?.routed.directChunks ?? 0) + (terminal?.routed.queuedChunks ?? 0),
        ).toBeGreaterThan(0);
        expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
        expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeLessThanOrEqual(
          viewportSizes.length,
        );
        expect(rendererDiagnostics?.terminalFit.executionCounts.manager ?? 0).toBeLessThanOrEqual(
          viewportSizes.length + 1,
        );
        expect(rendererDiagnostics?.terminalResize.queuedUpdates ?? 0).toBeGreaterThanOrEqual(
          rendererDiagnostics?.terminalResize.commitSuccesses ?? 0,
        );
        expect(rendererDiagnostics?.terminalPresentation.enteredCounts.loading ?? 0).toBe(0);
        expect(presentationModeHistory).not.toContain('loading');
        expect(presentationModeHistory[presentationModeHistory.length - 1]).toBe('live');
        await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
        expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
        expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
        await assertNoVisibleRecoveryChurn(page, browserLab);
        await assertNoTerminalAnomalies(page);
        assertTerminalDiagnosticsWithinBudget(
          await captureTerminalDiagnostics(page, browserLab, request),
          {
            maxBackendSnapshotResponses: 0,
            maxOverBudget50Frames: 20,
            maxQueuedQueueAgeP95Ms: 40,
            maxRenderRefreshes: 0,
            maxTerminalsWithAnomalies: 0,
            maxTotalAnomalies: 0,
            maxVisibleSteadyStateSnapshots: 0,
          },
        );
      } finally {
        await context.close();
      }
    });
  });

  test.describe('additive burst', () => {
    test.use({
      scenario: createRenderStressScenario('additive-burst', {
        burstCount: 48,
        burstDelayMs: 12,
        lineCount: 8_000,
        lineWidth: 96,
      }),
    });

    test('keeps additive TUI output incremental without visible steady-state snapshot recovery', async ({
      browser,
      browserLab,
      request,
    }) => {
      test.setTimeout(180_000);

      const { context, page } = await openDiagnosticSession(browser, browserLab);
      try {
        await browserLab.beginTerminalStatusHistory(page);
        await browserLab.waitForTerminalReady(page);
        await browserLab.waitForAgentScrollback(
          request,
          browserLab.server.agentId,
          'additive burst fixture ready',
          30_000,
        );

        const outputDiagnostics = await getOutputDiagnostics(page);
        const rendererDiagnostics = await getRendererDiagnostics(page);
        const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
        const terminal = getTerminalOutputEntry(outputDiagnostics, browserLab.server.agentId);

        expect(outputDiagnostics).not.toBeNull();
        expect(rendererDiagnostics).not.toBeNull();
        expect(terminal?.writes.calls ?? 0).toBeGreaterThan(0);
        expect(outputDiagnostics?.summary.writes.totalBytes ?? 0).toBeGreaterThan(400_000);
        expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
        expect(
          (rendererDiagnostics?.terminalRecovery.visibleSteadyStateSnapshotCounts.backpressure ??
            0) +
            (rendererDiagnostics?.terminalRecovery.visibleSteadyStateSnapshotCounts.hibernate ??
              0) +
            (rendererDiagnostics?.terminalRecovery.visibleSteadyStateSnapshotCounts.reconnect ?? 0),
        ).toBe(0);
        expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
        await assertNoVisibleRecoveryChurn(page, browserLab);
        await assertNoTerminalAnomalies(page);
        assertTerminalDiagnosticsWithinBudget(
          await captureTerminalDiagnostics(page, browserLab, request),
          {
            maxBackendSnapshotResponses: 0,
            maxOverBudget50Frames: 12,
            maxQueuedQueueAgeP95Ms: 40,
            maxRenderRefreshes: 0,
            maxTerminalsWithAnomalies: 0,
            maxTotalAnomalies: 0,
            maxVisibleSteadyStateSnapshots: 0,
          },
        );
      } finally {
        await context.close();
      }
    });
  });

  test.describe('control redraw', () => {
    test.use({
      scenario: createRenderStressScenario('control-heavy', {
        frameCount: 180,
        frameDelayMs: 18,
      }),
    });

    test('keeps a cursor-addressed control-heavy TUI free of render anomalies', async ({
      browser,
      browserLab,
      request,
    }) => {
      test.setTimeout(180_000);

      const { context, page } = await openDiagnosticSession(browser, browserLab);
      try {
        await browserLab.beginTerminalStatusHistory(page);
        await browserLab.waitForTerminalReady(page);
        await browserLab.waitForAgentScrollback(
          request,
          browserLab.server.agentId,
          'control redraw fixture ready',
          30_000,
        );
        await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
        await page.evaluate(() => {
          window.__parallelCodeTerminalAnomalyMonitor?.reset();
        });

        await page.waitForTimeout(1_500);

        const outputDiagnostics = await getOutputDiagnostics(page);
        const rendererDiagnostics = await getRendererDiagnostics(page);
        const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
        const terminal = getTerminalOutputEntry(outputDiagnostics, browserLab.server.agentId);

        expect(outputDiagnostics).not.toBeNull();
        expect(rendererDiagnostics).not.toBeNull();
        expect(terminal?.control.redrawChunks ?? 0).toBeGreaterThan(0);
        expect(terminal?.control.saveRestoreCount ?? 0).toBeGreaterThan(0);
        expect(terminal?.control.cursorPositionCount ?? 0).toBeGreaterThan(0);
        expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
        expect(rendererDiagnostics?.terminalRecovery.renderRefreshes ?? 0).toBe(0);
        expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
        await assertNoVisibleRecoveryChurn(page, browserLab);
        await assertNoTerminalAnomalies(page);
        assertTerminalDiagnosticsWithinBudget(
          await captureTerminalDiagnostics(page, browserLab, request),
          {
            maxBackendSnapshotResponses: 0,
            maxFocusedQueueAgeP95Ms: 32,
            maxOverBudget50Frames: 6,
            maxQueuedQueueAgeP95Ms: 40,
            maxRenderRefreshes: 0,
            maxTerminalsWithAnomalies: 0,
            maxTotalAnomalies: 0,
            maxVisibleSteadyStateSnapshots: 0,
          },
        );
      } finally {
        await context.close();
      }
    });

    test('keeps control-heavy panel resize on committed resize fits without extra session stabilization fits', async ({
      browser,
      browserLab,
      request,
    }) => {
      test.setTimeout(180_000);

      const { context, page } = await openDiagnosticSession(browser, browserLab);
      try {
        await browserLab.beginTerminalStatusHistory(page);
        await browserLab.waitForTerminalReady(page);
        await browserLab.waitForAgentScrollback(
          request,
          browserLab.server.agentId,
          'control redraw fixture ready',
          30_000,
        );
        await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
        await page.evaluate(() => {
          window.__parallelCodeRendererRuntimeDiagnostics?.reset();
          window.__parallelCodeTerminalAnomalyMonitor?.reset();
        });

        const resizeDeltas = [130, -100, 120, -90];
        for (const resizeDelta of resizeDeltas) {
          await dragTerminalPanelResizeHandle(page, 0, resizeDelta);
          await page.waitForTimeout(90);
        }

        await page.waitForTimeout(600);

        const outputDiagnostics = await getOutputDiagnostics(page);
        const rendererDiagnostics = await getRendererDiagnostics(page);
        const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
        const terminal = getTerminalOutputEntry(outputDiagnostics, browserLab.server.agentId);

        expect(outputDiagnostics).not.toBeNull();
        expect(rendererDiagnostics).not.toBeNull();
        expect(terminal?.control.redrawChunks ?? 0).toBeGreaterThan(0);
        expect(terminal?.control.saveRestoreCount ?? 0).toBeGreaterThan(0);
        expect(terminal?.control.cursorPositionCount ?? 0).toBeGreaterThan(0);
        expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
        expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeLessThanOrEqual(
          resizeDeltas.length * 2,
        );
        expect(rendererDiagnostics?.terminalFit.executionCounts['session-immediate'] ?? 0).toBe(0);
        expect(rendererDiagnostics?.terminalFit.executionCounts['session-raf'] ?? 0).toBe(0);
        expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
        expect(rendererDiagnostics?.terminalRecovery.renderRefreshes ?? 0).toBe(0);
        expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
        await assertNoVisibleRecoveryChurn(page, browserLab);
        await assertNoTerminalAnomalies(page);
        assertTerminalDiagnosticsWithinBudget(
          await captureTerminalDiagnostics(page, browserLab, request),
          {
            maxBackendSnapshotResponses: 0,
            maxFocusedQueueAgeP95Ms: 40,
            maxOverBudget50Frames: 8,
            maxQueuedQueueAgeP95Ms: 48,
            maxRenderRefreshes: 0,
            maxTerminalsWithAnomalies: 0,
            maxTotalAnomalies: 0,
            maxVisibleSteadyStateSnapshots: 0,
          },
        );
      } finally {
        await context.close();
      }
    });
  });

  test.describe('generic workload variants', () => {
    test.describe('progress redraw', () => {
      test.use({
        scenario: createRenderStressScenario('progress-redraw', {
          frameCount: 180,
          frameDelayMs: 18,
        }),
      });

      test('tracks carriage-return progress redraw without terminal anomalies', async ({
        browser,
        browserLab,
        request,
      }) => {
        test.setTimeout(180_000);

        const { context, page } = await openDiagnosticSession(browser, browserLab);
        try {
          await browserLab.beginTerminalStatusHistory(page);
          await browserLab.waitForTerminalReady(page);
          await browserLab.waitForAgentScrollback(
            request,
            browserLab.server.agentId,
            'progress redraw fixture ready',
            30_000,
          );

          await page.waitForTimeout(900);

          const outputDiagnostics = await getOutputDiagnostics(page);
          const rendererDiagnostics = await getRendererDiagnostics(page);
          const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
          const terminal = getTerminalOutputEntry(outputDiagnostics, browserLab.server.agentId);

          expect(outputDiagnostics).not.toBeNull();
          expect(rendererDiagnostics).not.toBeNull();
          expect(terminal?.control.carriageReturnChunks ?? 0).toBeGreaterThan(0);
          expect(terminal?.control.clearLineChunks ?? 0).toBeGreaterThan(0);
          expect(terminal?.control.cursorPositionChunks ?? 0).toBeGreaterThan(0);
          expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
          await assertNoVisibleRecoveryChurn(page, browserLab);
          await assertNoTerminalAnomalies(page);
          assertTerminalDiagnosticsWithinBudget(
            await captureTerminalDiagnostics(page, browserLab, request),
            {
              maxBackendSnapshotResponses: 0,
              maxFocusedQueueAgeP95Ms: 40,
              maxRenderRefreshes: 0,
              maxTerminalsWithAnomalies: 0,
              maxTotalAnomalies: 0,
              maxVisibleSteadyStateSnapshots: 0,
            },
          );
        } finally {
          await context.close();
        }
      });
    });

    test.describe('prompt middle', () => {
      test.use({
        scenario: createRenderStressScenario('prompt-middle', {
          frameCount: 180,
          frameDelayMs: 18,
        }),
      });

      test('tracks midpoint prompt redraw without terminal anomalies', async ({
        browser,
        browserLab,
        request,
      }) => {
        test.setTimeout(180_000);

        const { context, page } = await openDiagnosticSession(browser, browserLab);
        try {
          await browserLab.beginTerminalStatusHistory(page);
          await browserLab.waitForTerminalReady(page);
          await browserLab.waitForAgentScrollback(
            request,
            browserLab.server.agentId,
            'prompt middle fixture ready',
            30_000,
          );

          await page.waitForTimeout(900);

          const outputDiagnostics = await getOutputDiagnostics(page);
          const rendererDiagnostics = await getRendererDiagnostics(page);
          const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
          const terminal = getTerminalOutputEntry(outputDiagnostics, browserLab.server.agentId);

          expect(outputDiagnostics).not.toBeNull();
          expect(rendererDiagnostics).not.toBeNull();
          expect(terminal?.control.cursorPositionChunks ?? 0).toBeGreaterThan(0);
          expect(terminal?.control.saveRestoreChunks ?? 0).toBeGreaterThan(0);
          expect(terminal?.control.redrawChunks ?? 0).toBeGreaterThan(0);
          expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
          await assertNoVisibleRecoveryChurn(page, browserLab);
          await assertNoTerminalAnomalies(page);
          assertTerminalDiagnosticsWithinBudget(
            await captureTerminalDiagnostics(page, browserLab, request),
            {
              maxBackendSnapshotResponses: 0,
              maxFocusedQueueAgeP95Ms: 40,
              maxRenderRefreshes: 0,
              maxTerminalsWithAnomalies: 0,
              maxTotalAnomalies: 0,
              maxVisibleSteadyStateSnapshots: 0,
            },
          );
        } finally {
          await context.close();
        }
      });
    });

    test.describe('save restore resize', () => {
      test.use({
        scenario: createRenderStressScenario('save-restore-resize', {
          frameCount: 180,
          frameDelayMs: 18,
        }),
      });

      test('tracks save-restore resize redraw without terminal anomalies', async ({
        browser,
        browserLab,
        request,
      }) => {
        test.setTimeout(180_000);

        const { context, page } = await openDiagnosticSession(browser, browserLab);
        try {
          await browserLab.beginTerminalStatusHistory(page);
          await browserLab.waitForTerminalReady(page);
          await browserLab.waitForAgentScrollback(
            request,
            browserLab.server.agentId,
            'save-restore resize fixture ready',
            30_000,
          );

          const viewportSizes = [
            { width: 1260, height: 860 },
            { width: 1080, height: 760 },
            { width: 1420, height: 920 },
          ];

          for (const viewportSize of viewportSizes) {
            await page.setViewportSize(viewportSize);
            await page.waitForTimeout(80);
          }

          await page.waitForTimeout(900);

          const outputDiagnostics = await getOutputDiagnostics(page);
          const rendererDiagnostics = await getRendererDiagnostics(page);
          const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
          const terminal = getTerminalOutputEntry(outputDiagnostics, browserLab.server.agentId);

          expect(outputDiagnostics).not.toBeNull();
          expect(rendererDiagnostics).not.toBeNull();
          expect(terminal?.control.saveRestoreChunks ?? 0).toBeGreaterThan(0);
          expect(terminal?.control.cursorPositionChunks ?? 0).toBeGreaterThan(0);
          expect(terminal?.control.redrawChunks ?? 0).toBeGreaterThan(0);
          expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
          expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
          await assertNoVisibleRecoveryChurn(page, browserLab);
          await assertNoTerminalAnomalies(page);
          assertTerminalDiagnosticsWithinBudget(
            await captureTerminalDiagnostics(page, browserLab, request),
            {
              maxBackendSnapshotResponses: 0,
              maxFocusedQueueAgeP95Ms: 48,
              maxQueuedQueueAgeP95Ms: 48,
              maxRenderRefreshes: 0,
              maxTerminalsWithAnomalies: 0,
              maxTotalAnomalies: 0,
              maxVisibleSteadyStateSnapshots: 0,
            },
          );
        } finally {
          await context.close();
        }
      });
    });
  });

  test.describe('real shell additive resize continuity', () => {
    test.use({
      scenario: createPromptReadyScenario(),
    });

    test('keeps a real shell terminal continuous while noisy output and resize churn overlap', async ({
      browser,
      browserLab,
      request,
    }) => {
      test.setTimeout(180_000);

      const { context, page } = await openDiagnosticSession(browser, browserLab, {
        displayName: 'Real Shell Additive Resize Tester',
      });
      try {
        await browserLab.waitForTerminalReady(page);
        const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
          request,
          IPC.ListRunningAgentIds,
        );
        const shellTerminalIndex = await browserLab.createShellTerminal(page);
        const shellAgentId = await waitForNewRunningAgentId(
          browserLab,
          request,
          initialRunningAgentIds,
        );

        await browserLab.focusTerminal(page, shellTerminalIndex);
        await expect.poll(() => getTerminalSurfaceTier(page, 0)).toBe('passive-visible');
        await expect.poll(() => getTerminalPresentationMode(page, 0)).toBe('live');
        await expect
          .poll(() => getTerminalSurfaceTier(page, shellTerminalIndex))
          .toBe('interactive-live');
        await expect.poll(() => getTerminalPresentationMode(page, shellTerminalIndex)).toBe('live');

        const shellReadyMarker = '__REAL_SHELL_READY__';
        await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
          agentId: shellAgentId,
          data: `printf "${shellReadyMarker}\\n"\r`,
        });
        await browserLab.waitForAgentScrollback(request, shellAgentId, shellReadyMarker, 10_000);

        await browserLab.beginTerminalStatusHistory(page, shellTerminalIndex);
        await beginTerminalPresentationModeHistory(page, shellTerminalIndex);
        await beginTerminalAttributeHistory(
          page,
          'data-terminal-render-hibernating',
          shellTerminalIndex,
        );
        await beginTerminalAttributeHistory(page, 'data-terminal-surface-tier', shellTerminalIndex);
        await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
        await page.evaluate(() => {
          window.__parallelCodeRendererRuntimeDiagnostics?.reset();
        });

        const noisyCommand =
          'i=0; while [ "$i" -lt 2200 ]; do printf "REAL_AGENT_ADD_%05d real-agent-additive-catch-up-real-agent-additive-catch-up-real-agent-additive-catch-up\\n" "$i"; if [ $((i % 80)) -eq 0 ]; then printf "REAL_AGENT_PROGRESS_%05d\\n" "$i"; fi; i=$((i+1)); sleep 0.004; done; printf "__REAL_AGENT_ADDITIVE_DONE__\\n"';

        await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
          agentId: shellAgentId,
          data: `${noisyCommand}\r`,
        });
        await browserLab.waitForAgentScrollback(
          request,
          shellAgentId,
          'REAL_AGENT_ADD_00010',
          10_000,
        );

        const resizeDeltas = [140, -110, 120, -90, 100, -80];
        for (const resizeDelta of resizeDeltas) {
          await dragTerminalPanelResizeHandle(page, shellTerminalIndex, resizeDelta);
          await page.waitForTimeout(90);
        }

        await browserLab.waitForAgentScrollback(
          request,
          shellAgentId,
          '__REAL_AGENT_ADDITIVE_DONE__',
          30_000,
        );
        const postResizeMarker = '__REAL_AGENT_AFTER_PANEL_DRAG__';
        await browserLab.runInTerminal(page, `printf "${postResizeMarker}\\n"`, {
          terminalIndex: shellTerminalIndex,
        });
        await browserLab.waitForAgentScrollback(request, shellAgentId, postResizeMarker, 10_000);
        await expect
          .poll(() => getTerminalPresentationMode(page, shellTerminalIndex), { timeout: 10_000 })
          .toBe('live');
        await assertInteractiveTerminalLifecycleInvariants(
          browserLab,
          request,
          page,
          browserLab.server.taskId,
          {
            requireDocumentFocus: true,
            terminalIndex: shellTerminalIndex,
          },
        );

        const outputDiagnostics = await getOutputDiagnostics(page);
        const rendererDiagnostics = await getRendererDiagnostics(page);
        const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
        const presentationModeHistory = await readTerminalPresentationModeHistory(page);
        const renderHibernatingHistory = await readTerminalAttributeHistory(
          page,
          'data-terminal-render-hibernating',
          shellTerminalIndex,
        );
        const surfaceTierHistory = await readTerminalAttributeHistory(
          page,
          'data-terminal-surface-tier',
          shellTerminalIndex,
        );
        const terminal = getTerminalOutputEntry(outputDiagnostics, shellAgentId);

        expect(outputDiagnostics).not.toBeNull();
        expect(rendererDiagnostics).not.toBeNull();
        expect(terminal?.writes.calls ?? 0).toBeGreaterThan(0);
        expect(
          (terminal?.routed.directChunks ?? 0) + (terminal?.routed.queuedChunks ?? 0),
        ).toBeGreaterThan(0);
        expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
        expect(rendererDiagnostics?.terminalPresentation.enteredCounts.loading ?? 0).toBe(0);
        expect(presentationModeHistory).not.toContain('loading');
        expect(presentationModeHistory[presentationModeHistory.length - 1]).toBe('live');
        expect(renderHibernatingHistory[renderHibernatingHistory.length - 1]).not.toBe('true');
        expect(surfaceTierHistory[surfaceTierHistory.length - 1]).toBe('interactive-live');
        await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
        await expect(getTerminalLoadingOverlay(page, shellTerminalIndex)).toHaveCount(0);
        expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
        expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
        await assertNoVisibleRecoveryChurn(page, browserLab, shellTerminalIndex);
        await assertNoTerminalAnomalies(page);
        assertTerminalDiagnosticsWithinBudget(
          await captureTerminalDiagnostics(page, browserLab, request),
          {
            maxBackendSnapshotResponses: 0,
            maxFocusedQueueAgeP95Ms: 48,
            maxRenderRefreshes: 0,
            maxTerminalsWithAnomalies: 0,
            maxTotalAnomalies: 0,
            maxVisibleSteadyStateSnapshots: 0,
          },
        );
      } finally {
        await context.close();
      }
    });
  });
});

test.describe('browser-lab real terminal acceptance', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('keeps an interactive terminal responsive after bounded noisy output and panel resize', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(60_000);

    const { context, page } = await openDiagnosticSession(browser, browserLab);
    try {
      await browserLab.waitForTerminalReady(page);
      await browserLab.beginTerminalStatusHistory(page);
      await beginTerminalPresentationModeHistory(page);
      await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
      await page.evaluate(() => {
        window.__parallelCodeRendererRuntimeDiagnostics?.reset();
      });

      const workload =
        'let __pcBurst=0; const __pcTimer=setInterval(()=>{ console.log(String(__pcBurst).padStart(4,"0")+" REAL_AGENT_BURST"); if(++__pcBurst===48){ clearInterval(__pcTimer); console.log("__REAL_AGENT_DONE__"); } }, 16);';

      await browserLab.runInTerminal(page, workload);

      const resizeDeltas = [120, -90, 70];
      for (const resizeDelta of resizeDeltas) {
        await dragTerminalPanelResizeHandle(page, 0, resizeDelta);
        await page.waitForTimeout(90);
      }
      await expect
        .poll(
          async () => (await getRendererDiagnostics(page))?.terminalResize.commitSuccesses ?? 0,
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);

      await browserLab.waitForAgentScrollback(
        request,
        browserLab.server.agentId,
        '__REAL_AGENT_DONE__',
        10_000,
      );

      const marker = '__REAL_AGENT_AFTER_RESIZE__';
      await browserLab.runInTerminal(page, `console.log("${marker}")`);
      await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker, 10_000);
      await assertInteractiveTerminalLifecycleInvariants(
        browserLab,
        request,
        page,
        browserLab.server.taskId,
        {
          requireDocumentFocus: true,
        },
      );

      const rendererDiagnostics = await getRendererDiagnostics(page);
      const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
      const presentationModeHistory = await readTerminalPresentationModeHistory(page);

      expect(rendererDiagnostics).not.toBeNull();
      expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
      expect(
        (rendererDiagnostics?.terminalRecovery.visibleSteadyStateSnapshotCounts.backpressure ?? 0) +
          (rendererDiagnostics?.terminalRecovery.visibleSteadyStateSnapshotCounts.reconnect ?? 0),
      ).toBe(0);
      expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
      expect(rendererDiagnostics?.terminalPresentation.enteredCounts.loading ?? 0).toBe(0);
      expect(presentationModeHistory).not.toContain('loading');
      expect(presentationModeHistory[presentationModeHistory.length - 1]).toBe('live');
      await expect(getTerminalLoadingOverlay(page)).toHaveCount(0);
      await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
      expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
      await assertNoVisibleRecoveryChurn(page, browserLab);
      await assertNoTerminalAnomalies(page);
      assertTerminalDiagnosticsWithinBudget(
        await captureTerminalDiagnostics(page, browserLab, request),
        {
          maxBackendSnapshotResponses: 0,
          maxFocusedQueueAgeP95Ms: 48,
          maxRenderRefreshes: 0,
          maxTerminalsWithAnomalies: 0,
          maxTotalAnomalies: 0,
          maxVisibleSteadyStateSnapshots: 0,
        },
      );
    } finally {
      await context.close();
    }
  });
});
