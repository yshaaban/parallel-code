import { expect, test } from './harness/fixtures.js';
import { getRendererDiagnostics } from './harness/terminal-render.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';
import { getBrowserPrimaryModifier } from './harness/browser-platform.js';
import { IPC } from '../../electron/ipc/channels.js';

// Exercise real WebGL rendering deterministically; this is software-ANGLE coverage,
// not evidence about the host GPU. The DOM-only case still denies context creation.
test.use({
  deviceScaleFactor: 2,
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--force-device-scale-factor=2',
    ],
  },
});

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
          return diagnostics?.terminalRenderer.activeContextsCurrent ?? 0;
        })
        .toBeGreaterThan(0);

      const initialDiagnostics = await getRendererDiagnostics(page);
      expect(initialDiagnostics).not.toBeNull();
      const activeContexts = initialDiagnostics?.terminalRenderer.activeContextsCurrent ?? 0;
      const screen = page.locator('.xterm-screen').first();
      await expect(screen).toBeVisible();

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

test.describe('browser-lab shared WebGL atlas continuity', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('keeps sibling glyph pixels intact after repairing real shared WebGL surfaces at DPR2', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'Shared WebGL Atlas Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });
    try {
      expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
      await browserLab.waitForTerminalReady(page);
      await page.getByTitle(/^Open terminal /u).click();
      const primary = page.locator(`[data-terminal-agent-id="${browserLab.server.agentId}"]`);
      const auxiliary = page.locator(
        `[data-terminal-agent-id]:not([data-terminal-agent-id="${browserLab.server.agentId}"])`,
      );
      await expect(auxiliary).toHaveAttribute('data-terminal-status', 'ready');
      const surfaces = [primary, auxiliary];
      const initialInputs = [];
      const baselines: Buffer[] = [];
      const scrollbacks: string[] = [];
      const sessionIds: string[] = [];
      const grids = [
        '\u001b[36mABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGH\r\n'.repeat(4),
        '\u001b[33m0123456789!@#$%^&*()[]{}<>?/+=-_0123\r\n'.repeat(4),
      ];

      async function glyphPixels(index: number): Promise<Buffer> {
        const bounds = await surfaces[index].locator('.xterm-screen').boundingBox();
        if (!bounds) throw new Error('Expected the exact WebGL terminal screen');
        return page.screenshot({
          animations: 'disabled',
          clip: { x: bounds.x, y: bounds.y, width: 260, height: 48 },
        });
      }

      async function containsColoredGlyphs(index: number, pixels: Buffer): Promise<boolean> {
        return page.evaluate(
          async ({ index, png }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${png}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Expected screenshot decoding context');
            context.drawImage(image, 0, 0);
            const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const coloredRegions = new Uint32Array(9);
            for (let offset = 0; offset < data.length; offset += 4) {
              const [red, green, blue] = data.subarray(offset, offset + 3);
              if (
                index === 0
                  ? green > 60 && blue > 60 && green > red * 1.5 && blue > red * 1.5
                  : red > 100 && green > 100 && blue < Math.min(red, green) / 2
              ) {
                const pixel = offset / 4;
                const column = Math.min(2, Math.floor(((pixel % canvas.width) * 3) / canvas.width));
                const row = Math.min(
                  2,
                  Math.floor((Math.floor(pixel / canvas.width) * 3) / canvas.height),
                );
                coloredRegions[row * 3 + column]++;
              }
            }
            return coloredRegions.every((colored) => colored > 100);
          },
          { index, png: pixels.toString('base64') },
        );
      }

      for (const [index, surface] of surfaces.entries()) {
        const sessionId = await surface.getAttribute('data-terminal-agent-id');
        if (!sessionId) throw new Error('Expected a canonical terminal session identity');
        sessionIds.push(sessionId);
        const input = surface.getByRole('textbox', { name: 'Terminal input' });
        initialInputs.push(await input.elementHandle());
        await input.focus();
        const output = `\u001b[2J\u001b[H\u001b[?25l${grids[index]}\u001b[0m\r\n`;
        const command =
          index === 0
            ? `process.stdout.write(${JSON.stringify(output)})`
            : `printf '%b' '${output.replaceAll('\u001b', '\\033').replaceAll('\r', '\\r').replaceAll('\n', '\\n')}'`;
        await page.keyboard.insertText(command);
        await page.keyboard.press('Enter');
        await browserLab.waitForAgentScrollback(request, sessionId, grids[index].slice(5, 35));
        await expect
          .poll(() =>
            surface.evaluate((element) =>
              Array.from(element.querySelectorAll('canvas')).some((canvas) => {
                const gl = canvas.getContext('webgl2');
                return gl !== null && !gl.isContextLost() && gl.drawingBufferWidth > 0;
              }),
            ),
          )
          .toBe(true);
      }
      await expect
        .poll(
          async () => (await getRendererDiagnostics(page))?.terminalRenderer.activeContextsCurrent,
        )
        .toBe(2);

      const rendererMetadata = await page
        .locator('[data-terminal-agent-id]')
        .evaluateAll((elements) =>
          elements.map((element) => ({
            agentId: element.getAttribute('data-terminal-agent-id'),
            contexts: Array.from(element.querySelectorAll('canvas')).flatMap((canvas) => {
              const gl = canvas.getContext('webgl2');
              if (!gl) return [];
              const extension = gl.getExtension('WEBGL_debug_renderer_info');
              const bounds = canvas.getBoundingClientRect();
              return [
                {
                  renderer: gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
                  vendor: gl.getParameter(extension?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
                  lost: gl.isContextLost(),
                  width: canvas.width,
                  height: canvas.height,
                  cssWidth: bounds.width,
                  cssHeight: bounds.height,
                },
              ];
            }),
          })),
        );
      await test.info().attach('actual-webgl-renderers', {
        body: JSON.stringify(rendererMetadata),
        contentType: 'application/json',
      });
      for (const surface of rendererMetadata) {
        expect(surface.contexts).toHaveLength(1);
        expect(surface.contexts[0].lost).toBe(false);
        expect(surface.contexts[0].width).toBeCloseTo(surface.contexts[0].cssWidth * 2, 0);
        expect(surface.contexts[0].height).toBeCloseTo(surface.contexts[0].cssHeight * 2, 0);
      }
      for (const [index, sessionId] of sessionIds.entries()) {
        // Backend scrollback can lead the renderer. Establish actual colored glyph paint,
        // not an empty/black or previous-frame baseline that could pass vacuously.
        await expect
          .poll(async () => containsColoredGlyphs(index, await glyphPixels(index)))
          .toBe(true);
        baselines.push(await glyphPixels(index));
        scrollbacks.push(
          await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, {
            agentId: sessionId,
          }),
        );
        await test.info().attach(`sibling-${index}-before-repair`, {
          body: baselines[index],
          contentType: 'image/png',
        });
      }
      const before = await getRendererDiagnostics(page);
      await page.keyboard.press(`${await getBrowserPrimaryModifier(page)}+Shift+L`);
      await expect
        .poll(
          async () => (await getRendererDiagnostics(page))?.terminalRenderer.atlasRepair.applied,
        )
        .toBe((before?.terminalRenderer.atlasRepair.applied ?? 0) + 2);

      for (const [index, surface] of surfaces.entries()) {
        // Selecting below the captured glyph rows requests a real redraw without changing bytes.
        const bounds = await surface.locator('.xterm-screen').boundingBox();
        if (!bounds) throw new Error('Expected a visible sibling WebGL screen');
        await page.mouse.move(bounds.x + 4, bounds.y + 80);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 120, bounds.y + 82, { steps: 3 });
        await page.mouse.up();
        const after = await glyphPixels(index);
        await test.info().attach(`sibling-${index}-after-repair`, {
          body: after,
          contentType: 'image/png',
        });
        await expect
          .poll(async () => (await glyphPixels(index)).equals(baselines[index]))
          .toBe(true);
        expect(await initialInputs[index]?.evaluate((element) => element.isConnected)).toBe(true);
        expect(
          await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, {
            agentId: sessionIds[index],
          }),
        ).toBe(scrollbacks[index]);
      }
      const after = await getRendererDiagnostics(page);
      expect(after?.terminalRenderer.activeContextsCurrent).toBe(2);
      expect(after?.terminalRenderer.webglEvictions).toBe(before?.terminalRenderer.webglEvictions);
      expect(after?.terminalRenderer.fallbackActivations).toBe(
        before?.terminalRenderer.fallbackActivations,
      );
    } finally {
      await context.close();
    }
  });
});
