import { expect, test } from './harness/fixtures.js';
import { getRendererDiagnostics } from './harness/terminal-render.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

test.describe('browser-lab terminal WebGL repaint recovery', () => {
  test.use({ scenario: createInteractiveNodeScenario() });

  test('repairs the exact foreground WebGL surface and keeps it visibly usable', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'WebGL Repaint Tester',
      prepareContext: async (browserContext) => {
        await browserContext.addInitScript(() => {
          Object.defineProperty(navigator, 'userAgent', {
            configurable: true,
            value:
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          });
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });

    try {
      await browserLab.waitForTerminalReady(page);
      await browserLab.focusTerminal(page);
      await expect
        .poll(async () => {
          const diagnostics = await getRendererDiagnostics(page);
          return (
            (diagnostics?.terminalRenderer.activeContextsCurrent ?? 0) +
            (diagnostics?.terminalRenderer.acquireMisses ?? 0)
          );
        })
        .toBeGreaterThan(0);

      const initialDiagnostics = await getRendererDiagnostics(page);
      expect(initialDiagnostics).not.toBeNull();
      const activeContexts = initialDiagnostics?.terminalRenderer.activeContextsCurrent ?? 0;
      const screen = page.locator('.xterm-screen').first();
      await expect(screen).toBeVisible();

      if (activeContexts === 0) {
        test.info().annotations.push({
          type: 'environment-limitation',
          description:
            'Chromium did not provide an xterm WebGL context; verified explicit fallback.',
        });
        expect(initialDiagnostics?.terminalRenderer.acquireMisses ?? 0).toBeGreaterThan(0);
        return;
      }

      const initialActiveContexts = activeContexts;
      const initialApplied = initialDiagnostics?.terminalRenderer.atlasRepair.applied ?? 0;
      const initialForegroundIntents =
        initialDiagnostics?.terminalRenderer.atlasRepair.intents.foreground ?? 0;

      await page.evaluate(() => {
        let focused = false;
        Object.defineProperty(document, 'hasFocus', {
          configurable: true,
          value: () => focused,
        });
        window.dispatchEvent(new Event('blur'));
        focused = true;
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await expect
        .poll(async () => {
          const diagnostics = await getRendererDiagnostics(page);
          return diagnostics?.terminalRenderer.atlasRepair.applied ?? 0;
        })
        .toBe(initialApplied + 1);

      const foregroundDiagnostics = await getRendererDiagnostics(page);
      expect(foregroundDiagnostics?.terminalRenderer.atlasRepair.intents.foreground ?? 0).toBe(
        initialForegroundIntents + 1,
      );
      expect(foregroundDiagnostics?.terminalRenderer.activeContextsCurrent ?? 0).toBe(
        initialActiveContexts,
      );
      expect(foregroundDiagnostics?.terminalRenderer.atlasRepair.failed ?? 0).toBe(0);

      const manualIntents = foregroundDiagnostics?.terminalRenderer.atlasRepair.intents.manual ?? 0;
      const appliedBeforeManual = foregroundDiagnostics?.terminalRenderer.atlasRepair.applied ?? 0;
      await page.keyboard.press('Meta+Shift+L');
      await expect
        .poll(async () => {
          const diagnostics = await getRendererDiagnostics(page);
          return diagnostics?.terminalRenderer.atlasRepair.intents.manual ?? 0;
        })
        .toBe(manualIntents + 1);
      await expect
        .poll(async () => {
          const diagnostics = await getRendererDiagnostics(page);
          return diagnostics?.terminalRenderer.atlasRepair.applied ?? 0;
        })
        .toBe(appliedBeforeManual + 1);

      const beforeOutput = await screen.screenshot();
      const marker = 'WEBGL_REPAINT_SURFACE_OK';
      await browserLab.runInTerminal(page, `console.log("${marker}")`);
      await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker);
      await page.waitForTimeout(100);
      const afterOutput = await screen.screenshot();
      expect(afterOutput.equals(beforeOutput)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test('records a manual redraw intent without touching DOM-only terminals', async ({
    browser,
    browserLab,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'DOM Repaint Skip Tester',
      prepareContext: async (browserContext) => {
        await browserContext.addInitScript(() => {
          const originalGetContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function getContextWithoutWebgl(
            contextId: string,
            ...args: unknown[]
          ): RenderingContext | null {
            if (
              contextId === 'webgl' ||
              contextId === 'webgl2' ||
              contextId === 'experimental-webgl'
            ) {
              return null;
            }
            return originalGetContext.call(this, contextId, ...args);
          };
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });

    try {
      await browserLab.waitForTerminalReady(page);
      await browserLab.focusTerminal(page);
      await expect
        .poll(async () => {
          const diagnostics = await getRendererDiagnostics(page);
          return diagnostics?.terminalRenderer.acquireMisses ?? 0;
        })
        .toBeGreaterThan(0);

      const before = await getRendererDiagnostics(page);
      await page.keyboard.press('Control+Shift+L');
      await expect
        .poll(async () => {
          const diagnostics = await getRendererDiagnostics(page);
          return diagnostics?.terminalRenderer.atlasRepair.intents.manual ?? 0;
        })
        .toBe((before?.terminalRenderer.atlasRepair.intents.manual ?? 0) + 1);

      const after = await getRendererDiagnostics(page);
      expect(after?.terminalRenderer.activeContextsCurrent ?? 0).toBe(0);
      expect(after?.terminalRenderer.atlasRepair.applied ?? 0).toBe(
        before?.terminalRenderer.atlasRepair.applied ?? 0,
      );
      expect(after?.terminalRenderer.atlasRepair.queued ?? 0).toBe(
        before?.terminalRenderer.atlasRepair.queued ?? 0,
      );
    } finally {
      await context.close();
    }
  });
});
