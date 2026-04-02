import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';
import { getRendererDiagnostics, openDiagnosticSession } from './harness/terminal-render.js';

const RUN_BROWSER_STARTUP_METRICS = process.env.RUN_BROWSER_STARTUP_METRICS === '1';
const startupMetricsTest = RUN_BROWSER_STARTUP_METRICS ? test : test.skip;

startupMetricsTest.describe('browser startup metrics', () => {
  startupMetricsTest.use({
    scenario: createPromptReadyScenario(320),
  });

  startupMetricsTest(
    'captures cold bootstrap and selected-terminal timings',
    async ({ browser, browserLab }) => {
      const { context, page } = await openDiagnosticSession(browser, browserLab, {
        displayName: 'Startup Metrics',
      });

      try {
        await page.locator('.app-shell').waitFor({ state: 'visible' });
        await browserLab.waitForTerminalInteractiveReady(page, 0, {
          requireLiveRenderReady: true,
        });

        const diagnostics = await getRendererDiagnostics(page);

        expect(diagnostics).toBeTruthy();
        expect(diagnostics?.browserStartup.modeCompleteCounts['cold-bootstrap']).toBe(1);
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

        console.warn(
          JSON.stringify(
            {
              bootstrap: diagnostics?.bootstrap ?? null,
              browserStartup: diagnostics?.browserStartup ?? null,
              browserSync: diagnostics?.browserSync ?? null,
              terminalStartupPaint: {
                logicalReadyLastMs: {
                  selected: diagnostics?.terminalStartupPaint.logicalReadyLastMs.selected ?? null,
                },
                paintReadyLastMs: {
                  selected: diagnostics?.terminalStartupPaint.paintReadyLastMs.selected ?? null,
                },
              },
            },
            null,
            2,
          ),
        );
      } finally {
        await context.close();
      }
    },
  );
});
