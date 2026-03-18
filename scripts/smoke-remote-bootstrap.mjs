import { URL } from 'node:url';
import { chromium } from '@playwright/test';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const REMOTE_AUTH_FALLBACK_TEXT = 'Not authenticated';

function parseArgs(argv) {
  const options = {
    authToken: process.env.AUTH_TOKEN ?? '',
    ignoreHttpsErrors: false,
    serverUrl: process.env.SERVER_URL ?? '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case '--auth-token':
        options.authToken = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--ignore-https-errors':
        options.ignoreHttpsErrors = true;
        break;
      case '--server-url':
        options.serverUrl = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--timeout-ms': {
        const timeoutMs = Number(argv[index + 1]);
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          options.timeoutMs = timeoutMs;
        }
        index += 1;
        break;
      }
      default:
        break;
    }
  }

  return options;
}

function assertRequiredOption(value, flag) {
  if (!value) {
    throw new Error(
      `Missing ${flag}. Provide it as ${flag} <value> or via the matching environment variable.`,
    );
  }
}

function buildRemoteBootstrapUrl(serverUrl, authToken) {
  const url = new URL('/remote', serverUrl);
  url.searchParams.set('token', authToken);
  return url.toString();
}

async function readPageBodyText(page) {
  return page
    .locator('body')
    .innerText()
    .catch(() => '');
}

function writeResult(payload, method = 'log') {
  console[method](JSON.stringify(payload, null, 2));
}

async function waitForRemoteShell(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const bodyText = await readPageBodyText(page);
    if (bodyText.includes(REMOTE_AUTH_FALLBACK_TEXT)) {
      throw new Error('Remote shell rendered the auth fallback instead of the remote app.');
    }

    if (bodyText.includes('Parallel Code')) {
      return;
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error('Timed out waiting for the remote shell to render.');
}

async function waitForRemoteWebSocket(getState, page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (getState()) {
      return;
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error('Remote bootstrap did not open a websocket connection.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertRequiredOption(options.serverUrl, '--server-url');
  assertRequiredOption(options.authToken, '--auth-token');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
  });
  const page = await context.newPage();
  const logs = [];
  let sawRemoteWebSocket = false;

  page.on('console', (message) => {
    logs.push(`console:${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    logs.push(`pageerror: ${error.stack ?? error.message}`);
  });
  page.on('websocket', (socket) => {
    logs.push(`websocket:open ${socket.url()}`);
    const url = new URL(socket.url());
    if (url.pathname === '/ws') {
      sawRemoteWebSocket = true;
    }
  });

  try {
    await page.goto(buildRemoteBootstrapUrl(options.serverUrl, options.authToken), {
      timeout: options.timeoutMs,
      waitUntil: 'networkidle',
    });

    await waitForRemoteShell(page, options.timeoutMs);
    await waitForRemoteWebSocket(() => sawRemoteWebSocket, page, options.timeoutMs);

    writeResult({
      finalUrl: page.url(),
      status: 'ok',
      websocketConnected: sawRemoteWebSocket,
    });
  } catch (error) {
    writeResult(
      {
        bodyText: await readPageBodyText(page),
        error: error instanceof Error ? error.message : String(error),
        finalUrl: page.url(),
        logs,
        status: 'failed',
        websocketConnected: sawRemoteWebSocket,
      },
      'error',
    );
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

void main();
