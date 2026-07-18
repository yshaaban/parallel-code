import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as pty from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';

import { runIndependentCleanups } from '../../scripts/lib/cleanup-outcome.mjs';
import { createDockerAgentRunnerLaunch } from './agent-runner-docker.js';

const RUN_DOCKER_AGENT_INTEGRATION = process.env.RUN_DOCKER_AGENT_INTEGRATION === '1';
const dockerReady = RUN_DOCKER_AGENT_INTEGRATION && isDockerAvailable();
const describeDockerIntegration = dockerReady ? describe : describe.skip;
const tempDirs: string[] = [];

interface PtyRunResult {
  exitCode: number | null;
  output: string;
  signal: number | undefined;
}

function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['version'], {
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 5_000,
  });
  return result.status === 0 && !result.error;
}

function getProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

async function createTempDir(prefix: string): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dirPath);
  return dirPath;
}

function runPtyCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  },
): Promise<PtyRunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const proc = pty.spawn(command, args, {
      cols: 80,
      cwd: options.cwd,
      env: options.env,
      rows: 24,
    });
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      proc.kill();
      reject(new Error(`Timed out waiting for ${command}`));
    }, options.timeoutMs);

    proc.onData((data) => {
      output += data;
    });
    proc.onExit(({ exitCode, signal }) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output, signal });
    });
  });
}

describeDockerIntegration('agent runner docker integration', () => {
  afterEach(async () => {
    await runIndependentCleanups(
      'Docker agent runner integration temporary directories',
      tempDirs
        .splice(0)
        .map(
          (dirPath, index) =>
            [
              `remove Docker agent runner integration temporary directory ${index + 1}`,
              () => fs.promises.rm(dirPath, { force: true, recursive: true }),
            ] as const,
        ),
    );
  }, 60_000);

  it('runs an agent command inside the mounted Docker worktree and cleans up the container', async () => {
    const worktreePath = await createTempDir('parallel-agent-runner-worktree-');
    await fs.promises.writeFile(path.join(worktreePath, 'marker.txt'), 'mounted-worktree', 'utf8');

    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-docker-integration',
      args: ['-lc', 'printf "cwd:%s\\nmarker:%s\\n" "$PWD" "$(cat marker.txt)"'],
      command: '/bin/sh',
      cwd: worktreePath,
      env: {},
      profile: {
        image: 'busybox:1.36.1',
        provider: 'docker-container',
        workspaceMountTarget: '/workspace',
      },
      taskId: 'task-docker-integration',
    });

    try {
      const result = await runPtyCommand(launch.command, launch.args, {
        cwd: launch.cwd,
        env: { ...getProcessEnv(), ...launch.env },
        timeoutMs: 45_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.signal ?? 0).toBe(0);
      expect(result.output).toContain('cwd:/workspace');
      expect(result.output).toContain('marker:mounted-worktree');
    } finally {
      await launch.cleanup();
    }

    const inspect = spawnSync(
      'docker',
      ['container', 'inspect', launch.identity.containerName ?? ''],
      { encoding: 'utf8', stdio: 'ignore', timeout: 5_000 },
    );
    expect(inspect.status).not.toBe(0);
  }, 90_000);
});
