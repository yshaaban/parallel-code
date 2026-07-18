import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import { runOperationWithCleanups } from './lib/cleanup-outcome.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_AUTH_TOKEN = 'parallel-code-local-browser';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:43117';
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const REMOTE_AUTH_FALLBACK_TEXT = 'Not authenticated';
const REMOTE_READY_TEXT_MARKERS = ['Parallel Code', 'Name this mobile session'];
const CHROMIUM_EXECUTABLE_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

function stripWrappingQuotes(value) {
  if (value.length < 2) {
    return value;
  }

  const firstChar = value[0];
  const lastChar = value[value.length - 1];
  if ((firstChar === '"' && lastChar === '"') || (firstChar === "'" && lastChar === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

export function parseEnvFile(contents) {
  const parsed = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    parsed[key] = stripWrappingQuotes(trimmedLine.slice(separatorIndex + 1).trim());
  }

  return parsed;
}

function readEnvFileIfPresent(envPath) {
  if (!existsSync(envPath)) {
    return {};
  }

  return parseEnvFile(readFileSync(envPath, 'utf8'));
}

export function loadSmokeEnv(rootDir = path.resolve(__dirname, '..'), env = process.env) {
  const localEnv = readEnvFileIfPresent(path.join(rootDir, '.env'));
  const defaultEnv = readEnvFileIfPresent(path.join(rootDir, '.env.example'));
  return {
    ...defaultEnv,
    ...localEnv,
    ...env,
  };
}

function getEnvOption(env, name, fallback) {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function resolveChromiumExecutablePath(env = process.env, platform = process.platform) {
  const configuredPath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  for (const candidate of CHROMIUM_EXECUTABLE_CANDIDATES[platform] ?? []) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function getChromiumLaunchOptions(env = process.env) {
  const executablePath = resolveChromiumExecutablePath(env);
  if (executablePath) {
    return { headless: true, executablePath };
  }

  return { headless: true };
}

export function parseArgs(argv, env = process.env) {
  const options = {
    authToken: getEnvOption(env, 'AUTH_TOKEN', DEFAULT_AUTH_TOKEN),
    ignoreHttpsErrors: false,
    serverUrl: getEnvOption(env, 'SERVER_URL', DEFAULT_SERVER_URL),
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

export function assertRequiredOption(value, flag) {
  if (!value) {
    throw new Error(
      `Missing ${flag}. Provide it as ${flag} <value> or via the matching environment variable.`,
    );
  }
}

export function buildRemoteBootstrapUrl(serverUrl, authToken) {
  const url = new URL('/remote', serverUrl);
  url.searchParams.set('token', authToken);
  return url.toString();
}

export async function readPageBodyText(page) {
  return page
    .locator('body')
    .innerText()
    .catch(() => '');
}

export function writeResult(payload, method = 'log') {
  console[method](JSON.stringify(payload, null, 2));
}

function hasRemoteShellRendered(bodyText) {
  return REMOTE_READY_TEXT_MARKERS.some((text) => bodyText.includes(text));
}

export async function waitForRemoteShell(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const bodyText = await readPageBodyText(page);
    if (bodyText.includes(REMOTE_AUTH_FALLBACK_TEXT)) {
      throw new Error('Remote shell rendered the auth fallback instead of the remote app.');
    }

    if (hasRemoteShellRendered(bodyText)) {
      return;
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error('Timed out waiting for the remote shell to render.');
}

export async function waitForRemoteWebSocket(getState, page, timeoutMs) {
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
  const options = parseArgs(process.argv.slice(2), loadSmokeEnv());
  assertRequiredOption(options.serverUrl, '--server-url');
  assertRequiredOption(options.authToken, '--auth-token');

  let browser;
  let context;
  let page;
  const logs = [];
  let sawRemoteWebSocket = false;

  await runOperationWithCleanups(
    'Remote bootstrap smoke',
    async () => {
      browser = await chromium.launch(getChromiumLaunchOptions());
      context = await browser.newContext({
        ignoreHTTPSErrors: options.ignoreHttpsErrors,
      });
      page = await context.newPage();

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
          waitUntil: 'domcontentloaded',
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
      }
    },
    [
      ['close remote browser context', () => context?.close()],
      ['close remote browser', () => browser?.close()],
    ],
  );
}

function isCliEntrypoint() {
  return (
    !process.env.VITEST_WORKER_ID &&
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === __filename
  );
}

if (isCliEntrypoint()) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
