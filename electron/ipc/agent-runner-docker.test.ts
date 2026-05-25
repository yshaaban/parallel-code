import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDockerAgentRunnerLabels,
  createDockerAgentRunnerLaunch,
} from './agent-runner-docker.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn((command, args = []) => {
    if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          'com.parallel-code.agent-id': 'agent-1',
          'com.parallel-code.managed': 'true',
          'com.parallel-code.provider': 'docker-container',
          'com.parallel-code.resource': 'agent-runner',
          'com.parallel-code.task-id': 'task-1',
        }),
      };
    }

    return { status: 0, stderr: '', stdout: 'ok' };
  }),
}));

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
  return vi
    .mocked(spawnSync)
    .mock.calls.find(
      ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'build',
    );
}

describe('agent-runner-docker', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })),
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
    const launch = createDockerAgentRunnerLaunch({
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
    const launch = createDockerAgentRunnerLaunch({
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

    expect(() =>
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
    ).toThrow('agentRunnerProfile.env.PATH is not allowed for Docker agent runners');
  });

  it('rejects invalid profile env keys', async () => {
    const worktreePath = await createTempDir();

    expect(() =>
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
    ).toThrow('agentRunnerProfile.env.BAD-NAME must be a valid environment variable name');
  });

  it('rejects unsafe profile env allowlist entries', async () => {
    const worktreePath = await createTempDir();

    expect(() =>
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
    ).toThrow('agentRunnerProfile.envAllowlist is not allowed for Docker agent runners');
  });

  it('validates profile env before building Dockerfile images', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');

    expect(() =>
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
    ).toThrow('agentRunnerProfile.env.PATH is not allowed for Docker agent runners');
    expect(getDockerBuildCall()).toBeUndefined();
  });

  it('validates extra mounts before building Dockerfile images', async () => {
    const worktreePath = await createTempDir();
    const ambiguousMountPath = await createTempDirWithPrefix('parallel-agent-runner-mount,-');
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');

    expect(() =>
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
    ).toThrow('agentRunnerProfile.mounts.source must not contain "," or "="');
    expect(getDockerBuildCall()).toBeUndefined();
  });

  it('rejects Dockerfile symlinks that resolve outside the worktree', async () => {
    const worktreePath = await createTempDir();
    const outsidePath = await createTempDir();
    await fs.promises.writeFile(path.join(outsidePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    await fs.promises.symlink(
      path.join(outsidePath, 'Dockerfile'),
      path.join(worktreePath, 'Dockerfile'),
    );

    expect(() =>
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
    ).toThrow('Dockerfile must stay inside the task worktree');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('fails clearly when a configured Dockerfile is missing', async () => {
    const worktreePath = await createTempDir();
    const dockerfilePath = path.join(worktreePath, 'Dockerfile');

    expect(() =>
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
    ).toThrow(`Dockerfile does not exist: ${dockerfilePath}`);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('keeps Dockerfile paths behind relative-path validation', async () => {
    const worktreePath = await createTempDir();
    const dockerfilePath = path.join(worktreePath, 'Dockerfile');
    await fs.promises.writeFile(dockerfilePath, 'FROM busybox\n', 'utf8');

    expect(() =>
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
    ).toThrow('agentRunnerProfile.dockerfile must not be absolute');
    expect(() =>
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
    ).toThrow('agentRunnerProfile.dockerfile must not contain ".."');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('uses a stable container workspace default instead of the host worktree path', async () => {
    const worktreePath = await createTempDir();
    const launch = createDockerAgentRunnerLaunch({
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

    expect(() =>
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: { provider: 'docker-container' },
        taskId: 'task-1',
      }),
    ).toThrow('Docker agent runner requires an image or dockerfile');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('fails fast when Docker availability checks time out', async () => {
    const worktreePath = await createTempDir();
    vi.mocked(spawnSync).mockReturnValueOnce({
      error: new Error('spawnSync docker ETIMEDOUT'),
      status: null,
      stderr: '',
      stdout: '',
    } as ReturnType<typeof spawnSync>);

    expect(() =>
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: { image: 'agent:latest', provider: 'docker-container' },
        taskId: 'task-1',
      }),
    ).toThrow('Docker is unavailable: spawnSync docker ETIMEDOUT');
  });

  it('rejects bind mount values that Docker would parse ambiguously', async () => {
    const worktreePath = await createTempDirWithPrefix('parallel-agent-runner-comma,-');

    expect(() =>
      createDockerAgentRunnerLaunch({
        agentId: 'agent-1',
        args: [],
        command: 'codex',
        cwd: worktreePath,
        env: {},
        profile: { image: 'agent:latest', provider: 'docker-container' },
        taskId: 'task-1',
      }),
    ).toThrow('cwd must not contain "," or "="');
  });

  it('removes the exact managed container on cleanup', async () => {
    const worktreePath = await createTempDir();
    const launch = createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    vi.mocked(spawnSync).mockImplementation((command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify(launch.identity.labels),
        } as ReturnType<typeof spawnSync>;
      }

      return { status: 0, stderr: '', stdout: 'ok' } as ReturnType<typeof spawnSync>;
    });

    launch.cleanup();

    const rmCall = vi
      .mocked(spawnSync)
      .mock.calls.find(
        ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
      );
    expect(rmCall).toBeTruthy();
    expect(rmCall?.[1]).toContain('--force');
    expect(rmCall?.[1]).toContain(launch.identity.containerName);
    for (const [command, _args, options] of vi.mocked(spawnSync).mock.calls) {
      if (command !== 'docker') {
        continue;
      }

      expect(options).toMatchObject({
        stdio: 'pipe',
        timeout: 5_000,
      });
    }
  });

  it('throws when exact managed container cleanup fails', async () => {
    const worktreePath = await createTempDir();
    const launch = createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    vi.mocked(spawnSync).mockImplementation((command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify(launch.identity.labels),
        } as ReturnType<typeof spawnSync>;
      }
      if (command === 'docker' && args[0] === 'rm') {
        return {
          status: 1,
          stderr: 'permission denied',
          stdout: '',
        } as ReturnType<typeof spawnSync>;
      }

      return { status: 0, stderr: '', stdout: 'ok' } as ReturnType<typeof spawnSync>;
    });

    expect(() => launch.cleanup()).toThrow('permission denied');
  });

  it('removes Dockerfile-built image tags during cleanup', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    const launch = createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });
    vi.mocked(spawnSync).mockImplementation((command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify(launch.identity.labels),
        } as ReturnType<typeof spawnSync>;
      }

      return { status: 0, stderr: '', stdout: 'ok' } as ReturnType<typeof spawnSync>;
    });

    launch.cleanup();

    const imageRmCall = vi
      .mocked(spawnSync)
      .mock.calls.find(
        ([command, args]) =>
          command === 'docker' && Array.isArray(args) && args[0] === 'image' && args[1] === 'rm',
      );
    expect(imageRmCall?.[1]).toContain(launch.identity.imageRef);
  });

  it('creates per-runner image tags for repeated Dockerfile launches', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');

    const firstLaunch = createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });
    const secondLaunch = createDockerAgentRunnerLaunch({
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
  });

  it('removes a built image even when the managed container is already gone', async () => {
    const worktreePath = await createTempDir();
    await fs.promises.writeFile(path.join(worktreePath, 'Dockerfile'), 'FROM busybox\n', 'utf8');
    const launch = createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-1',
    });
    vi.mocked(spawnSync).mockImplementation((command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          status: 1,
          stderr: 'No such container',
          stdout: '',
        } as ReturnType<typeof spawnSync>;
      }

      return { status: 0, stderr: '', stdout: 'ok' } as ReturnType<typeof spawnSync>;
    });

    launch.cleanup();

    const rmCall = vi
      .mocked(spawnSync)
      .mock.calls.find(
        ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
      );
    const imageRmCall = vi
      .mocked(spawnSync)
      .mock.calls.find(
        ([command, args]) =>
          command === 'docker' && Array.isArray(args) && args[0] === 'image' && args[1] === 'rm',
      );
    expect(rmCall).toBeUndefined();
    expect(imageRmCall?.[1]).toContain(launch.identity.imageRef);
  });

  it('does not remove a container when exact managed labels do not match', async () => {
    vi.mocked(spawnSync).mockImplementation((command, args = []) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            'com.parallel-code.agent-id': 'foreign-agent',
            'com.parallel-code.managed': 'true',
            'com.parallel-code.provider': 'docker-container',
            'com.parallel-code.resource': 'agent-runner',
            'com.parallel-code.task-id': 'task-1',
          }),
        } as ReturnType<typeof spawnSync>;
      }

      return { status: 0, stderr: '', stdout: 'ok' } as ReturnType<typeof spawnSync>;
    });
    const worktreePath = await createTempDir();
    const launch = createDockerAgentRunnerLaunch({
      agentId: 'agent-1',
      args: [],
      command: 'codex',
      cwd: worktreePath,
      env: {},
      profile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });

    launch.cleanup();

    const rmCall = vi
      .mocked(spawnSync)
      .mock.calls.find(
        ([command, args]) => command === 'docker' && Array.isArray(args) && args[0] === 'rm',
      );
    expect(rmCall).toBeUndefined();
  });
});
