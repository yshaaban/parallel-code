import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runIndependentCleanups } from '../../scripts/lib/cleanup-outcome.mjs';
import {
  spawnStandaloneServerProcess,
  stopStandaloneServerProcessWithRetry,
} from '../../scripts/lib/standalone-server-process.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ENTRY = path.resolve(PROJECT_ROOT, 'scripts', 'fixtures', 'tui-render-stress.mjs');

const activeChildren = new Set<ReturnType<typeof spawnStandaloneServerProcess>>();

interface SpawnedFixture {
  child: ReturnType<typeof spawnStandaloneServerProcess>;
  getStderr: () => string;
  getStdout: () => string;
}

function spawnFixture(args: string[]): SpawnedFixture {
  const child = spawnStandaloneServerProcess(process.execPath, [FIXTURE_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    getStderr: () => stderr,
    getStdout: () => stdout,
  };
}

async function waitForOutputMatch(
  getStdout: () => string,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stdout = getStdout();
    if (pattern.test(stdout)) {
      return stdout;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for fixture output ${String(pattern)}`);
}

function waitPatternThroughRestoreCursor(text: string): RegExp {
  const escapedText = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escapedText}[\\s\\S]*\\u001b\\[u`, 'u');
}

async function stopFixture(child: ReturnType<typeof spawnStandaloneServerProcess>): Promise<void> {
  await stopStandaloneServerProcessWithRetry(child);
  activeChildren.delete(child);
}

afterEach(async () => {
  await runIndependentCleanups(
    'TUI render stress test child processes',
    Array.from(
      activeChildren,
      (child, index) =>
        [`stop TUI render stress child ${index + 1}`, () => stopFixture(child)] as const,
    ),
  );
});

describe('tui-render-stress fixture', () => {
  it('supports the generic control-heavy alias with cursor-addressed redraw output', async () => {
    const fixture = spawnFixture(['control-heavy', '256', '96', '32', '8', '0']);

    try {
      const stdout = await waitForOutputMatch(
        fixture.getStdout,
        waitPatternThroughRestoreCursor('control-redraw fixture'),
      );

      expect(stdout).toContain('\u001b[?1049h');
      expect(stdout).toMatch(new RegExp(String.raw`\u001b\[[0-9;]*H`, 'u'));
      expect(stdout).toContain('\u001b[2K');
      expect(stdout).toContain('\u001b[s');
      expect(stdout).toContain('\u001b[u');
      expect(stdout).toContain('control-redraw fixture');
    } finally {
      await stopFixture(fixture.child);
    }

    expect(fixture.getStderr()).toBe('');
  });

  it('emits carriage-return progress redraw output in the generic progress mode', async () => {
    const fixture = spawnFixture(['progress-redraw', '256', '96', '32', '8', '0']);

    try {
      const stdout = await waitForOutputMatch(
        fixture.getStdout,
        /carriage-return progress redraw pressure/u,
      );

      expect(stdout).toContain('\u001b[?1049h');
      expect(stdout).toContain('\r\u001b[2K');
      expect(stdout).toContain('progress redraw fixture');
      expect(stdout).toContain('carriage-return progress redraw pressure');
    } finally {
      await stopFixture(fixture.child);
    }

    expect(fixture.getStderr()).toBe('');
  });

  it('emits midpoint prompt positioning output with save/restore cursor markers', async () => {
    const fixture = spawnFixture(['prompt-middle', '256', '96', '32', '8', '0']);

    try {
      const stdout = await waitForOutputMatch(
        fixture.getStdout,
        waitPatternThroughRestoreCursor('input>'),
      );

      expect(stdout).toContain('\u001b[?1049h');
      expect(stdout).toContain('\u001b[s');
      expect(stdout).toContain('\u001b[u');
      expect(stdout).toContain('prompt middle fixture');
      expect(stdout).toContain('input>');
    } finally {
      await stopFixture(fixture.child);
    }

    expect(fixture.getStderr()).toBe('');
  });

  it('emits resize-friendly save/restore redraw output in the generic resize mode', async () => {
    const fixture = spawnFixture(['save-restore-resize', '256', '96', '32', '8', '0']);

    try {
      const stdout = await waitForOutputMatch(
        fixture.getStdout,
        waitPatternThroughRestoreCursor('resize-friendly terminal repaint'),
      );

      expect(stdout).toContain('\u001b[?1049h');
      expect(stdout).toContain('\u001b[s');
      expect(stdout).toContain('\u001b[u');
      expect(stdout).toContain('save-restore resize fixture');
      expect(stdout).toContain('resize-friendly terminal repaint');
    } finally {
      await stopFixture(fixture.child);
    }

    expect(fixture.getStderr()).toBe('');
  });
});
