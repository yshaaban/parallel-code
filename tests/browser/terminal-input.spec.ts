import { IPC } from '../../electron/ipc/channels.js';
import { stripAnsi } from '../../src/lib/prompt-detection.js';

import { expect, getTerminalLoadingOverlay, test } from './harness/fixtures.js';
import { getRendererDiagnostics } from './harness/terminal-render.js';
import { getBrowserPrimaryFindChord } from './harness/browser-platform.js';
import {
  getCompletedTerminalInputTraceChars,
  measureHeldKeyTrace,
  measureSingleKeyTrace,
  measureTypedTextTrace,
  warmTerminalInputTracing,
} from './harness/terminal-input-tracing.js';
import type {
  TerminalInputTraceDiagnosticsSnapshot,
  TerminalInputTraceSample,
} from '../../src/domain/terminal-input-tracing.js';
import {
  createInteractiveNodeScenario,
  createPromptReadyScenario,
  createTerminalInputEchoScenario,
} from './harness/scenarios.js';

const RAW_BROWSER_RAPID_RENDER_P50_MAX_MS = 5;
const RAW_BROWSER_RAPID_RENDER_MAX_MS = 48;
const RAW_BROWSER_RAPID_CLIENT_SEND_MAX_MS = 32;
const RAW_BROWSER_RAPID_MAX_TRACE_INPUT_CHARS = 4;
const RAW_BROWSER_SINGLE_SEND_TO_ECHO_P95_MAX_MS = 32;
const RAW_BROWSER_SINGLE_END_TO_END_P95_MAX_MS = 36;
const RAW_BROWSER_SINGLE_RENDER_P95_MAX_MS = 4;
const RAW_BROWSER_SUSTAINED_SEND_TO_ECHO_P95_MAX_MS = 72;
const RAW_BROWSER_SUSTAINED_END_TO_END_P95_MAX_MS = 80;
const SHELL_SUSTAINED_SEND_TO_ECHO_P95_MAX_MS = 64;
const SHELL_SUSTAINED_END_TO_END_P95_MAX_MS = 64;

async function waitForRendererInputQueueToSettle(
  page: import('@playwright/test').Page,
): Promise<void> {
  await expect
    .poll(async () => {
      const rendererDiagnostics = await getRendererDiagnostics(page);
      return {
        inFlight: rendererDiagnostics?.terminalInput.inFlightBatchesCurrent ?? 0,
        queued: rendererDiagnostics?.terminalInput.queuedChunksCurrent ?? 0,
      };
    })
    .toEqual({ inFlight: 0, queued: 0 });
}

async function resetRendererInputDiagnostics(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    window.__parallelCodeRendererRuntimeDiagnostics?.reset();
  });
}

async function waitForWrappedShellEcho(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  agentId: string,
  text: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const scrollback = await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, {
          agentId,
        });
        if (scrollback.length === 0) {
          return '';
        }

        const decodedScrollback = Buffer.from(scrollback, 'base64').toString('utf8');
        return stripAnsi(decodedScrollback).replace(/\s/g, '');
      },
      { timeout: 5_000 },
    )
    .toContain(text);
}

function getLatestCompletedTraceStageMs(
  snapshot: TerminalInputTraceDiagnosticsSnapshot,
  readStage: (trace: TerminalInputTraceSample) => number | null,
): number {
  let latestStageMs: number | null = null;

  for (const trace of snapshot.completedTraces) {
    if (!trace.completed) {
      continue;
    }

    const stageMs = readStage(trace);
    if (stageMs === null) {
      continue;
    }

    latestStageMs = latestStageMs === null ? stageMs : Math.max(latestStageMs, stageMs);
  }

  if (latestStageMs === null) {
    throw new Error('Expected at least one completed terminal input trace with a stage timestamp');
  }

  return latestStageMs;
}

