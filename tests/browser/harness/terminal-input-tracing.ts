import { expect, type APIRequestContext, type Page } from '@playwright/test';

import { IPC } from '../../../electron/ipc/channels.js';
import type { TerminalInputTraceDiagnosticsSnapshot } from '../../../src/domain/terminal-input-tracing.js';

interface TerminalInputTracingHarness {
  focusTerminal: (page: Page, terminalIndex?: number) => Promise<void>;
  invokeIpc: <TResult>(
    request: APIRequestContext,
    channel: IPC,
    body?: unknown,
  ) => Promise<TResult>;
  typeInTerminal: (page: Page, text: string, terminalIndex?: number) => Promise<void>;
}

const TERMINAL_LINE_CLEAR_SETTLE_MS = 100;

export async function getTerminalInputTracingSnapshot(
  browserLab: Pick<TerminalInputTracingHarness, 'invokeIpc'>,
  request: APIRequestContext,
): Promise<TerminalInputTraceDiagnosticsSnapshot> {
  const diagnostics = await browserLab.invokeIpc<{
    terminalInputTracing: TerminalInputTraceDiagnosticsSnapshot;
  }>(request, IPC.GetBackendRuntimeDiagnostics);
  return diagnostics.terminalInputTracing;
}

export async function waitForCompletedTerminalInputTraces(
  browserLab: Pick<TerminalInputTracingHarness, 'invokeIpc'>,
  request: APIRequestContext,
  minimumCount: number,
): Promise<TerminalInputTraceDiagnosticsSnapshot> {
  await expect
    .poll(
      async () => {
        const snapshot = await getTerminalInputTracingSnapshot(browserLab, request);
        return snapshot.summary.count;
      },
      { timeout: 8_000 },
    )
    .toBeGreaterThanOrEqual(minimumCount);

  return getTerminalInputTracingSnapshot(browserLab, request);
}

export async function warmTerminalInputTracing(
  browserLab: TerminalInputTracingHarness,
  page: Page,
  request: APIRequestContext,
  terminalIndex = 0,
  options?: {
    clearLineAfterWarm?: boolean;
  },
): Promise<void> {
  await browserLab.focusTerminal(page, terminalIndex);
  await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
  await browserLab.typeInTerminal(page, `warm${Date.now().toString(36)}`, terminalIndex);
  await waitForCompletedTerminalInputTraces(browserLab, request, 1);
  if (options?.clearLineAfterWarm === true) {
    await browserLab.focusTerminal(page, terminalIndex);
    await page.keyboard.press('Control+U');
    await page.waitForTimeout(TERMINAL_LINE_CLEAR_SETTLE_MS);
  }
  await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
}

export async function measureSingleKeyTrace(
  browserLab: Pick<TerminalInputTracingHarness, 'focusTerminal' | 'invokeIpc'>,
  page: Page,
  request: APIRequestContext,
  key: string,
  options?: {
    focusTerminal?: boolean;
    terminalIndex?: number;
  },
): Promise<TerminalInputTraceDiagnosticsSnapshot> {
  const focusTerminal = options?.focusTerminal ?? true;
  const terminalIndex = options?.terminalIndex ?? 0;

  if (focusTerminal) {
    await browserLab.focusTerminal(page, terminalIndex);
  }
  await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
  await page.keyboard.press(key);
  return waitForCompletedTerminalInputTraces(browserLab, request, 1);
}

export async function measureTypedTextTrace(
  browserLab: Pick<TerminalInputTracingHarness, 'focusTerminal' | 'invokeIpc'>,
  page: Page,
  request: APIRequestContext,
  text: string,
  options?: {
    focusTerminal?: boolean;
    minimumCount?: number;
    terminalIndex?: number;
  },
): Promise<TerminalInputTraceDiagnosticsSnapshot> {
  const focusTerminal = options?.focusTerminal ?? true;
  const minimumCount = options?.minimumCount ?? 1;
  const terminalIndex = options?.terminalIndex ?? 0;

  if (focusTerminal) {
    await browserLab.focusTerminal(page, terminalIndex);
  }
  await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
  await page.keyboard.type(text);
  return waitForCompletedTerminalInputTraces(browserLab, request, minimumCount);
}

export async function measureRepeatedKeyTrace(
  browserLab: Pick<TerminalInputTracingHarness, 'focusTerminal' | 'invokeIpc'>,
  page: Page,
  request: APIRequestContext,
  key: string,
  count: number,
  options?: {
    focusTerminal?: boolean;
    minimumCount?: number;
    terminalIndex?: number;
  },
): Promise<TerminalInputTraceDiagnosticsSnapshot> {
  const focusTerminal = options?.focusTerminal ?? true;
  const minimumCount = options?.minimumCount ?? 1;
  const terminalIndex = options?.terminalIndex ?? 0;

  if (focusTerminal) {
    await browserLab.focusTerminal(page, terminalIndex);
  }
  await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press(key);
  }
  return waitForCompletedTerminalInputTraces(browserLab, request, minimumCount);
}
