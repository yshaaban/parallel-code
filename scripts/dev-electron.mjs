import { spawn } from 'child_process';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:1421';
const ELECTRON_BIN = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const ELECTRON_ARGS = ['--no-sandbox', 'dist-electron/main.js'];
const DEV_SERVER_TIMEOUT_MS = 60_000;
const DEV_SERVER_RETRY_MS = 250;
const FAST_EXIT_MS = 2_000;
const MAX_FAST_EXIT_RESTARTS = 2;
const RESTART_DELAY_MS = 500;
const IS_WSL =
  process.platform === 'linux' && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

const FILTERED_WSL_STDERR = [
  /Failed to call method: org\.freedesktop\.systemd1\.Manager\.StartTransientUnit: .*org\.freedesktop\.systemd1\.UnitExists: Unit app-org\.chromium\.Chromium-\d+\.scope was already loaded or has a fragment file\./,
];

let shuttingDown = false;
let child = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevServer() {
  const deadline = Date.now() + DEV_SERVER_TIMEOUT_MS;

  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(DEV_SERVER_URL, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore connection failures until timeout.
    }

    await sleep(DEV_SERVER_RETRY_MS);
  }

  if (!shuttingDown) {
    throw new Error(`Timed out waiting for dev server at ${DEV_SERVER_URL}`);
  }
}

function createFilteredStderrWriter() {
  let buffer = '';

  const flushLine = (line) => {
    const trimmed = line.replace(/\r?\n$/, '');
    const shouldFilter = IS_WSL && FILTERED_WSL_STDERR.some((pattern) => pattern.test(trimmed));

    if (!shouldFilter) {
      process.stderr.write(line);
    }
  };

  return {
    write(chunk) {
      buffer += chunk.toString('utf8');
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        flushLine(buffer.slice(0, newlineIndex + 1));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer) {
        flushLine(buffer);
        buffer = '';
      }
    },
  };
}

function forwardSignal(signal) {
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill(signal);
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

async function launchElectron() {
  let fastExitRestarts = 0;

  while (!shuttingDown) {
    await waitForDevServer();

    const stderr = createFilteredStderrWriter();
    const startedAt = Date.now();

    child = spawn(ELECTRON_BIN, ELECTRON_ARGS, {
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: DEV_SERVER_URL,
      },
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr.write(chunk);
    });

    const exit = await new Promise((resolve, reject) => {
      let settled = false;
      const settle =
        (callback) =>
        (...args) => {
          if (settled) {
            return;
          }
          settled = true;
          stderr.flush();
          callback(...args);
        };

      child.once('error', settle(reject));
      child.once(
        'exit',
        settle((code, signal) => resolve({ code, signal })),
      );
    });

    child = null;

    if (shuttingDown) {
      return typeof exit.code === 'number' ? exit.code : 0;
    }

    const runtimeMs = Date.now() - startedAt;
    const exitedTooFast = exit.code === 0 && exit.signal === null && runtimeMs < FAST_EXIT_MS;

    if (!exitedTooFast || fastExitRestarts >= MAX_FAST_EXIT_RESTARTS) {
      return typeof exit.code === 'number' ? exit.code : 0;
    }

    fastExitRestarts += 1;
    console.warn(
      `[dev-electron] Electron exited after ${runtimeMs}ms; retrying (${fastExitRestarts}/${MAX_FAST_EXIT_RESTARTS})...`,
    );
    await sleep(RESTART_DELAY_MS);
  }

  return 0;
}

try {
  const exitCode = await launchElectron();
  process.exit(exitCode);
} catch (error) {
  console.error('[dev-electron]', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