function getBurstCatchupAfterFinalInputMs(snapshot: TerminalInputTraceDiagnosticsSnapshot): number {
  const latestInputStartedAtMs = getLatestCompletedTraceStageMs(
    snapshot,
    (trace) => trace.stages.startedAtMs,
  );
  const latestOutputRenderedAtMs = getLatestCompletedTraceStageMs(
    snapshot,
    (trace) => trace.stages.outputRenderedAtMs,
  );

  return latestOutputRenderedAtMs - latestInputStartedAtMs;
}

async function waitForNewRunningAgentId(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  initialRunningAgentIds: readonly string[],
): Promise<string> {
  await expect
    .poll(
      async () => {
        const runningAgentIds = await browserLab.invokeIpc<string[]>(
          request,
          IPC.ListRunningAgentIds,
        );
        return runningAgentIds.find((agentId) => !initialRunningAgentIds.includes(agentId)) ?? null;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();

  const runningAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
  const agentId =
    runningAgentIds.find((currentAgentId) => !initialRunningAgentIds.includes(currentAgentId)) ??
    null;

  expect(agentId).toBeTruthy();
  return agentId ?? '';
}

test.describe('browser-lab terminal maximize', () => {
  test.use({ deviceScaleFactor: 2, scenario: createInteractiveNodeScenario() });

  test('commits fullscreen auxiliary geometry after first input acquires previously unowned control', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Unowned Auxiliary Geometry Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });
    await browserLab.waitForTerminalReady(page);
    await page.getByTitle(/^Open terminal /u).click();
    const surface = page.locator(
      `[data-terminal-agent-id]:not([data-terminal-agent-id="${browserLab.server.agentId}"])`,
    );
    await expect(surface).toHaveAttribute('data-terminal-status', 'ready');
    const shellId = await surface.getAttribute('data-terminal-agent-id');
    if (!shellId) throw new Error('Expected exact auxiliary shell identity');
    await page.getByPlaceholder('Notes...').focus();
    await expect
      .poll(async () => {
        const state = await browserLab.invokeIpc(request, IPC.GetTaskCommandControllers);
        return state.controllers.some(
          (controller) => controller.taskId === browserLab.server.taskId,
        );
      })
      .toBe(false);
    await resetRendererInputDiagnostics(page);
    await surface.getByRole('button', { name: 'Maximize terminal' }).click();
    await expect(surface).toHaveAttribute('data-terminal-maximized', 'true');
    await expect
      .poll(
        async () =>
          (await getRendererDiagnostics(page))?.terminalResize.commitDeferredCounts['not-live'] ??
          0,
      )
      .toBeGreaterThan(0);
    const beforeInput = await browserLab.invokeIpc(request, IPC.GetTaskCommandControllers);
    expect(
      beforeInput.controllers.some((controller) => controller.taskId === browserLab.server.taskId),
    ).toBe(false);

    // Fullscreen itself cannot acquire control; first real input may commit retained geometry.
    await page.keyboard.insertText("printf '\\n__UNOWNED_AUX_GRID__ '; stty size");
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        surface.evaluate((element) => {
          const live = element.querySelector('[data-terminal-live-surface]');
          const screen = element.querySelector('.xterm-screen');
          if (!live || !screen) return false;
          return screen.getBoundingClientRect().height >= live.getBoundingClientRect().height - 24;
        }),
      )
      .toBe(true);
    const rowHeight = await surface
      .getByRole('textbox', { name: 'Terminal input' })
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
    const screenHeight = await surface
      .locator('.xterm-screen')
      .evaluate((element) => element.getBoundingClientRect().height);
    await expect
      .poll(async () => {
        const encoded = await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, {
          agentId: shellId,
        });
        const text = stripAnsi(Buffer.from(encoded, 'base64').toString('utf8'));
        const rows = text.match(/__UNOWNED_AUX_GRID__ (\d+) (\d+)/u)?.[1];
        return rows ? Number(rows) * rowHeight : 0;
      })
      .toBeCloseTo(screenHeight, 0);
  });

  test('keeps auxiliary shell grids and PTY rows aligned through focus switches and fullscreen', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Auxiliary Shell Geometry Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
    await browserLab.waitForTerminalReady(page);
    const auxiliary = page.locator(
      `[data-terminal-agent-id]:not([data-terminal-agent-id="${browserLab.server.agentId}"])`,
    );
    for (let count = 1; count <= 2; count++) {
      await page.getByTitle(/^Open terminal /u).click();
      await expect(auxiliary).toHaveCount(count);
      await expect(auxiliary.nth(count - 1)).toHaveAttribute('data-terminal-status', 'ready');
    }
    const shellIds = await auxiliary.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-terminal-agent-id')),
    );
    for (const [index, shellId] of shellIds.entries()) {
      if (!shellId) throw new Error('Expected exact auxiliary shell identity');
      const surface = page.locator(`[data-terminal-agent-id="${shellId}"]`);
      await surface.getByRole('textbox', { name: 'Terminal input' }).focus();
      await page.keyboard.insertText(
        `for i in {1..120}; do printf '__AUX_${index}_ROW_%03d__\\n' "$i"; done`,
      );
      await page.keyboard.press('Enter');
      await browserLab.waitForAgentScrollback(request, shellId, `__AUX_${index}_ROW_120__`);
    }
    const primary = page.locator(`[data-terminal-agent-id="${browserLab.server.agentId}"]`);
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const shellId of shellIds) {
        if (!shellId) throw new Error('Expected exact auxiliary shell identity');
        const surface = page.locator(`[data-terminal-agent-id="${shellId}"]`);
        await surface.getByRole('textbox', { name: 'Terminal input' }).focus();
        await expect(surface.locator('.xterm')).toHaveCSS('opacity', '1');
        await expect(surface.locator('.xterm')).toHaveCSS('transition-duration', '0s');
        await primary.getByRole('textbox', { name: 'Terminal input' }).focus();
        await expect(surface.locator('.xterm')).toHaveCSS('opacity', '1');
        await expect(surface.locator('.xterm')).toHaveCSS('transition-duration', '0s');
      }
    }
    await test.info().attach('auxiliary-after-focus-away', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    // Real selection paints without changing output or terminal ownership.
    const selectionScreen = auxiliary.first().locator('.xterm-screen');
    const selectionBounds = await selectionScreen.boundingBox();
    if (!selectionBounds) throw new Error('Expected visible auxiliary terminal screen');
    const beforeSelection = await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, {
      agentId: shellIds[0],
    });
    await page.mouse.move(selectionBounds.x + 4, selectionBounds.y + 8);
    await page.mouse.down();
    await page.mouse.move(selectionBounds.x + 240, selectionBounds.y + 24, { steps: 5 });
    await page.mouse.up();
    await test.info().attach('auxiliary-after-selection', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(
      await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, { agentId: shellIds[0] }),
    ).toBe(beforeSelection);
    for (const [index, shellId] of shellIds.entries()) {
      if (!shellId) throw new Error('Expected exact auxiliary shell identity');
      const surface = page.locator(`[data-terminal-agent-id="${shellId}"]`);
      await surface.getByRole('button', { name: 'Maximize terminal' }).click();
      await expect(surface).toHaveAttribute('data-terminal-maximized', 'true');
      await expect
        .poll(() =>
          surface.evaluate((element) => {
            const live = element.querySelector('[data-terminal-live-surface]');
            const screen = element.querySelector('.xterm-screen');
            if (!live || !screen) return false;
            const available = live.getBoundingClientRect().height;
            const rendered = screen.getBoundingClientRect().height;
            return rendered <= available + 1 && rendered >= available - 24;
          }),
        )
        .toBe(true);
      await page.keyboard.insertText(`printf '\\n__AUX_GRID_${index}__ '; stty size`);
      await page.keyboard.press('Enter');
      const rowHeight = await surface
        .getByRole('textbox', { name: 'Terminal input' })
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
      const screenHeight = await surface
        .locator('.xterm-screen')
        .evaluate((element) => element.getBoundingClientRect().height);
      const paintGeometry = await surface.evaluate((element) => {
        const screen = element.querySelector('.xterm-screen');
        const input = element.querySelector('.xterm-helper-textarea');
        if (!screen || !input) return null;
        const screenRect = screen.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        return {
          devicePixelRatio,
          platform: navigator.platform,
          screen: { width: screenRect.width, height: screenRect.height },
          cursorInBounds:
            inputRect.x >= screenRect.x &&
            inputRect.y >= screenRect.y &&
            inputRect.x < screenRect.right &&
            inputRect.y < screenRect.bottom,
          canvases: Array.from(screen.querySelectorAll('canvas')).map((canvas) => ({
            width: canvas.width,
            height: canvas.height,
            cssWidth: canvas.getBoundingClientRect().width,
            cssHeight: canvas.getBoundingClientRect().height,
          })),
        };
      });
      expect(paintGeometry?.devicePixelRatio).toBe(2);
      expect(paintGeometry?.cursorInBounds).toBe(true);
      if (paintGeometry?.canvases.length === 0) {
        await expect(surface.locator('.xterm-rows')).toBeVisible();
        const diagnostics = await getRendererDiagnostics(page);
        expect(diagnostics?.terminalRenderer.acquireMisses ?? 0).toBeGreaterThan(0);
        test.info().annotations.push({
          type: 'environment-limitation',
          description:
            'Chromium used the DOM renderer for this auxiliary terminal; GPU focus corruption was not reproduced.',
        });
      }
      for (const canvas of paintGeometry?.canvases ?? []) {
        expect(canvas.width).toBeCloseTo(canvas.cssWidth * 2, 0);
        expect(canvas.height).toBeCloseTo(canvas.cssHeight * 2, 0);
      }
      await test.info().attach(`auxiliary-${index}-paint-geometry`, {
        body: JSON.stringify(paintGeometry),
        contentType: 'application/json',
      });
      await expect
        .poll(async () => {
          const encoded = await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, {
            agentId: shellId,
          });
          const text = stripAnsi(Buffer.from(encoded, 'base64').toString('utf8'));
          const rows = text.match(new RegExp(`__AUX_GRID_${index}__ (\\d+) (\\d+)`))?.[1];
          return rows ? Number(rows) * rowHeight : 0;
        })
        .toBeCloseTo(screenHeight, 0);
      await test.info().attach(`auxiliary-${index}-fullscreen`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await surface.getByRole('button', { name: 'Restore terminal' }).click();
      await expect(surface).not.toHaveAttribute('data-terminal-maximized', 'true');
      await primary.getByRole('textbox', { name: 'Terminal input' }).focus();
    }
  });

  test('temporarily maximizes agent and scratch terminals without replacing or writing to sessions', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Terminal Maximize Tester',
    });
    await browserLab.waitForTerminalReady(page);
    const scratchIndex = await browserLab.createShellTerminal(page);
    const sessionMutations: string[] = [];
    page.on('request', (entry) => {
      if (
        [
          IPC.WriteToAgent,
          IPC.SpawnAgent,
          IPC.KillAgent,
          IPC.AttachAgent,
          IPC.AcquireTaskCommandLease,
        ].some((channel) => entry.url().includes(channel))
      ) {
        sessionMutations.push(entry.url());
      }
    });

    for (const terminalIndex of [0, scratchIndex]) {
      await browserLab.focusTerminal(page, terminalIndex);
      await browserLab.waitForTerminalInteractiveReady(page, terminalIndex);
      const surface = page.locator('[data-terminal-agent-id]').nth(terminalIndex);
      const agentId = await surface.getAttribute('data-terminal-agent-id');
      if (!agentId) throw new Error('Expected the terminal to retain an exact agent identity');
      const originalSurface = await surface.elementHandle();
      const originalInput = await surface
        .getByRole('textbox', { name: 'Terminal input' })
        .elementHandle();
      if (!originalSurface || !originalInput) throw new Error('Expected mounted terminal input');
      const marker = `__MAXIMIZE_${terminalIndex}_DONE__`;
      const command = terminalIndex === 0 ? `console.log('${marker}')` : `printf '${marker}\\n'`;
      await page.keyboard.insertText(command);
      await waitForRendererInputQueueToSettle(page);
      sessionMutations.length = 0;

      // Keyboard activation must operate the control, not send Enter to the PTY draft.
      await surface.getByRole('button', { name: 'Maximize terminal' }).press('Enter');
      await expect(surface).toHaveAttribute('data-terminal-maximized', 'true');
      await browserLab.waitForTerminalInteractiveReady(page, terminalIndex);
      await expect
        .poll(() =>
          surface.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.x === 0 &&
              rect.y === 0 &&
              Math.abs(rect.width - innerWidth) <= 1 &&
              Math.abs(rect.height - innerHeight) <= 1
            );
          }),
        )
        .toBe(true);
      // The usable xterm grid must resize too, not just the outer background.
      await expect
        .poll(() =>
          surface.evaluate((element) => {
            const live = element.querySelector('[data-terminal-live-surface]');
            const screen = element.querySelector('.xterm-screen');
            if (!live || !screen) return false;
            const available = live.getBoundingClientRect().height;
            const rendered = screen.getBoundingClientRect().height;
            return rendered <= available + 1 && rendered >= available - 24;
          }),
        )
        .toBe(true);
      if (terminalIndex === 0) {
        await test.info().attach('terminal-maximized', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      }

      await page.keyboard.press(await getBrowserPrimaryFindChord(page));
      await expect(surface.getByRole('search')).toBeVisible();
      await surface.getByLabel('Find in terminal').press('Escape');
      await expect(surface.getByRole('search')).toHaveCount(0);
      await expect(surface).toHaveAttribute('data-terminal-maximized', 'true');
      await page.keyboard.press('F1');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(surface).toHaveAttribute('data-terminal-maximized', 'true');
      await page.keyboard.press('Escape');
      await expect(surface).not.toHaveAttribute('data-terminal-maximized', 'true');
      await browserLab.waitForTerminalInteractiveReady(page, terminalIndex);
      await expect(surface.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
      expect(await originalSurface.evaluate((element) => element.isConnected)).toBe(true);
      expect(await originalInput.evaluate((element) => element === document.activeElement)).toBe(
        true,
      );
      expect(sessionMutations).toEqual([]);
      if (terminalIndex === 0) {
        await test.info().attach('terminal-restored', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      }

      await page.keyboard.press('Enter');
      await browserLab.waitForAgentScrollback(request, agentId, `${marker}\r\n`);
      await surface.getByRole('button', { name: 'Maximize terminal' }).click();
      await surface.getByRole('button', { name: 'Restore terminal' }).click();
      await expect(surface).not.toHaveAttribute('data-terminal-maximized', 'true');
      expect(await originalSurface.evaluate((element) => element.isConnected)).toBe(true);
    }
    await page.reload();
    await browserLab.waitForTerminalReady(page);
    await expect(page.locator('[data-terminal-maximized]')).toHaveCount(0);
  });
});

