import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IPC } from '../../electron/ipc/channels.js';
import { createInteractiveNodeScenario } from '../browser/harness/scenarios.js';
import {
  parseStandaloneServerReadyOutput,
  startStandaloneBrowserServer,
} from '../browser/harness/standalone-server.js';

function listenOnPort(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function occupyPortIfAvailable(port: number): Promise<Server | null> {
  try {
    return await listenOnPort(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      return null;
    }

    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe('browser-lab standalone server startup', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const dispose = cleanup.pop();
      if (!dispose) {
        continue;
      }

      await dispose();
    }
  });

  it('starts on an ephemeral port even when 3000 is already occupied', async () => {
    const blocker = await occupyPortIfAvailable(3000);
    if (blocker) {
      cleanup.push(() => closeServer(blocker));
    }

    const server = await startStandaloneBrowserServer({
      scenario: createInteractiveNodeScenario(),
      testSlug: 'ephemeral-port-startup',
      validateBrowserBuildArtifacts: false,
    });
    cleanup.push(() => server.stop());

    expect(server.port).not.toBe(3000);
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it('accepts authenticated browser IPC requests after startup', async () => {
    const server = await startStandaloneBrowserServer({
      scenario: createInteractiveNodeScenario(),
      testSlug: 'auth-ipc-startup',
      validateBrowserBuildArtifacts: false,
    });
    cleanup.push(() => server.stop());

    const response = await fetch(`${server.baseUrl}/api/ipc/${IPC.LoadAppState}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.authToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      result: string | null;
    };
    const savedState = JSON.parse(payload.result ?? 'null') as {
      tasks?: Record<string, { branchName?: string }>;
    };
    expect(savedState.tasks?.[server.taskId]?.branchName).toBe('main');
  });

  it('parses readiness output after stdout chunks are reassembled', () => {
    const output =
      'Booting browser server\nParallel Code server li' +
      'stening on http://127.0.0.1:43123?token=test-token\n';

    expect(parseStandaloneServerReadyOutput(output)).toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      port: 43123,
    });
  });

  it('ignores incomplete readiness output until the full line is available', () => {
    expect(
      parseStandaloneServerReadyOutput('Parallel Code server listening on http://127.0.0.1:'),
    ).toBeNull();
  });

  it('rejects malformed readiness lines that omit the explicit bound port', () => {
    expect(() =>
      parseStandaloneServerReadyOutput('Parallel Code server listening on http://127.0.0.1:\n'),
    ).toThrow('Failed to parse standalone browser server port');
  });

  it('cleans the test directory when setup fails before the server starts', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-lab-failure-'));
    cleanup.push(() => rm(rootDir, { recursive: true, force: true }));
    const expectedTestDir = path.join(rootDir, 'seed-failure-cleanup');

    await expect(
      startStandaloneBrowserServer({
        rootDir,
        scenario: {
          ...createInteractiveNodeScenario(),
          seedRepo() {
            throw new Error('seed failed');
          },
        },
        testSlug: 'seed-failure-cleanup',
        validateBrowserBuildArtifacts: false,
      }),
    ).rejects.toThrow('seed failed');

    expect(await pathExists(expectedTestDir)).toBe(false);
  });
});
