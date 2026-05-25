import { IPC } from '../../electron/ipc/channels.js';

import { expect, test } from './harness/fixtures.js';
import {
  dragTerminalPanelResizeHandle,
  getOutputDiagnostics,
  getTerminalOutputEntry,
  openDiagnosticSession,
} from './harness/terminal-render.js';
import { createPromptReadyScenario } from './harness/scenarios.js';

async function waitForNewRunningAgentId(
  browserLab: {
    invokeIpc: <TResult>(
      request: import('@playwright/test').APIRequestContext,
      channel: IPC,
      body?: unknown,
    ) => Promise<TResult>;
  },
  request: import('@playwright/test').APIRequestContext,
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

async function scrollTerminalViewportToFraction(
  page: import('@playwright/test').Page,
  terminalIndex: number,
  fraction: number,
): Promise<void> {
  await page.evaluate(
    ({ fraction: nextFraction, index }) => {
      const terminal = document.querySelectorAll('[data-terminal-status]')[index] as
        | HTMLElement
        | undefined;
      const scrollContainer =
        terminal?.querySelector('.xterm-scrollable-element, .xterm-viewport') ?? null;
      if (!(scrollContainer instanceof HTMLElement)) {
        throw new Error('Terminal scroll container not found');
      }

      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      const targetScrollTop = Math.max(1, Math.floor(maxScrollTop * nextFraction));
      scrollContainer.scrollTop = targetScrollTop;
    },
    { fraction, index: terminalIndex },
  );
}

async function beginViewportYHistory(
  page: import('@playwright/test').Page,
  terminalIndex: number,
): Promise<void> {
  await page.evaluate((index) => {
    const windowWithHistory = window as typeof window & {
      __parallelCodeViewportYHistory__?: Record<number, number[]>;
      __parallelCodeViewportYHistoryIntervals__?: Record<number, number>;
      __parallelCodeTerminalOutputDiagnostics?: {
        getSnapshot: () => {
          terminals?: Array<{
            agentId: string | null;
            render?: {
              currentViewportY?: number | null;
            };
          }>;
        } | null;
      };
    };
    const statusElement = document.querySelectorAll('[data-terminal-status]')[index] as
      | HTMLElement
      | undefined;
    const agentId = statusElement?.getAttribute('data-terminal-agent-id');
    if (!agentId) {
      throw new Error('Terminal agent id not found');
    }

    windowWithHistory.__parallelCodeViewportYHistory__ ??= {};
    windowWithHistory.__parallelCodeViewportYHistoryIntervals__ ??= {};

    const existingInterval = windowWithHistory.__parallelCodeViewportYHistoryIntervals__[index];
    if (existingInterval !== undefined) {
      window.clearInterval(existingInterval);
    }

    function readCurrentViewportY(): number {
      const snapshot = windowWithHistory.__parallelCodeTerminalOutputDiagnostics?.getSnapshot();
      const terminal = snapshot?.terminals?.find((entry) => entry.agentId === agentId);
      return terminal?.render?.currentViewportY ?? -1;
    }

    windowWithHistory.__parallelCodeViewportYHistory__[index] = [readCurrentViewportY()];
    windowWithHistory.__parallelCodeViewportYHistoryIntervals__[index] = window.setInterval(() => {
      windowWithHistory.__parallelCodeViewportYHistory__?.[index]?.push(readCurrentViewportY());
    }, 40);
  }, terminalIndex);
}

async function readViewportYHistory(
  page: import('@playwright/test').Page,
  terminalIndex: number,
): Promise<number[]> {
  return page.evaluate((index) => {
    const windowWithHistory = window as typeof window & {
      __parallelCodeViewportYHistory__?: Record<number, number[]>;
      __parallelCodeViewportYHistoryIntervals__?: Record<number, number>;
    };
    const intervalHandle = windowWithHistory.__parallelCodeViewportYHistoryIntervals__?.[index];
    if (intervalHandle !== undefined) {
      window.clearInterval(intervalHandle);
      delete windowWithHistory.__parallelCodeViewportYHistoryIntervals__?.[index];
    }

    return [...(windowWithHistory.__parallelCodeViewportYHistory__?.[index] ?? [])];
  }, terminalIndex);
}

test.describe('browser-lab terminal scroll preservation under fit churn', () => {
  test.use({
    scenario: createPromptReadyScenario(),
  });

  test('keeps a scrolled-back shell viewport away from the top while output and resize churn overlap', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(180_000);

    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Shell Scroll Preservation Tester',
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

      await browserLab.waitForTerminalReady(page, shellTerminalIndex);
      await browserLab.focusTerminal(page, shellTerminalIndex);
      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        shellAgentId,
        'write scroll preservation stress output',
      );

      const seedCommand =
        'i=0; while [ "$i" -lt 1600 ]; do printf "SCROLL_SEED_%04d seeded-scrollback-line-seeded-scrollback-line-seeded-scrollback-line\\n" "$i"; i=$((i+1)); done; printf "__SCROLL_SEED_DONE__\\n"';
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `${seedCommand}\r`,
      });
      await browserLab.waitForAgentScrollback(
        request,
        shellAgentId,
        '__SCROLL_SEED_DONE__',
        20_000,
      );

      await scrollTerminalViewportToFraction(page, shellTerminalIndex, 0.35);
      await page.waitForTimeout(200);

      const outputDiagnosticsBefore = await getOutputDiagnostics(page);
      const terminalBefore = getTerminalOutputEntry(outputDiagnosticsBefore, shellAgentId);
      expect(terminalBefore?.render.currentViewportY ?? 0).toBeGreaterThan(0);

      await beginViewportYHistory(page, shellTerminalIndex);

      const noisyCommand =
        'i=0; while [ "$i" -lt 900 ]; do printf "SCROLL_NOISY_%04d noisy-scroll-line-noisy-scroll-line-noisy-scroll-line\\n" "$i"; i=$((i+1)); sleep 0.004; done; printf "__SCROLL_NOISY_DONE__\\n"';
      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        shellAgentId,
        'write scroll preservation stress output',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `${noisyCommand}\r`,
      });
      await browserLab.waitForAgentScrollback(request, shellAgentId, 'SCROLL_NOISY_0005', 10_000);

      const resizeDeltas = [140, -110, 120, -90, 100, -80];
      for (const resizeDelta of resizeDeltas) {
        await dragTerminalPanelResizeHandle(page, shellTerminalIndex, resizeDelta);
        await page.waitForTimeout(90);
      }

      await browserLab.waitForAgentScrollback(
        request,
        shellAgentId,
        '__SCROLL_NOISY_DONE__',
        30_000,
      );
      await page.waitForTimeout(250);

      const viewportYHistory = await readViewportYHistory(page, shellTerminalIndex);
      const outputDiagnosticsAfter = await getOutputDiagnostics(page);
      const terminalAfter = getTerminalOutputEntry(outputDiagnosticsAfter, shellAgentId);

      const validViewportYSamples = viewportYHistory.filter((value) => value >= 0);

      expect(validViewportYSamples.length).toBeGreaterThan(3);
      expect(Math.min(...validViewportYSamples)).toBeGreaterThan(0);
      expect(terminalAfter?.render.currentViewportY ?? 0).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
