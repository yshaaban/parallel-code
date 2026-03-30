import { IPC } from '../../electron/ipc/channels.js';

import { expect, getTerminalLoadingOverlay, test } from './harness/fixtures.js';
import { getRendererDiagnostics } from './harness/terminal-render.js';
import {
  measureHeldKeyTrace,
  measureSingleKeyTrace,
  measureTypedTextTrace,
  warmTerminalInputTracing,
} from './harness/terminal-input-tracing.js';
import {
  createInteractiveNodeScenario,
  createPromptReadyScenario,
  createTerminalInputEchoScenario,
} from './harness/scenarios.js';

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
    expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(20);
    expect(snapshot.summary.endToEndMs.p95).toBeLessThan(22);
    expect(snapshot.summary.renderMs.p95).toBeLessThan(2);
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

    const snapshot = await measureTypedTextTrace(browserLab, page, request, 'latencyprobe', {
      focusTerminal: false,
      minimumCount: 2,
    });
    expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
    expect(snapshot.droppedTraces).toBe(0);
    expect(snapshot.summary.endToEndMs.max).toBeLessThan(40);
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
    expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(24);
    expect(snapshot.summary.endToEndMs.p95).toBeLessThan(28);
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
    scenario: createInteractiveNodeScenario(),
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

    const marker = `BROWSER_INPUT_BURST_${'XYZ123'.repeat(12)}`;
    await browserLab.typeInTerminal(page, `console.log("${marker}")`);
    await page.keyboard.press('Enter');

    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker);

    const followUpMarker = 'BROWSER_INPUT_FOLLOW_UP_MARKER';
    await browserLab.typeInTerminal(page, `console.log("${followUpMarker}")`);
    await page.keyboard.press('Enter');
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
    const shellAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
    );
    await browserLab.waitForShellPromptReady(request, shellAgentId);
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
    await browserLab.waitForShellPromptReady(request, shellAgentId);
    const repeatText = 'a'.repeat(80);

    await browserLab.runInTerminal(page, repeatText, {
      terminalIndex: shellTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, shellAgentId, repeatText, 5_000);
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
    const shellAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
    );
    await browserLab.waitForShellPromptReady(request, shellAgentId);
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
    expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(24);
    expect(snapshot.summary.endToEndMs.p95).toBeLessThan(24);
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
