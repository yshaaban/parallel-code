import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

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
const APP_SHELL_SELECTOR = '.app-shell';
const CLEAR_LINE_SETTLE_MS = 100;
const NOISE_START_SETTLE_MS = 250;
const NOISE_STOP_SETTLE_MS = 150;
const PROFILE_TERMINAL_OPEN_SHORTCUT = 'Control+Shift+D';
const SERVER_START_TIMEOUT_MS = 20_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const TERMINAL_ATTACH_TIMEOUT_MS = 10_000;
const TRACE_POLL_INTERVAL_MS = 100;
const TRACE_READY_TIMEOUT_BUFFER_MS = 3_000;
const TRACE_RESULT_TIMEOUT_BUFFER_MS = 2_000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STANDALONE_SERVER_ENTRY = path.resolve(__dirname, '..', 'dist-server', 'server', 'main.js');

function parseArgs(argv) {
  const options = {
    authToken: process.env.AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN,
    keepServer: false,
    launchServer: false,
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

    if (arg === '--keep-server') {
      options.keepServer = true;
      continue;
    }

    if (arg === '--launch-server') {
      options.launchServer = true;
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

function getTerminalLocator(page, terminalIndex) {
  return page.locator(TERMINAL_SELECTOR).nth(terminalIndex);
}

function getTerminalReadyLocator(page, terminalIndex) {
  return page.locator(TERMINAL_READY_SELECTOR).nth(terminalIndex);
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

    await new Promise((resolve) => setTimeout(resolve, TRACE_POLL_INTERVAL_MS));
  }

  return getTerminalInputTracingSnapshot(client);
}

async function waitForTracingReady(page, client, terminalIndex, settleMs) {
  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('x');
  const snapshot = await waitForCompletedTraces(
    client,
    1,
    settleMs + TRACE_READY_TIMEOUT_BUFFER_MS,
  );

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
  await page.locator(APP_SHELL_SELECTOR).click({
    force: true,
    position: { x: 12, y: 12 },
  });
  await page.keyboard.press(PROFILE_TERMINAL_OPEN_SHORTCUT);
  await getTerminalLocator(page, terminalCount).waitFor({
    state: 'visible',
    timeout: TERMINAL_ATTACH_TIMEOUT_MS,
  });
  await getTerminalReadyLocator(page, terminalCount).waitFor({
    state: 'attached',
    timeout: TERMINAL_ATTACH_TIMEOUT_MS,
  });
  return terminalCount;
}

async function focusTerminal(page, terminalIndex) {
  await getTerminalLocator(page, terminalIndex).click({
    force: true,
    position: { x: 24, y: 24 },
  });
  await getTerminalReadyLocator(page, terminalIndex).focus();
}

async function clearTerminalLine(page, terminalIndex) {
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('Control+U');
  await page.waitForTimeout(CLEAR_LINE_SETTLE_MS);
}

async function startBackgroundNoise(page) {
  const terminalIndex = await createProfileTerminal(page);
  await focusTerminal(page, terminalIndex);
  await page.keyboard.type(BACKGROUND_NOISE_COMMAND);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(NOISE_START_SETTLE_MS);
  return terminalIndex;
}

async function stopBackgroundNoise(page, terminalIndex) {
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(NOISE_STOP_SETTLE_MS);
}

async function runPattern(page, client, terminalIndex, pattern, settleMs) {
  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
  await focusTerminal(page, terminalIndex);
  await pattern.run(page);
  await page.waitForTimeout(settleMs);
  return waitForCompletedTraces(
    client,
    pattern.minimumTraces ?? 1,
    settleMs + TRACE_RESULT_TIMEOUT_BUFFER_MS,
  );
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

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to reserve a localhost port for terminal profiling'));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function waitForServerReady(serverProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the standalone server to start'));
    }, SERVER_START_TIMEOUT_MS);

    function cleanup() {
      globalThis.clearTimeout(timeout);
      serverProcess.stdout.off('data', handleStdout);
      serverProcess.stderr.off('data', handleStderr);
      serverProcess.off('exit', handleExit);
    }

    function handleStdout(chunk) {
      const text = chunk.toString();
      if (text.includes('Parallel Code server listening on')) {
        cleanup();
        resolve();
      }
    }

    function handleStderr(chunk) {
      const text = chunk.toString();
      if (text.trim().length > 0) {
        process.stderr.write(text);
      }
    }

    function handleExit(code) {
      cleanup();
      reject(new Error(`Standalone server exited early with code ${code ?? 'null'}`));
    }

    serverProcess.stdout.on('data', handleStdout);
    serverProcess.stderr.on('data', handleStderr);
    serverProcess.on('exit', handleExit);
  });
}

function stopServerProcess(serverProcess) {
  return new Promise((resolve) => {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      serverProcess.kill('SIGKILL');
    }, SERVER_STOP_TIMEOUT_MS);

    serverProcess.once('exit', () => {
      globalThis.clearTimeout(timeout);
      resolve();
    });

    serverProcess.kill('SIGTERM');
  });
}

async function maybeLaunchServer(options) {
  if (!options.launchServer) {
    return null;
  }

  const port = await reservePort();
  const authToken = `terminal-profiler-${randomBytes(12).toString('hex')}`;
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-terminal-profiler-'));
  const serverProcess = spawn(process.execPath, [STANDALONE_SERVER_ENTRY], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      AUTH_TOKEN: authToken,
      PARALLEL_CODE_USER_DATA_DIR: userDataPath,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServerReady(serverProcess);
  } catch (error) {
    await stopServerProcess(serverProcess).catch(() => {});
    await rm(userDataPath, { force: true, recursive: true }).catch(() => {});
    throw error;
  }

  return {
    authToken,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (options.keepServer) {
        console.log(`Keeping standalone server alive at http://127.0.0.1:${port}`);
        return;
      }

      await stopServerProcess(serverProcess);
      await rm(userDataPath, { force: true, recursive: true });
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const launchedServer = await maybeLaunchServer(options);
  const serverUrl = launchedServer?.baseUrl ?? options.serverUrl;
  const authToken = launchedServer?.authToken ?? options.authToken;
  const client = createBrowserServerClient({
    authToken,
    serverUrl,
  });
  let browser;
  let context;
  let page;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await context.addInitScript(
      ([displayNameStorageKey, clientIdStorageKey]) => {
        globalThis.localStorage.setItem(displayNameStorageKey, 'Latency Profiler');
        globalThis.sessionStorage.setItem(clientIdStorageKey, 'latency-profiler-session');
      },
      [DISPLAY_NAME_STORAGE_KEY, CLIENT_ID_STORAGE_KEY],
    );
    page = await context.newPage();
    const authedUrl = new URL('/', serverUrl);
    authedUrl.searchParams.set('token', authToken);
    console.log(`Opening ${authedUrl.toString()}`);
    await page.goto(authedUrl.toString());
    await page.locator(APP_SHELL_SELECTOR).waitFor({ state: 'visible' });
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
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await launchedServer?.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
