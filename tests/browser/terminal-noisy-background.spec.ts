import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';
import { getRendererDiagnostics } from './harness/terminal-render.js';
import {
  measureSingleKeyTrace,
  warmTerminalInputTracing,
} from './harness/terminal-input-tracing.js';

const NOISY_OUTPUT_COMMAND =
  'i=0; while [ "$i" -lt 180 ]; do printf "\\rNOISE_%04d" "$i"; i=$((i+1)); sleep 0.02; done; printf "\\nNOISE_DONE\\n"';

async function waitForTerminalAgentId(
  page: import('@playwright/test').Page,
  terminalIndex: number,
): Promise<string> {
  const terminalStatus = page.locator('[data-terminal-status]').nth(terminalIndex);
  await expect
    .poll(
      async () => {
        const agentId = await terminalStatus.getAttribute('data-terminal-agent-id');
        if (agentId && agentId.length > 0) {
          return agentId;
        }
        return null;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();

  const agentId = await terminalStatus.getAttribute('data-terminal-agent-id');
  expect(agentId).toBeTruthy();
  return agentId ?? '';
}

async function waitForVisibleShellPrompt(
  page: import('@playwright/test').Page,
  terminalIndex: number,
): Promise<void> {
  const terminalStatus = page.locator('[data-terminal-status]').nth(terminalIndex);
  await expect
    .poll(
      async () => {
        const text = await terminalStatus.textContent();
        return /(?:➜|❯)|(?:^|\n)\s*[$#%]\s*$/u.test(text ?? '');
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

test.describe('browser-lab noisy background terminals', () => {
  test.use({
    scenario: createPromptReadyScenario(),
  });

  test('keeps focused foreground command round-trips responsive while a background terminal redraws', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Noise Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });

    await browserLab.waitForTerminalReady(page);
    const focusedTerminalIndex = await browserLab.createShellTerminal(page);
    const focusedShellAgentId = await waitForTerminalAgentId(page, focusedTerminalIndex);
    await browserLab.beginTerminalStatusHistory(page, focusedTerminalIndex);
    await waitForVisibleShellPrompt(page, focusedTerminalIndex);
    const backgroundTerminalIndex = await browserLab.createShellTerminal(page);
    const backgroundAgentId = await waitForTerminalAgentId(page, backgroundTerminalIndex);
    await waitForVisibleShellPrompt(page, backgroundTerminalIndex);

    await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
      terminalIndex: backgroundTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, backgroundAgentId, 'NOISE_');
    await browserLab.focusTerminal(page, focusedTerminalIndex);
    await browserLab.waitForTerminalInteractiveReady(page, focusedTerminalIndex);
    await waitForVisibleShellPrompt(page, focusedTerminalIndex);

    const focusReadyMarker = `FR${Date.now().toString(36).slice(-4)}`;
    await browserLab.focusTerminal(page, focusedTerminalIndex);
    await browserLab.runInTerminal(page, `echo ${focusReadyMarker}`, {
      terminalIndex: focusedTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, focusedShellAgentId, focusReadyMarker, 8_000);

    const latencyMarker = `FL${Date.now().toString(36).slice(-4)}`;
    const latencyStartedAt = Date.now();
    await browserLab.runInTerminal(page, `echo ${latencyMarker}`, {
      terminalIndex: focusedTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, focusedShellAgentId, latencyMarker, 8_000);
    const latencyMs = Date.now() - latencyStartedAt;

    await warmTerminalInputTracing(browserLab, page, request, focusedTerminalIndex, {
      clearLineAfterWarm: true,
    });
    await page.evaluate(() => {
      window.__parallelCodeRendererRuntimeDiagnostics?.reset();
    });
    const snapshot = await measureSingleKeyTrace(browserLab, page, request, 'x', {
      focusTerminal: false,
      terminalIndex: focusedTerminalIndex,
    });
    const rendererDiagnostics = await getRendererDiagnostics(page);

    expect(latencyMs).toBeLessThan(2_000);
    expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(24);
    expect(snapshot.summary.endToEndMs.p95).toBeLessThan(28);
    expect(
      rendererDiagnostics?.terminalInput.inFlightBatchesCurrent ?? Number.POSITIVE_INFINITY,
    ).toBe(0);
    expect(rendererDiagnostics?.terminalInput.queuedChunksCurrent ?? Number.POSITIVE_INFINITY).toBe(
      0,
    );
    await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);

    const terminalStatusHistory = await browserLab.readTerminalStatusHistory(
      page,
      focusedTerminalIndex,
    );
    expect(terminalStatusHistory).not.toContain('restoring');
  });
});
