import { setTimeout as delay } from 'timers/promises';
import { describe, expect, it } from 'vitest';

import { execFileWithDeadline, spawnWithDeadline } from './bounded-process.js';

const PROCESS_EXIT_POLL_MS = 20;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await delay(PROCESS_EXIT_POLL_MS);
  }
  expect(isProcessAlive(pid), `expected process ${pid} to exit`).toBe(false);
}

function forceCleanup(parentPid: number | undefined, descendantPid: number | undefined): void {
  if (process.platform !== 'win32' && parentPid && parentPid > 0) {
    try {
      process.kill(-parentPid, 'SIGKILL');
    } catch {
      // The owned process group already exited.
    }
  }
  for (const pid of [descendantPid, parentPid]) {
    if (!pid || pid <= 0) {
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The individual process already exited.
    }
  }
}

describe('bounded subprocess tree integration', () => {
  it('delivers stdin EOF when buffered execution has no explicit input', async () => {
    const result = await execFileWithDeadline(
      process.execPath,
      [
        '-e',
        "process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('eof'))",
      ],
      { encoding: 'utf8', timeoutMs: 1_000 },
    );

    expect(result).toEqual({ stderr: '', stdout: 'eof' });
  });

  it('terminates an uncooperative child and its pipe-holding descendant before rejecting', async () => {
    const descendantSource = [
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('');
    const parentSource = [
      "const { spawn } = require('child_process');",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {`,
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      '});',
      "process.stdout.write(String(descendant.pid) + '\\n');",
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const startedAt = Date.now();
    const bounded = spawnWithDeadline(
      process.execPath,
      ['-e', parentSource],
      { stdio: ['ignore', 'pipe', 'pipe'] },
      {
        forceKillCloseGraceMs: 1_000,
        terminateGraceMs: 100,
        timeoutMs: 1_000,
      },
    );
    const parentPid = bounded.child.pid;
    let descendantPid: number | undefined;
    let stdout = '';
    bounded.child.stdout?.setEncoding('utf8');
    bounded.child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const parsed = Number.parseInt(stdout.trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        descendantPid = parsed;
      }
    });
    const completionResult = bounded.completion.catch((error: unknown) => error);

    try {
      const result = await completionResult;
      expect(result).toMatchObject({ code: 'ETIMEDOUT' });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(parentPid).toBeTypeOf('number');
      expect(descendantPid).toBeTypeOf('number');
      await waitForProcessExit(parentPid as number);
      await waitForProcessExit(descendantPid as number);
    } finally {
      forceCleanup(parentPid, descendantPid);
      bounded.child.stdin?.destroy();
      bounded.child.stdout?.destroy();
      bounded.child.stderr?.destroy();
    }
  }, 10_000);

  it.skipIf(process.platform === 'win32')(
    'retains and kills a detached uncooperative descendant after its root exits',
    async () => {
      const descendantSource = [
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join('');
      const parentSource = [
        "const { spawn } = require('child_process');",
        `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {`,
        '  detached: true,',
        "  stdio: ['ignore', 'inherit', 'inherit'],",
        '});',
        'descendant.unref();',
        "process.stdout.write(String(descendant.pid) + '\\n');",
        'setTimeout(() => process.exit(0), 250);',
      ].join('\n');

      const startedAt = Date.now();
      const bounded = spawnWithDeadline(
        process.execPath,
        ['-e', parentSource],
        { stdio: ['ignore', 'pipe', 'pipe'] },
        {
          forceKillCloseGraceMs: 1_000,
          terminateGraceMs: 100,
          timeoutMs: 750,
        },
      );
      const parentPid = bounded.child.pid;
      let descendantPid: number | undefined;
      let stdout = '';
      bounded.child.stdout?.setEncoding('utf8');
      bounded.child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        const parsed = Number.parseInt(stdout.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          descendantPid = parsed;
        }
      });
      const completionResult = bounded.completion.catch((error: unknown) => error);

      try {
        const result = await completionResult;
        expect(result).toMatchObject({ code: 'ETIMEDOUT' });
        expect(Date.now() - startedAt).toBeLessThan(4_000);
        expect(parentPid).toBeTypeOf('number');
        expect(descendantPid).toBeTypeOf('number');
        await waitForProcessExit(parentPid as number);
        await waitForProcessExit(descendantPid as number);
      } finally {
        forceCleanup(parentPid, descendantPid);
        bounded.child.stdin?.destroy();
        bounded.child.stdout?.destroy();
        bounded.child.stderr?.destroy();
      }
    },
    10_000,
  );
});
