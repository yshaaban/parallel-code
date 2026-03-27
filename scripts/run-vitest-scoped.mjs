#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 60_000;
const FORCE_KILL_DELAY_MS = 2_000;

function printUsage() {
  console.error(
    [
      'Usage:',
      '  node scripts/run-vitest-scoped.mjs --config <vitest-config> [--timeout-ms <ms>] [--per-file] <file> [more files...]',
      '',
      'Examples:',
      '  npm run test:solid:file -- src/components/ScrollingDiffView.test.tsx',
      '  npm run test:node:file -- electron/ipc/git.test.ts src/app/project-workflows.test.ts',
    ].join('\n'),
  );
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}"`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = [...argv];
  const configIndex = args.indexOf('--config');
  const timeoutIndex = args.indexOf('--timeout-ms');
  const perFileIndex = args.indexOf('--per-file');

  let config;
  let timeoutMs = process.env.VITEST_SCOPED_TIMEOUT_MS
    ? parsePositiveInteger(process.env.VITEST_SCOPED_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  let perFile = process.env.VITEST_SCOPED_PER_FILE === '1';

  if (configIndex !== -1) {
    config = args[configIndex + 1];
    args.splice(configIndex, 2);
  }

  if (timeoutIndex !== -1) {
    timeoutMs = parsePositiveInteger(args[timeoutIndex + 1] ?? '');
    args.splice(timeoutIndex, 2);
  }

  if (perFileIndex !== -1) {
    perFile = true;
    args.splice(perFileIndex, 1);
  }

  for (const arg of [...args]) {
    if (arg.startsWith('--config=')) {
      config = arg.slice('--config='.length);
      args.splice(args.indexOf(arg), 1);
      continue;
    }

    if (arg.startsWith('--timeout-ms=')) {
      timeoutMs = parsePositiveInteger(arg.slice('--timeout-ms='.length));
      args.splice(args.indexOf(arg), 1);
    }
  }

  if (!config || args.length === 0) {
    printUsage();
    process.exit(1);
  }

  return {
    config,
    files: args,
    perFile,
    timeoutMs,
  };
}

function killChildProcessTree(child, signal = 'SIGTERM') {
  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    // Child already exited.
  }
}

const { config, files, perFile, timeoutMs } = parseArgs(process.argv.slice(2));

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const vitestEntry = path.resolve(scriptsDir, '../node_modules/vitest/vitest.mjs');

function runVitestInvocation(invocationFiles) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [vitestEntry, 'run', '--config', config, ...invocationFiles],
      {
        detached: process.platform !== 'win32',
        stdio: 'inherit',
      },
    );

    let finished = false;
    let timeoutHandle;
    let forceKillHandle;
    const signalCleanup = [];

    function clearHandles() {
      if (timeoutHandle) {
        globalThis.clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (forceKillHandle) {
        globalThis.clearTimeout(forceKillHandle);
        forceKillHandle = undefined;
      }
      while (signalCleanup.length > 0) {
        const cleanup = signalCleanup.pop();
        cleanup?.();
      }
    }

    function requestShutdown(signal) {
      if (finished) {
        return;
      }

      killChildProcessTree(child, signal);
      if (!forceKillHandle) {
        forceKillHandle = globalThis.setTimeout(() => {
          killChildProcessTree(child, 'SIGKILL');
        }, FORCE_KILL_DELAY_MS);
        forceKillHandle.unref?.();
      }
    }

    timeoutHandle = globalThis.setTimeout(() => {
      console.error(
        `[run-vitest-scoped] Timed out after ${timeoutMs}ms. Terminating the Vitest process tree.`,
      );
      requestShutdown('SIGTERM');
    }, timeoutMs);
    timeoutHandle.unref?.();

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handleSignal = () => {
        requestShutdown(signal);
      };
      process.on(signal, handleSignal);
      signalCleanup.push(() => {
        process.off(signal, handleSignal);
      });
    }

    const handleExit = () => {
      requestShutdown('SIGTERM');
    };
    process.on('exit', handleExit);
    signalCleanup.push(() => {
      process.off('exit', handleExit);
    });

    child.on('exit', (code, signal) => {
      finished = true;
      clearHandles();
      resolve(signal ? 1 : (code ?? 1));
    });

    child.on('error', (error) => {
      finished = true;
      clearHandles();
      console.error(`[run-vitest-scoped] Failed to start Vitest: ${error.message}`);
      resolve(1);
    });
  });
}

async function main() {
  const invocations = perFile ? files.map((file) => [file]) : [files];
  for (const invocationFiles of invocations) {
    const exitCode = await runVitestInvocation(invocationFiles);
    if (exitCode !== 0) {
      process.exitCode = 1;
      return;
    }
  }

  process.exitCode = 0;
}

await main();
