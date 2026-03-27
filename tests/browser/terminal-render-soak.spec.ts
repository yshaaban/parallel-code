import { IPC } from '../../electron/ipc/channels.js';

import { expect, getTerminalLoadingOverlay, test } from './harness/fixtures.js';
import {
  assertNoTerminalAnomalies,
  assertNoVisibleRecoveryChurn,
  beginTerminalPresentationModeHistory,
  dragTerminalPanelResizeHandle,
  getBackendDiagnostics,
  getRendererDiagnostics,
  openDiagnosticSession,
  readTerminalPresentationModeHistory,
} from './harness/terminal-render.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

test.describe('browser-lab terminal render soak', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('keeps an interactive terminal stable while noisy additive output and resize happen together', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(180_000);

    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Browser Lab Terminal Soak Tester',
    });
    try {
      await browserLab.waitForTerminalReady(page);
      await browserLab.beginTerminalStatusHistory(page);
      await beginTerminalPresentationModeHistory(page);
      await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
      await page.evaluate(() => {
        window.__parallelCodeRendererRuntimeDiagnostics?.reset();
      });

      const workload =
        'let __pcBurst=0; const __pcTimer=setInterval(()=>{ console.log(String(__pcBurst).padStart(4,"0")+" REAL_AGENT_BURST"); if(++__pcBurst===180){ clearInterval(__pcTimer); console.log("__REAL_AGENT_DONE__"); } }, 12);';

      await browserLab.runInTerminal(page, workload);

      const resizeDeltas = [140, -110, 90, -70];
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
        20_000,
      );

      const marker = '__REAL_AGENT_AFTER_RESIZE__';
      await browserLab.runInTerminal(page, `console.log("${marker}")`);
      await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker, 10_000);

      const rendererDiagnostics = await getRendererDiagnostics(page);
      const backendDiagnostics = await getBackendDiagnostics(browserLab, request);
      const presentationModeHistory = await readTerminalPresentationModeHistory(page);

      expect(rendererDiagnostics).not.toBeNull();
      expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
      expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
      expect(rendererDiagnostics?.terminalPresentation.enteredCounts.loading ?? 0).toBe(0);
      expect(presentationModeHistory).not.toContain('loading');
      expect(presentationModeHistory[presentationModeHistory.length - 1]).toBe('live');
      await expect(getTerminalLoadingOverlay(page)).toHaveCount(0);
      await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
      expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
      await assertNoVisibleRecoveryChurn(page, browserLab);
      await assertNoTerminalAnomalies(page);
    } finally {
      await context.close();
    }
  });
});
