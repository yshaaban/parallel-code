import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runIndependentCleanups } from '../../scripts/lib/cleanup-outcome.mjs';

const { execFileWithDeadlineMock } = vi.hoisted(() => ({
  execFileWithDeadlineMock: vi.fn(),
}));

vi.mock('./bounded-process.js', () => ({
  execFileWithDeadline: execFileWithDeadlineMock,
}));

import {
  cleanupPendingDockerAgentRunnerBuilds,
  createDockerAgentRunnerLabels,
  createDockerAgentRunnerLaunch,
  DOCKER_BUILD_TIMEOUT_MS,
  DOCKER_CLEANUP_TIMEOUT_MS,
  DOCKER_QUERY_TIMEOUT_MS,
} from './agent-runner-docker.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'parallel-agent-runner-'));
  tempDirs.push(dirPath);
  return dirPath;
}

async function createTempDirWithPrefix(prefix: string): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dirPath);
  return dirPath;
}

function getDockerEnvAssignments(args: string[]): string[] {
  const assignments: string[] = [];
  args.forEach((arg, index) => {
    if (arg === '--env') {
      assignments.push(args[index + 1] ?? '');
    }
  });
  return assignments;
}

function getDockerBuildCall(): unknown[] | undefined {
  return execFileWithDeadlineMock.mock.calls.find(
    ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'build',
  );
}

function createCommandError(message: string, stderr = '', stdout = ''): Error {
  return Object.assign(new Error(message), { stderr, stdout });
}

