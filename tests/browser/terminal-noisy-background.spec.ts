import { IPC } from '../../electron/ipc/channels.js';

import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';

interface RuntimeDiagnosticsSnapshot {
  terminalInputTracing: {
    completedTraces: Array<{
      completed: boolean;
      failureReason: string | null;
      stages: {
        outputRenderedAtMs: number | null;
        startedAtMs: number | null;
      };
    }>;
    summary: {
      count: number;
      endToEndMs: {
        p95: number;
      };
    };
  };
}

const NOISY_OUTPUT_COMMAND =
  'i=0; while [ "$i" -lt 180 ]; do printf "\\rNOISE_%04d" "$i"; i=$((i+1)); sleep 0.02; done; printf "\\nNOISE_DONE\\n"';

function getCompletedTraceDurationMs(trace: {
  stages: {
    outputRenderedAtMs: number | null;
    startedAtMs: number | null;
  };
}): number | null {
  const { outputRenderedAtMs, startedAtMs } = trace.stages;
  if (outputRenderedAtMs === null || startedAtMs === null) {
    return null;
  }

  return outputRenderedAtMs - startedAtMs;
}

async function waitForNewRunningAgentId(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  initialRunningAgentIds: readonly string[],
  excludedAgentId?: string | null,
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
              !initialRunningAgentIds.includes(agentId) && agentId !== (excludedAgentId ?? null),
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
        currentAgentId !== (excludedAgentId ?? null),
    ) ?? null;

  expect(agentId).toBeTruthy();
  return agentId ?? '';
}

test.describe('browser-lab noisy background terminals', () => {
  test.use({
    scenario: createPromptReadyScenario(),
  });

  test('keeps focused typing responsive while a background terminal redraws', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Noise Tester',
    });

    await browserLab.waitForTerminalReady(page);
    const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
      request,
      IPC.ListRunningAgentIds,
    );
    const focusedTerminalIndex = await browserLab.createShellTerminal(page);
    const focusedShellAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
    );
    await browserLab.beginTerminalStatusHistory(page, focusedTerminalIndex);
    const backgroundTerminalIndex = await browserLab.createShellTerminal(page);
    const backgroundAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
      focusedShellAgentId,
    );

    await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
      terminalIndex: backgroundTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, backgroundAgentId, 'NOISE_');

    const repeatText = 'a'.repeat(80);
    await browserLab.runInTerminal(page, repeatText, {
      terminalIndex: focusedTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, focusedShellAgentId, repeatText, 8_000);

    const baselineDiagnostics = await browserLab.invokeIpc<RuntimeDiagnosticsSnapshot>(
      request,
      IPC.GetBackendRuntimeDiagnostics,
    );
    const baselineTraceCount = baselineDiagnostics.terminalInputTracing.completedTraces.length;

    await browserLab.typeInTerminal(page, 'latencyprobe', focusedTerminalIndex);
    await page.waitForTimeout(1_500);

    await expect
      .poll(
        async () => {
          const diagnostics = await browserLab.invokeIpc<RuntimeDiagnosticsSnapshot>(
            request,
            IPC.GetBackendRuntimeDiagnostics,
          );
          return diagnostics.terminalInputTracing.completedTraces.length;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(baselineTraceCount);

    const diagnostics = await browserLab.invokeIpc<RuntimeDiagnosticsSnapshot>(
      request,
      IPC.GetBackendRuntimeDiagnostics,
    );
    const newCompletedTraces =
      diagnostics.terminalInputTracing.completedTraces.slice(baselineTraceCount);
    const newTraceDurationsMs = newCompletedTraces
      .map((trace) => getCompletedTraceDurationMs(trace))
      .filter((durationMs): durationMs is number => durationMs !== null);

    expect(newCompletedTraces.length).toBeGreaterThan(0);
    expect(newTraceDurationsMs.length).toBe(newCompletedTraces.length);
    expect(Math.max(...newTraceDurationsMs)).toBeLessThan(120);
    expect(
      newCompletedTraces.every((sample) => sample.completed && sample.failureReason === null),
    ).toBe(true);

    const terminalStatusHistory = await browserLab.readTerminalStatusHistory(
      page,
      focusedTerminalIndex,
    );
    expect(terminalStatusHistory).not.toContain('restoring');
  });
});