test.describe('browser-lab terminal input latency', () => {
  test.use({
    scenario: createTerminalInputEchoScenario(),
  });

  test('keeps single-key echo nearly instantaneous on the raw browser terminal path', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Input Latency Tester',
    });

    await browserLab.waitForTerminalReady(page);
    await warmTerminalInputTracing(browserLab, page, request);
    await resetRendererInputDiagnostics(page);

    const snapshot = await measureSingleKeyTrace(browserLab, page, request, 'x', {
      focusTerminal: false,
    });

    expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(
      RAW_BROWSER_SINGLE_SEND_TO_ECHO_P95_MAX_MS,
    );
    expect(snapshot.summary.endToEndMs.p95).toBeLessThan(RAW_BROWSER_SINGLE_END_TO_END_P95_MAX_MS);
    expect(snapshot.summary.renderMs.p95).toBeLessThan(RAW_BROWSER_SINGLE_RENDER_P95_MAX_MS);
  });

  test('keeps rapid raw-browser typing visibly responsive', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Rapid Input Latency Tester',
    });

    await browserLab.waitForTerminalReady(page);
    await warmTerminalInputTracing(browserLab, page, request);
    await resetRendererInputDiagnostics(page);

    const typedText = 'latencyprobe';
    const snapshot = await measureTypedTextTrace(browserLab, page, request, typedText, {
      focusTerminal: false,
      minimumChars: typedText.length,
      minimumCount: Math.ceil(typedText.length / RAW_BROWSER_RAPID_MAX_TRACE_INPUT_CHARS),
    });
    const burstCatchupMs = getBurstCatchupAfterFinalInputMs(snapshot);
    const completedInputChars = getCompletedTerminalInputTraceChars(snapshot);
    const maxTraceInputChars = Math.max(
      ...snapshot.completedTraces
        .filter((trace) => trace.completed)
        .map((trace) => trace.inputChars),
    );

    expect(snapshot.summary.count).toBeGreaterThanOrEqual(
      Math.ceil(typedText.length / RAW_BROWSER_RAPID_MAX_TRACE_INPUT_CHARS),
    );
    expect(completedInputChars).toBeGreaterThanOrEqual(typedText.length);
    expect(maxTraceInputChars).toBeLessThanOrEqual(RAW_BROWSER_RAPID_MAX_TRACE_INPUT_CHARS);
    expect(snapshot.droppedTraces).toBe(0);
    expect(snapshot.summary.clientBufferMs.max).toBeLessThan(1);
    expect(snapshot.summary.clientSendMs.max).toBeLessThan(RAW_BROWSER_RAPID_CLIENT_SEND_MAX_MS);
    expect(snapshot.summary.renderMs.p50).toBeLessThan(RAW_BROWSER_RAPID_RENDER_P50_MAX_MS);
    expect(snapshot.summary.renderMs.max).toBeLessThan(RAW_BROWSER_RAPID_RENDER_MAX_MS);
    expect(burstCatchupMs).toBeLessThan(40);
  });

  test('keeps sustained raw-browser key hold responsive without building a large client backlog', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Held Key Input Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });

    await browserLab.waitForTerminalReady(page);
    await warmTerminalInputTracing(browserLab, page, request);
    await resetRendererInputDiagnostics(page);

    const snapshot = await measureHeldKeyTrace(browserLab, page, request, 'a', 24, {
      delayMs: 16,
      focusTerminal: false,
      minimumCount: 8,
    });
    await waitForRendererInputQueueToSettle(page);
    const rendererDiagnostics = await getRendererDiagnostics(page);

    expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.count).toBeGreaterThanOrEqual(8);
    expect(snapshot.summary.clientBufferMs.p95).toBeLessThan(1);
    expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(
      RAW_BROWSER_SUSTAINED_SEND_TO_ECHO_P95_MAX_MS,
    );
    expect(snapshot.summary.endToEndMs.p95).toBeLessThan(
      RAW_BROWSER_SUSTAINED_END_TO_END_P95_MAX_MS,
    );
    expect(
      rendererDiagnostics?.terminalInput.inFlightBatchesCurrent ?? Number.POSITIVE_INFINITY,
    ).toBe(0);
    expect(rendererDiagnostics?.terminalInput.queuedChunksCurrent ?? Number.POSITIVE_INFINITY).toBe(
      0,
    );
    expect(
      rendererDiagnostics?.terminalInput.sentBatchCharsMax ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(4);
  });
});

