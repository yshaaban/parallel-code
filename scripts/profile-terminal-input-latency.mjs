import process from 'node:process';
import { URL } from 'node:url';

import { chromium } from '@playwright/test';

import { createBrowserServerClient } from './browser-server-client.mjs';

const GET_BACKEND_RUNTIME_DIAGNOSTICS = 'get_backend_runtime_diagnostics';
const RESET_BACKEND_RUNTIME_DIAGNOSTICS = 'reset_backend_runtime_diagnostics';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const DEFAULT_AUTH_TOKEN = 'parallel-code-local-browser';
const CLIENT_ID_STORAGE_KEY = 'parallel-code-client-id';
const DISPLAY_NAME_STORAGE_KEY = 'parallel-code-display-name';
const TERMINAL_SELECTOR = '.xterm';
const TERMINAL_READY_SELECTOR = '.xterm-helper-textarea, .xterm textarea';
const BACKGROUND_NOISE_COMMAND = 'node scripts/fixtures/tui-statusline.mjs 1500 10';

function parseArgs(argv) {
  const options = {
    authToken: process.env.AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN,
    serverUrl: process.env.SERVER_URL ?? DEFAULT_SERVER_URL,
    settleMs: Number.parseInt(process.env.TERMINAL_TRACE_SETTLE_MS ?? '3000', 10),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--server-url') {
      options.serverUrl = argv[index + 1] ?? options.serverUrl;
      index += 1;
      continue;
    }

    if (arg === '--auth-token') {
      options.authToken = argv[index + 1] ?? options.authToken;
      index += 1;
      continue;
    }

    if (arg === '--settle-ms') {
      options.settleMs = Number.parseInt(argv[index + 1] ?? String(options.settleMs), 10);
      index += 1;
    }
  }

  return options;
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${value.toFixed(2)}ms`;
}

function describeSummary(summary) {
  return [
    `count=${summary.count}`,
    `e2e p50=${formatMs(summary.endToEndMs.p50)} p95=${formatMs(summary.endToEndMs.p95)}`,
    `buffer p50=${formatMs(summary.clientBufferMs.p50)}`,
    `send p50=${formatMs(summary.clientSendMs.p50)}`,
    `send->echo p50=${formatMs(summary.sendToEchoMs.p50)}`,
    `server queue p50=${formatMs(summary.serverQueueMs.p50)}`,
    `transport residual p50=${formatMs(summary.transportResidualMs.p50)}`,
    `render p50=${formatMs(summary.renderMs.p50)}`,
  ].join(' | ');
}

function getTraceDuration(sample, startKey, endKey) {
  const start = sample.stages[startKey];
  const end = sample.stages[endKey];
  if (start === null || end === null) {
    return null;
  }

  return Math.max(0, end - start);
}

function printSlowSamples(snapshot) {
  const sorted = [...snapshot.completedTraces]
    .filter((sample) => sample.completed)
    .sort((left, right) => {
      const leftDuration = getTraceDuration(left, 'startedAtMs', 'outputRenderedAtMs') ?? 0;
      const rightDuration = getTraceDuration(right, 'startedAtMs', 'outputRenderedAtMs') ?? 0;
      return rightDuration - leftDuration;
    })
    .slice(0, 5);

  if (sorted.length === 0) {
    console.log(
      `  no completed traces recorded (active=${snapshot.activeTraceCount} dropped=${snapshot.droppedTraces})`,
    );
    return;
  }

  for (const sample of sorted) {
    const endToEndMs = getTraceDuration(sample, 'startedAtMs', 'outputRenderedAtMs');
    const clientBufferMs = getTraceDuration(sample, 'startedAtMs', 'bufferedAtMs');
    const clientSendMs = getTraceDuration(sample, 'bufferedAtMs', 'sendStartedAtMs');
    const sendToEchoMs = getTraceDuration(sample, 'sendStartedAtMs', 'outputReceivedAtMs');
    const serverQueueMs = getTraceDuration(sample, 'serverReceivedAtMs', 'ptyWrittenAtMs');
    const renderMs = getTraceDuration(sample, 'outputReceivedAtMs', 'outputRenderedAtMs');
    const transportResidualMs =
      sendToEchoMs !== null && serverQueueMs !== null
        ? Math.max(0, sendToEchoMs - serverQueueMs)
        : null;
    console.log(
      `  ${sample.requestId} ${sample.inputKind} chars=${sample.inputChars} e2e=${formatMs(endToEndMs ?? NaN)} ` +
        `buffer=${formatMs(clientBufferMs ?? NaN)} send=${formatMs(clientSendMs ?? NaN)} ` +
        `send->echo=${formatMs(sendToEchoMs ?? NaN)} server-queue=${formatMs(serverQueueMs ?? NaN)} ` +
        `transport-residual=${formatMs(transportResidualMs ?? NaN)} render=${formatMs(renderMs ?? NaN)} preview=${JSON.stringify(sample.inputPreview)}`,
    );
  }
}

async function getTerminalInputTracingSnapshot(client) {
  const diagnostics = await client.invokeIpc(GET_BACKEND_RUNTIME_DIAGNOSTICS);
  return diagnostics.terminalInputTracing;
}

function getCompletedTraceCount(snapshot) {
  return snapshot.completedTraces.filter((sample) => sample.completed).length;
}

async function waitForCompletedTraces(client, minimumCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getTerminalInputTracingSnapshot(client);
    const completedCount = getCompletedTraceCount(snapshot);
    if (completedCount >= minimumCount) {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return getTerminalInputTracingSnapshot(client);
}

async function waitForTracingReady(page, client, terminalIndex, settleMs) {
  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('x');
  const snapshot = await waitForCompletedTraces(client, 1, settleMs + 3_000);

  if (snapshot.summary.count < 1) {
    throw new Error(
      `Terminal input tracing never became ready (completed=${snapshot.summary.count} active=${snapshot.activeTraceCount} dropped=${snapshot.droppedTraces})`,
    );
  }

  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
}

async function createProfileTerminal(page) {
  const terminalCount = await page.locator(TERMINAL_SELECTOR).count();
  await page.locator('.app-shell').click({
    force: true,
    position: { x: 12, y: 12 },
  });
  await page.keyboard.press('Control+Shift+D');
  await page
    .locator(TERMINAL_SELECTOR)
    .nth(terminalCount)
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .locator(TERMINAL_READY_SELECTOR)
    .nth(terminalCount)
    .waitFor({ state: 'attached', timeout: 10_000 });
  return terminalCount;
}

async function focusTerminal(page, terminalIndex) {
  await page
    .locator(TERMINAL_SELECTOR)
    .nth(terminalIndex)
    .click({
      force: true,
      position: { x: 24, y: 24 },
    });
  await page.locator(TERMINAL_READY_SELECTOR).nth(terminalIndex).focus();
}

async function clearTerminalLine(page, terminalIndex) {
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('Control+U');
  await page.waitForTimeout(100);
}

async function startBackgroundNoise(page) {
  const terminalIndex = await createProfileTerminal(page);
  await focusTerminal(page, terminalIndex);
  await page.keyboard.type(BACKGROUND_NOISE_COMMAND);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  return terminalIndex;
}

async function stopBackgroundNoise(page, terminalIndex) {
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(150);
}

async function runPattern(page, client, terminalIndex, pattern, settleMs) {
  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
  await focusTerminal(page, terminalIndex);
  await pattern.run(page);
  await page.waitForTimeout(settleMs);
  return waitForCompletedTraces(client, pattern.minimumTraces ?? 1, settleMs + 2_000);
}

const PATTERNS = [
  {
    name: 'single-key',
    async run(page) {
      await page.keyboard.press('x');
    },
  },
  {
    name: 'rapid-word',
    minimumTraces: 1,
    async run(page) {
      await page.keyboard.type('latencyprobe');
    },
  },
  {
    name: 'repeat-key-burst',
    minimumTraces: 1,
    async run(page) {
      for (let index = 0; index < 16; index += 1) {
        await page.keyboard.press('a');
      }
    },
  },
  {
    name: 'paste-burst',
    minimumTraces: 1,
    async run(page) {
      await page.keyboard.insertText(`PASTE_${'XYZ123'.repeat(32)}`);
    },
  },
];

const SUITES = [
  {
    name: 'quiet',
  },
  {
    backgroundNoise: true,
    name: 'background-noise',
  },
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = createBrowserServerClient({
    authToken: options.authToken,
    serverUrl: options.serverUrl,
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(
    ([displayNameStorageKey, clientIdStorageKey]) => {
      globalThis.localStorage.setItem(displayNameStorageKey, 'Latency Profiler');
      globalThis.sessionStorage.setItem(clientIdStorageKey, 'latency-profiler-session');
    },
    [DISPLAY_NAME_STORAGE_KEY, CLIENT_ID_STORAGE_KEY],
  );
  const page = await context.newPage();
  const authedUrl = new URL('/', options.serverUrl);
  authedUrl.searchParams.set('token', options.authToken);

  try {
    console.log(`Opening ${authedUrl.toString()}`);
    await page.goto(authedUrl.toString());
    await page.locator('.app-shell').waitFor({ state: 'visible' });
    await page.locator(TERMINAL_SELECTOR).first().waitFor({ state: 'visible' });
    await page.locator(TERMINAL_READY_SELECTOR).first().waitFor({ state: 'attached' });
    const profileTerminalIndex = await createProfileTerminal(page);
    await waitForTracingReady(page, client, profileTerminalIndex, options.settleMs);

    for (const suite of SUITES) {
      console.log(`\n[suite] ${suite.name}`);
      let noiseTerminalIndex = null;
      if (suite.backgroundNoise) {
        noiseTerminalIndex = await startBackgroundNoise(page);
      }

      try {
        for (const pattern of PATTERNS) {
          console.log(`\n[pattern] ${pattern.name}`);
          const snapshot = await runPattern(
            page,
            client,
            profileTerminalIndex,
            pattern,
            options.settleMs,
          );
          console.log(`  ${describeSummary(snapshot.summary)}`);
          printSlowSamples(snapshot);
        }
      } finally {
        if (noiseTerminalIndex !== null) {
          await stopBackgroundNoise(page, noiseTerminalIndex);
        }
      }
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
