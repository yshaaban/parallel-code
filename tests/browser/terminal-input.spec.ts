import { IPC } from '../../electron/ipc/channels.js';
import { stripAnsi } from '../../src/lib/prompt-detection.js';

import { expect, getTerminalLoadingOverlay, test } from './harness/fixtures.js';
import { getRendererDiagnostics } from './harness/terminal-render.js';
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
import { createPromptReadyScenario, createTerminalInputEchoScenario } from './harness/scenarios.js';

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