test.describe('browser-lab terminal input', () => {
  test.use({
    scenario: createTerminalInputEchoScenario(),
  });

  test('keeps burst typing intact through the real browser terminal input path', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Input Tester',
    });

    await browserLab.waitForTerminalReady(page);

    const marker = `browser-input-burst-${'xyz123'.repeat(12)}`;
    await browserLab.focusTerminal(page);
    await browserLab.waitForTerminalInteractiveReady(page);
    const terminalInput = page.getByRole('textbox', { name: 'Terminal input' });
    await page.keyboard.insertText(marker);
    await terminalInput.press('Enter');

    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker);

    const followUpMarker = 'browser-input-follow-up-marker';
    await browserLab.focusTerminal(page);
    await browserLab.waitForTerminalInteractiveReady(page);
    await page.keyboard.insertText(followUpMarker);
    await terminalInput.press('Enter');
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, followUpMarker);

    await expect(getTerminalLoadingOverlay(page)).toHaveCount(0);
    await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
  });
});

test.describe('browser-lab shell repeat input', () => {
  test.use({
    scenario: createPromptReadyScenario(),
  });

  test('keeps single-key shell echo within one frame after focus', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Single Key Shell Tester',
    });

    await browserLab.waitForTerminalReady(page);
    const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
      request,
      IPC.ListRunningAgentIds,
    );
    const shellTerminalIndex = await browserLab.createShellTerminal(page);
    await waitForNewRunningAgentId(browserLab, request, initialRunningAgentIds);
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
    await warmTerminalInputTracing(browserLab, page, request, shellTerminalIndex, {
      clearLineAfterWarm: true,
    });
    await resetRendererInputDiagnostics(page);

    const snapshot = await measureSingleKeyTrace(browserLab, page, request, 'x', {
      focusTerminal: false,
      terminalIndex: shellTerminalIndex,
    });

    expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(24);
    expect(snapshot.summary.endToEndMs.p95).toBeLessThan(28);
  });

  test('keeps repeated same-key shell input responsive', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Repeat Input Tester',
    });

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
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
    await warmTerminalInputTracing(browserLab, page, request, shellTerminalIndex, {
      clearLineAfterWarm: true,
    });
    const repeatText = 'q'.repeat(80);

    await browserLab.focusTerminal(page, shellTerminalIndex);
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
    await page.keyboard.type(repeatText);
    await waitForWrappedShellEcho(browserLab, request, shellAgentId, repeatText);
    await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
  });

  test('keeps sustained shell key hold responsive and low-backlog before enter', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Held Key Shell Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });

    await browserLab.waitForTerminalReady(page);
    const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
      request,
      IPC.ListRunningAgentIds,
    );
    const shellTerminalIndex = await browserLab.createShellTerminal(page);
    await waitForNewRunningAgentId(browserLab, request, initialRunningAgentIds);
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
    await warmTerminalInputTracing(browserLab, page, request, shellTerminalIndex, {
      clearLineAfterWarm: true,
    });
    await resetRendererInputDiagnostics(page);

    const snapshot = await measureHeldKeyTrace(browserLab, page, request, 'a', 24, {
      delayMs: 16,
      focusTerminal: false,
      minimumCount: 8,
      terminalIndex: shellTerminalIndex,
    });
    await waitForRendererInputQueueToSettle(page);
    const rendererDiagnostics = await getRendererDiagnostics(page);

    expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.count).toBeGreaterThanOrEqual(8);
    expect(snapshot.summary.clientBufferMs.p95).toBeLessThan(1);
    expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(SHELL_SUSTAINED_SEND_TO_ECHO_P95_MAX_MS);
    expect(snapshot.summary.endToEndMs.p95).toBeLessThan(SHELL_SUSTAINED_END_TO_END_P95_MAX_MS);
    expect(
      rendererDiagnostics?.terminalInput.inFlightBatchesCurrent ?? Number.POSITIVE_INFINITY,
    ).toBe(0);
    expect(rendererDiagnostics?.terminalInput.queuedChunksCurrent ?? Number.POSITIVE_INFINITY).toBe(
      0,
    );
    expect(
      rendererDiagnostics?.terminalInput.sentBatchCharsMax ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(4);
    await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
  });
});
