import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentCliBurstChunks,
  createCodeBurstChunks,
  createDiffBurstChunks,
  createMarkdownBurstChunks,
} from '../../src/lib/terminal-workload-fixtures';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SESSION_STRESS_AGENT_ENTRY = path.resolve(
  PROJECT_ROOT,
  'scripts',
  'fixtures',
  'session-stress-agent.mjs',
);

interface SpawnFixtureResult {
  child: ReturnType<typeof spawn>;
  close: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  getStdout: () => string;
}

const activeChildren = new Set<ReturnType<typeof spawn>>();

const textDecoder = new TextDecoder();

function spawnFixture(args: string[]): SpawnFixtureResult {
  const child = spawn(process.execPath, [SESSION_STRESS_AGENT_ENTRY, ...args], {
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

  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        activeChildren.delete(child);
        if (code !== 0) {
          reject(
            new Error(
              stderr.trim().length > 0
                ? `session-stress-agent exited with code ${code ?? 'null'}: ${stderr.trim()}`
                : `session-stress-agent exited with code ${code ?? 'null'}`,
            ),
          );
          return;
        }
        resolve({ code, signal });
      });
    },
  );

  return {
    child,
    close,
    getStdout: () => stdout,
  };
}

function decodeChunks(chunks: Uint8Array[]): string {
  return chunks.map((chunk) => textDecoder.decode(chunk)).join('');
}

async function waitForOutputMatch(
  getStdout: () => string,
  pattern: RegExp,
  timeoutMs = 2_000,
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

afterEach(async () => {
  await Promise.all(
    Array.from(activeChildren, (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        activeChildren.delete(child);
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        child.once('close', () => {
          activeChildren.delete(child);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }),
  );
});

describe('session-stress-agent fixture', () => {
  it('honors CLI numeric workload arguments', async () => {
    const fixture = spawnFixture(['--style', 'lines', '--line-count', '3', '--line-bytes', '4']);
    await fixture.close;

    expect(fixture.getStdout()).toContain('stress-output:1:XXXX');
    expect(fixture.getStdout()).toContain('stress-output:2:XXXX');
    expect(fixture.getStdout()).toContain('stress-output:3:XXXX');
  });

  it.each([
    ['markdown-burst', /# markdown-burst incident 001\/001/u, /```md/u],
    ['code-burst', /function code_burstSection001\(\) \{/u, /class CodeBurstReporter/u],
    ['diff-burst', /diff --git a\/diff-burst\.txt b\/diff-burst\.txt/u, /@@ -1,4 \+1,4 @@/u],
    [
      'agent-cli-burst',
      /> agent-cli-burst task 001\/001/u,
      /\$ agent-cli --label agent-cli-burst --section 1/u,
    ],
  ])('emits %s verbose burst output from the CLI fixture', async (style, expected, secondary) => {
    const fixture = spawnFixture([
      '--style',
      style,
      '--paragraph-count',
      '1',
      '--paragraph-bytes',
      '32',
      '--line-count',
      '1',
      '--line-bytes',
      '32',
    ]);

    await fixture.close;

    expect(fixture.getStdout()).toMatch(expected);
    expect(fixture.getStdout()).toMatch(secondary);
  });

  it('waits for the start gate after announcing readiness', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-stress-agent-'));
    const startGateFile = path.join(tempDir, 'start-gate');
    try {
      const fixture = spawnFixture([
        '--style',
        'lines',
        '--line-count',
        '2',
        '--line-bytes',
        '4',
        '--ready-marker',
        'READY',
        '--start-gate-file',
        startGateFile,
      ]);

      const beforeGate = await waitForOutputMatch(fixture.getStdout, /READY/u);
      expect(beforeGate).not.toContain('stress-output:1:XXXX');

      await writeFile(startGateFile, 'start\n', 'utf8');
      await fixture.close;

      expect(fixture.getStdout()).toContain('READY');
      expect(fixture.getStdout()).toContain('stress-output:1:XXXX');
      expect(fixture.getStdout()).toContain('stress-output:2:XXXX');
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it('builds verbose burst chunks in the shared fixture library', () => {
    const markdown = decodeChunks(
      createMarkdownBurstChunks({
        label: 'markdown-burst',
        sectionBytes: 32,
        sectionCount: 1,
      }),
    );
    const code = decodeChunks(
      createCodeBurstChunks({
        label: 'code-burst',
        sectionBytes: 32,
        sectionCount: 1,
      }),
    );
    const diff = decodeChunks(
      createDiffBurstChunks({
        label: 'diff-burst',
        sectionBytes: 32,
        sectionCount: 1,
      }),
    );
    const agentCli = decodeChunks(
      createAgentCliBurstChunks({
        label: 'agent-cli-burst',
        sectionBytes: 32,
        sectionCount: 1,
      }),
    );

    expect(markdown).toContain('# markdown-burst incident 001/001');
    expect(markdown).toContain('```md');
    expect(code).toContain('function code_burstSection001() {');
    expect(code).toContain('class CodeBurstReporter {');
    expect(diff).toContain('diff --git a/diff-burst.txt b/diff-burst.txt');
    expect(diff).toContain('@@ -1,4 +1,4 @@');
    expect(agentCli).toContain('> agent-cli-burst task 001/001');
    expect(agentCli).toContain('$ agent-cli --label agent-cli-burst --section 1');
  });
});