describe('agent-runner-docker', () => {
  beforeEach(() => {
    execFileWithDeadlineMock.mockReset();
    execFileWithDeadlineMock.mockResolvedValue({ stderr: '', stdout: 'ok' });
  });

  afterEach(async () => {
    execFileWithDeadlineMock.mockResolvedValue({ stderr: '', stdout: 'ok' });
    await cleanupPendingDockerAgentRunnerBuilds().catch(() => undefined);
    await runIndependentCleanups(
      'Docker agent runner test temporary directories',
      tempDirs
        .splice(0)
        .map(
          (dirPath, index) =>
            [
              `remove Docker agent runner temporary directory ${index + 1}`,
              () => fs.promises.rm(dirPath, { force: true, recursive: true }),
            ] as const,
        ),
    );
  });

  it('creates exact managed labels for cleanup identity', () => {
    expect(
      createDockerAgentRunnerLabels(
        'task-1',
        'agent-1',
        { image: 'agent:latest', provider: 'docker-container' },
        'runner-1',
        '2026-05-24T00:00:00.000Z',
      ),
    ).toMatchObject({
      'com.parallel-code.agent-id': 'agent-1',
      'com.parallel-code.managed': 'true',
      'com.parallel-code.provider': 'docker-container',
      'com.parallel-code.resource': 'agent-runner',
      'com.parallel-code.runner-instance-id': 'runner-1',
      'com.parallel-code.task-id': 'task-1',
    });
  });

  it('builds docker run args with labels, bind mount, env, and resource options', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: ['--flag'],
      command: 'codex',
      cwd: worktreePath,
      env: { PARALLEL_CODE_HYDRA_STARTUP_MODE: 'auto' },
      profile: {
        env: { FOO: 'bar' },
        image: 'agent:latest',
        network: { mode: 'none' },
        provider: 'docker-container',
        resources: { cpus: '2', memory: '4g' },
        workspaceMountTarget: '/workspace',
      },
      taskId: 'task-1',
    });

    expect(launch.command).toBe('docker');
    expect(launch.args).toContain('run');
    expect(launch.args).toContain('--rm');
    expect(launch.args).toContain('--name');
    expect(launch.args).toContain('--label');
    expect(launch.args).toContain('com.parallel-code.managed=true');
    expect(launch.args).toContain('--mount');
    expect(launch.args).toContain(`type=bind,src=${worktreePath},dst=/workspace`);
    expect(launch.args).toContain('--env');
    expect(launch.args).toContain('FOO=bar');
    expect(launch.args).toContain('PARALLEL_CODE_HYDRA_STARTUP_MODE=auto');
    expect(launch.args).toContain('--cpus');
    expect(launch.args).toContain('2');
    expect(launch.args).toContain('--memory');
    expect(launch.args).toContain('4g');
    expect(launch.args.slice(-3)).toEqual(['agent:latest', 'codex', '--flag']);
    expect(launch.identity.provider).toBe('docker-container');
  });

  it('filters unsafe launch env values before building docker run args', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {
        'BAD-NAME': 'ignored',
        NODE_OPTIONS: '--require injected.js',
        PARALLEL_CODE_HYDRA_STARTUP_MODE: 'auto',
        PATH: '/tmp/injected',
      },
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });

    const dockerEnv = getDockerEnvAssignments(launch.args);
    expect(dockerEnv).toContain('PARALLEL_CODE_HYDRA_STARTUP_MODE=auto');
    expect(dockerEnv).not.toContain('BAD-NAME=ignored');
    expect(dockerEnv).not.toContain('NODE_OPTIONS=--require injected.js');
    expect(dockerEnv).not.toContain('PATH=/tmp/injected');
  });

  it('rejects unsafe profile env keys', async () => {
    const worktreePath = await createTempDir();

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          env: { PATH: '/tmp/injected' },
          image: 'agent:latest',
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.env.PATH is not allowed for Docker agent runners');
  });

  it('rejects invalid profile env keys', async () => {
    const worktreePath = await createTempDir();

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          env: { 'BAD-NAME': 'value' },
          image: 'agent:latest',
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.env.BAD-NAME must be a valid environment variable name');
  });

  it('rejects unsafe profile env allowlist entries', async () => {
    const worktreePath = await createTempDir();

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          envAllowlist: ['PATH'],
          image: 'agent:latest',
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.envAllowlist is not allowed for Docker agent runners');
  });

  it('validates profile env before building Dockerfile images', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          dockerfile: 'Dockerfile',
          env: { PATH: '/tmp/injected' },
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.env.PATH is not allowed for Docker agent runners');
    expect(getDockerBuildCall()).toBeUndefined();
  });

  it('validates extra mounts before building Dockerfile images', async () => {
    const worktreePath = await createTempDir();
    const ambiguousMountPath = await createTempDirWithPrefix('parallel-agent-runner-mount,-');
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          dockerfile: 'Dockerfile',
          mounts: [{ source: ambiguousMountPath, target: '/docs' }],
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.mounts.source must not contain "," or "="');
    expect(getDockerBuildCall()).toBeUndefined();
  });

  it('rejects extra bind mounts outside the task worktree', async () => {
    const worktreePath = await createTempDir();
    const outsidePath = await createTempDir();

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          image: 'agent:latest',
          mounts: [{ source: outsidePath, target: '/outside' }],
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.mounts.source must stay inside the task worktree');
    expect(execFileWithDeadlineMock).not.toHaveBeenCalled();
  });

  it('rejects extra bind mount symlinks that resolve outside the worktree', async () => {
    const worktreePath = await createTempDir();
    const outsidePath = await createTempDir();
    const symlinkPath = path.join(worktreePath, 'outside-link');
    await fs.promises.symlink(outsidePath, symlinkPath);

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          image: 'agent:latest',
          mounts: [{ source: symlinkPath, target: '/outside' }],
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.mounts.source must stay inside the task worktree');
    expect(execFileWithDeadlineMock).not.toHaveBeenCalled();
  });

  it('rejects Dockerfile symlinks that resolve outside the worktree', async () => {
    const worktreePath = await createTempDir();
    const outsidePath = await createTempDir();
    await fs.promises.writeFile(path.join(outsidePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    await fs.promises.symlink(
      path.join(outsidePath, 'Dockerfile'),
      path.join(worktreePath, 'Dockerfile'),
    );

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          dockerfile: 'Dockerfile',
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('Dockerfile must stay inside the task worktree');
    expect(execFileWithDeadlineMock).not.toHaveBeenCalled();
  });

  it('fails clearly when a configured Dockerfile is missing', async () => {
    const worktreePath = await createTempDir();
    const dockerfilePath = path.join(worktreePath, 'Dockerfile');

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          dockerfile: 'Dockerfile',
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow(`Dockerfile does not exist: ${dockerfilePath}`);
    expect(execFileWithDeadlineMock).not.toHaveBeenCalled();
  });

  it('keeps Dockerfile paths behind relative-path validation', async () => {
    const worktreePath = await createTempDir();
    const dockerfilePath = path.join(worktreePath, 'Dockerfile');
    await fs.promises.writeFile(dockerfilePath, 'FROM busybox\n', 'utf8');

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          dockerfile: dockerfilePath,
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.dockerfile must not be absolute');
    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: {
          dockerfile: '../Dockerfile',
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('agentRunnerProfile.dockerfile must not contain ".."');
    expect(execFileWithDeadlineMock).not.toHaveBeenCalled();
  });

  it('uses a stable container workspace default instead of the host worktree path', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });

    expect(launch.args).toContain(`type=bind,src=${worktreePath},dst=/workspace`);
    expect(launch.args).toContain('--workdir');
    expect(launch.args).toContain('/workspace');
  });

  it('rejects missing image and dockerfile before spawning docker run', async () => {
    const worktreePath = await createTempDir();

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: { provider: 'docker-container' },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('Docker agent runner requires an image or dockerfile');
    expect(execFileWithDeadlineMock).not.toHaveBeenCalled();
  });

  it('fails fast when Docker availability checks time out', async () => {
    const worktreePath = await createTempDir();
    execFileWithDeadlineMock.mockRejectedValueOnce(
      createCommandError('docker subprocess timed out after 5000ms'),
    );

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: { image: 'agent:latest', provider: 'docker-container' },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('Docker is unavailable: docker subprocess timed out after 5000ms');
  });

  it('rejects bind mount values that Docker would parse ambiguously', async () => {
    const worktreePath = await createTempDirWithPrefix('parallel-agent-runner-comma,-');

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: { image: 'agent:latest', provider: 'docker-container' },
        taskId: 'task-1',
      }),
    ).rejects.toThrow('cwd must not contain "," or "="');
  });

  it('idempotently removes the exact managed container on cleanup', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          stderr: '',
          stdout: JSON.stringify({
            ...launch.identity.labels,
            'com.parallel-code.image-metadata': 'allowed-extra-label',
          }),
        };
      }

      return { stderr: '', stdout: 'ok' };
    });

    await Promise.all([launch.cleanup(), launch.cleanup()]);

    const rmCall = execFileWithDeadlineMock.mock.calls.find(
      ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
    );
    expect(rmCall).toBeTruthy();
    expect(
      execFileWithDeadlineMock.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === 'container' && args[1] === 'inspect',
      ),
    ).toHaveLength(1);
    expect(
      execFileWithDeadlineMock.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === 'rm',
      ),
    ).toHaveLength(1);
    expect(rmCall?.[1]).toContain('--force');
    expect(rmCall?.[1]).toContain(launch.identity.containerName);
    for (const [command, args, options] of execFileWithDeadlineMock.mock.calls) {
      if (command !== 'docker') {
        continue;
      }

      expect(options).toMatchObject({ encoding: 'utf8' });
      expect(options.timeoutMs).toBe(
        args[0] === 'rm' ? DOCKER_CLEANUP_TIMEOUT_MS : DOCKER_QUERY_TIMEOUT_MS,
      );
    }
  });

  it('throws when exact managed container cleanup fails', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    let removeAttempts = 0;
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          stderr: '',
          stdout: JSON.stringify(launch.identity.labels),
        };
      }
      if (command === 'docker' && args[0] === 'rm') {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw createCommandError('docker exited with code 1', 'permission denied');
        }
      }

      return { stderr: '', stdout: 'ok' };
    });

    await expect(launch.cleanup()).rejects.toThrow('permission denied');
    await expect(launch.cleanup()).resolves.toBeUndefined();
    expect(removeAttempts).toBe(2);
  });

  it('still removes a built image when managed container removal fails', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return { stderr: '', stdout: JSON.stringify(launch.identity.labels) };
      }
      if (command === 'docker' && args[0] === 'rm') {
        throw createCommandError('docker exited with code 1', 'container removal failed');
      }
      return { stderr: '', stdout: 'ok' };
    });

    await expect(launch.cleanup()).rejects.toThrow('container removal failed');
    expect(
      execFileWithDeadlineMock.mock.calls.some(
        ([command, args]) =>
          command === 'docker' && Array.isArray(args) && args[0] === 'image' && args[1] === 'rm',
      ),
    ).toBe(true);
  });

  it('treats already-removed image and container resources as idempotent cleanup success', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });
    let containerRemoveAttempts = 0;
    let imageRemoveAttempts = 0;
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return { stderr: '', stdout: JSON.stringify(launch.identity.labels) };
      }
      if (command === 'docker' && args[0] === 'rm') {
        containerRemoveAttempts += 1;
        if (containerRemoveAttempts === 1) {
          throw createCommandError('docker exited with code 1', 'container removal failed');
        }
      }
      if (command === 'docker' && args[0] === 'image' && args[1] === 'rm') {
        imageRemoveAttempts += 1;
        if (imageRemoveAttempts === 2) {
          throw createCommandError('docker exited with code 1', 'Error: No such image: old-tag');
        }
      }
      return { stderr: '', stdout: 'ok' };
    });

    await expect(launch.cleanup()).rejects.toThrow('container removal failed');
    await expect(launch.cleanup()).resolves.toBeUndefined();
    expect(containerRemoveAttempts).toBe(2);
    expect(imageRemoveAttempts).toBe(2);
  });

  it('tolerates a managed container disappearing between inspect and removal', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return { stderr: '', stdout: JSON.stringify(launch.identity.labels) };
      }
      if (command === 'docker' && args[0] === 'rm') {
        throw createCommandError(
          'docker exited with code 1',
          'Error: No such container: old-runner',
        );
      }
      return { stderr: '', stdout: 'ok' };
    });

    await expect(launch.cleanup()).resolves.toBeUndefined();
  });

  it('retains a failed partial-build image cleanup for task-owned retry', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    let imageCleanupAttempts = 0;
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'build') {
        throw createCommandError('build aborted', 'build cancelled');
      }
      if (command === 'docker' && args[0] === 'image' && args[1] === 'rm') {
        imageCleanupAttempts += 1;
        if (imageCleanupAttempts === 1) {
          throw createCommandError('daemon unavailable');
        }
      }
      return { stderr: '', stdout: 'ok' };
    });

    await expect(
      createDockerAgentRunnerLaunch({
        agentId: 'agent-partial-build',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
        taskId: 'task-partial-build',
      }),
    ).rejects.toThrow('image cleanup also failed');
    await expect(
      cleanupPendingDockerAgentRunnerBuilds({ taskId: 'task-partial-build' }),
    ).resolves.toBeUndefined();
    expect(imageCleanupAttempts).toBe(2);
  });

  it('reports inspect failures and retries instead of memoizing false cleanup success', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    let inspectAttempts = 0;
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        inspectAttempts += 1;
        if (inspectAttempts === 1) {
          throw createCommandError('docker subprocess timed out after 5000ms');
        }
        return { stderr: '', stdout: JSON.stringify(launch.identity.labels) };
      }
      return { stderr: '', stdout: 'ok' };
    });

    await expect(launch.cleanup()).rejects.toThrow('Docker container inspect failed');
    await expect(launch.cleanup()).resolves.toBeUndefined();
    expect(inspectAttempts).toBe(2);
    expect(
      execFileWithDeadlineMock.mock.calls.filter(
        ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
      ),
    ).toHaveLength(1);
  });

  it('rejects malformed inspect labels without deleting an unverified container', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return { stderr: '', stdout: '{not-json' };
      }
      return { stderr: '', stdout: 'ok' };
    });

    await expect(launch.cleanup()).rejects.toThrow('returned invalid labels');
    expect(
      execFileWithDeadlineMock.mock.calls.some(
        ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
      ),
    ).toBe(false);
  });

  it('rejects non-object inspect labels without deleting an unverified container', async () => {
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return { stderr: '', stdout: '[]' };
      }
      return { stderr: '', stdout: 'ok' };
    });

    await expect(launch.cleanup()).rejects.toThrow('returned invalid labels');
    expect(
      execFileWithDeadlineMock.mock.calls.some(
        ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
      ),
    ).toBe(false);
  });

  it('removes Dockerfile-built image tags during cleanup', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          stderr: '',
          stdout: JSON.stringify(launch.identity.labels),
        };
      }

      return { stderr: '', stdout: 'ok' };
    });

    await launch.cleanup();

    const imageRmCall = execFileWithDeadlineMock.mock.calls.find(
      ([command, args]) =>
        command === 'docker' && Array.isArray(args) && args[0] === 'image' && args[1] === 'rm',
    );
    expect(imageRmCall?.[1]).toContain(launch.identity.imageRef);
  });

  it('creates per-runner image tags for repeated Dockerfile launches', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');

    const firstLaunch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });
    const secondLaunch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-2',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });

    expect(firstLaunch.identity.imageRef).toMatch(/^parallel-code-agent-/u);
    expect(secondLaunch.identity.imageRef).toMatch(/^parallel-code-agent-/u);
    expect(firstLaunch.identity.imageRef).not.toBe(secondLaunch.identity.imageRef);
    const buildCalls = execFileWithDeadlineMock.mock.calls.filter(
      ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'build',
    );
    expect(buildCalls).toHaveLength(2);
    for (const [, , options] of buildCalls) {
      expect(options).toMatchObject({
        cwd: worktreePath,
        maxBuffer: 16 * 1024 * 1024,
        timeoutMs: DOCKER_BUILD_TIMEOUT_MS,
      });
    }
  });

  it('removes a built image even when the managed container is already gone', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        throw createCommandError('docker exited with code 1', 'No such container');
      }

      return { stderr: '', stdout: 'ok' };
    });

    await launch.cleanup();

    const rmCall = execFileWithDeadlineMock.mock.calls.find(
      ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
    );
    const imageRmCall = execFileWithDeadlineMock.mock.calls.find(
      ([command, args]) =>
        command === 'docker' && Array.isArray(args) && args[0] === 'image' && args[1] === 'rm',
    );
    expect(rmCall).toBeUndefined();
    expect(imageRmCall?.[1]).toContain(launch.identity.imageRef);
  });

  it('does not remove a container when exact managed labels do not match', async () => {
    execFileWithDeadlineMock.mockImplementation(async (command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          stderr: '',
          stdout: JSON.stringify({
            'com.parallel-code.agent-id': 'foreign-agent',
            'com.parallel-code.managed': 'true',
            'com.parallel-code.provider': 'docker-container',
            'com.parallel-code.resource': 'agent-runner',
            'com.parallel-code.task-id': 'task-1',
          }),
        };
      }

      return { stderr: '', stdout: 'ok' };
    });
    const worktreePath = await createTempDir();
    const launch = await createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });

    await launch.cleanup();

    const rmCall = execFileWithDeadlineMock.mock.calls.find(
      ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
    );
    expect(rmCall).toBeUndefined();
  });
});
