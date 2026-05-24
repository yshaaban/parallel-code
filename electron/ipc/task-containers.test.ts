import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProjectContainerConfig,
  TaskContainerIssue,
} from '../../src/domain/task-containers.js';
import {
  clearTaskContainerPreviewTargets,
  type TaskContainerRuntime,
  getTaskContainerLogs,
  hasTaskContainerPreviewTarget,
  inspectTaskContainers,
  removeTaskContainerPreviewTargets,
  resolveTaskContainerPreviewTarget,
  startTaskContainers,
  stopTaskContainers,
  destroyTaskContainers,
  __taskContainerTestExports,
} from './task-containers.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dirPath);
  return dirPath;
}

async function createComposeWorktree(
  fileNames: string[] = ['compose.yaml'],
): Promise<{ userDataPath: string; worktreePath: string }> {
  const worktreePath = await createTempDir('parallel-task-containers-worktree-');
  const userDataPath = await createTempDir('parallel-task-containers-userdata-');
  await Promise.all(
    fileNames.map(async (fileName) => {
      const filePath = path.join(worktreePath, fileName);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, 'services:\n  web:\n    image: nginx\n');
    }),
  );
  return { userDataPath, worktreePath };
}

function createBaseRequest(
  overrides: Partial<{
    projectContainerConfig: ProjectContainerConfig;
    projectPath: string;
    taskId: string;
    userDataPath: string;
    worktreePath: string;
  }> = {},
): {
  projectContainerConfig?: ProjectContainerConfig;
  projectPath: string;
  taskId: string;
  userDataPath: string;
  worktreePath: string;
} {
  return {
    projectPath: '/tmp/project-root',
    taskId: 'task-1',
    userDataPath: '/tmp/parallel-code-user-data',
    worktreePath: '/tmp/project-root/.worktrees/task-1',
    ...overrides,
  };
}

function createRuntime(overrides: Partial<TaskContainerRuntime> = {}): TaskContainerRuntime {
  const getComposeConfigErrorIssue = vi.fn(
    (worktreePath: string, _error: unknown): TaskContainerIssue => ({
      code: 'compose_config_failed',
      message: `failed for ${worktreePath}`,
      severity: 'error',
    }),
  );

  return {
    cleanupManagedProjectByLabels: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    composeLogs: vi.fn().mockResolvedValue('container log output'),
    composeStop: vi.fn().mockResolvedValue(undefined),
    composeUp: vi.fn().mockResolvedValue(undefined),
    getComposeConfig: vi.fn().mockResolvedValue({
      services: {
        web: {},
      },
    }),
    getComposeConfigErrorIssue,
    getComposeProjectStatus: vi.fn().mockResolvedValue({
      publishedPorts: [],
      services: [],
    }),
    getComposeRuntimeAvailability: vi.fn().mockResolvedValue({
      available: true,
      message: null,
    }),
    getDockerRuntimeAvailability: vi.fn().mockResolvedValue({
      available: true,
      message: null,
    }),
    ...overrides,
  };
}

async function listenOnRandomPort(): Promise<{ close: () => Promise<void>; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address from test server');
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    port: address.port,
  };
}

describe('task-containers', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    clearTaskContainerPreviewTargets();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })),
    );
  });

  it('reports not_configured when no compose file exists in the task worktree', async () => {
    const worktreePath = await createTempDir('parallel-empty-worktree-');
    const userDataPath = await createTempDir('parallel-empty-userdata-');

    const result = await inspectTaskContainers(
      createBaseRequest({ userDataPath, worktreePath }),
      createRuntime(),
    );

    expect(result.status).toBe('not_configured');
    expect(result.issues).toEqual([expect.objectContaining({ code: 'compose_file_missing' })]);
    expect(result.runnerProfile).toMatchObject({
      activeProfile: 'compose',
      fallbackProfile: 'compose',
      source: 'default',
      status: 'not_configured',
    });
  });

  it('resolves the default runner profile as a Compose fallback without requiring Docker', () => {
    expect(__taskContainerTestExports.resolveTaskContainerRunnerProfile(undefined)).toEqual({
      activeProfile: 'compose',
      configuredProfile: null,
      fallbackProfile: 'compose',
      message:
        'No runner profile is configured; using the Docker Compose task-container profile when a supported Compose file is present.',
      source: 'default',
      status: 'not_configured',
    });
  });

  it('reports an explicitly configured Compose runner profile in inspect truth', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime();

    const result = await inspectTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          runnerProfile: { kind: 'compose' },
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('ready');
    expect(result.runnerProfile).toEqual({
      activeProfile: 'compose',
      configuredProfile: { kind: 'compose' },
      fallbackProfile: null,
      message: null,
      source: 'project-config',
      status: 'resolved',
    });
    expect(runtime.getDockerRuntimeAvailability).toHaveBeenCalledTimes(1);
  });

  it('reports Docker runner profiles as unsupported without attempting Docker execution', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime();

    const result = await inspectTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          runnerProfile: {
            dockerfile: 'docker/Dockerfile',
            image: 'parallel-code-agent:latest',
            kind: 'docker',
          },
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('unsupported');
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'unsupported_runner_profile',
        message:
          'Docker runner profiles require a separate backend runner execution policy and are not supported by task-container lifecycle yet.',
      }),
    ]);
    expect(result.runnerProfile).toEqual({
      activeProfile: null,
      configuredProfile: {
        dockerfile: 'docker/Dockerfile',
        image: 'parallel-code-agent:latest',
        kind: 'docker',
      },
      fallbackProfile: null,
      message:
        'Docker runner profiles require a separate backend runner execution policy and are not supported by task-container lifecycle yet.',
      source: 'project-config',
      status: 'unsupported',
    });
    expect(runtime.getDockerRuntimeAvailability).not.toHaveBeenCalled();
    expect(runtime.getComposeRuntimeAvailability).not.toHaveBeenCalled();
    expect(runtime.getComposeConfig).not.toHaveBeenCalled();
    expect(runtime.composeUp).not.toHaveBeenCalled();

    const startResult = await startTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          runnerProfile: {
            dockerfile: 'docker/Dockerfile',
            image: 'parallel-code-agent:latest',
            kind: 'docker',
          },
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(startResult.status).toBe('unsupported');
    expect(runtime.getDockerRuntimeAvailability).not.toHaveBeenCalled();
    expect(runtime.getComposeConfig).not.toHaveBeenCalled();
    expect(runtime.composeUp).not.toHaveBeenCalled();
  });

  it('refuses configured compose files that resolve outside the task worktree', async () => {
    const worktreePath = await createTempDir('parallel-task-containers-worktree-');
    const userDataPath = await createTempDir('parallel-task-containers-userdata-');
    const runtime = createRuntime();

    const result = await inspectTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          composeFile: '../outside/compose.yaml',
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('unsupported');
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'unsupported_compose_feature',
        message: 'Configured Compose file must stay inside the task worktree.',
      }),
    ]);
    expect(runtime.getDockerRuntimeAvailability).not.toHaveBeenCalled();
  });

  it('refuses configured compose file symlinks that resolve outside the task worktree', async () => {
    const worktreePath = await createTempDir('parallel-task-containers-worktree-');
    const userDataPath = await createTempDir('parallel-task-containers-userdata-');
    const outsidePath = await createTempDir('parallel-task-containers-outside-');
    await fs.promises.writeFile(
      path.join(outsidePath, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n',
    );
    await fs.promises.symlink(
      path.join(outsidePath, 'compose.yaml'),
      path.join(worktreePath, 'compose.yaml'),
    );
    const runtime = createRuntime();

    const result = await inspectTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          composeFile: 'compose.yaml',
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('unsupported');
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'unsupported_compose_feature',
        message: 'Configured Compose file must stay inside the task worktree.',
      }),
    ]);
    expect(runtime.getDockerRuntimeAvailability).not.toHaveBeenCalled();
  });

  it('refuses configured compose file symlinks that point outside even when the target is missing', async () => {
    const worktreePath = await createTempDir('parallel-task-containers-worktree-');
    const userDataPath = await createTempDir('parallel-task-containers-userdata-');
    const outsidePath = await createTempDir('parallel-task-containers-outside-');
    await fs.promises.symlink(
      path.join(outsidePath, 'missing-compose.yaml'),
      path.join(worktreePath, 'compose.yaml'),
    );
    const runtime = createRuntime();

    const result = await inspectTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          composeFile: 'compose.yaml',
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('unsupported');
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'unsupported_compose_feature',
        message: 'Configured Compose file must stay inside the task worktree.',
      }),
    ]);
    expect(runtime.getDockerRuntimeAvailability).not.toHaveBeenCalled();
  });

  it('auto-detects a valid compose file when another standard candidate is unsafe', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree(['docker-compose.yml']);
    const outsidePath = await createTempDir('parallel-task-containers-outside-');
    await fs.promises.symlink(
      path.join(outsidePath, 'missing-compose.yaml'),
      path.join(worktreePath, 'compose.yaml'),
    );
    const runtime = createRuntime();

    const result = await inspectTaskContainers(
      createBaseRequest({
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('ready');
    expect(result.composeFile).toBe(path.join(worktreePath, 'docker-compose.yml'));
    expect(runtime.getComposeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        composeFile: path.join(worktreePath, 'docker-compose.yml'),
      }),
    );
  });

  it('marks unsupported compose blockers and resolves root compose env files relative to the worktree', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime({
      getComposeConfig: vi.fn().mockResolvedValue({
        networks: {
          shared: { external: true },
        },
        services: {
          web: {
            container_name: 'global-web',
            env_file: ['.env.required'],
          },
        },
        volumes: {
          db: { name: 'global-db-volume' },
        },
      }),
    });

    const result = await inspectTaskContainers(
      createBaseRequest({
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('unsupported');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'explicit_container_name',
        'external_network_declared',
        'named_volume',
        'missing_required_env_file',
      ]),
    );
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_required_env_file',
          message: expect.stringContaining(path.join(worktreePath, '.env.required')),
        }),
      ]),
    );
  });

  it('resolves nested compose env_file entries relative to the compose file directory', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree(['deploy/compose.yaml']);
    const runtime = createRuntime({
      getComposeConfig: vi.fn().mockResolvedValue({
        services: {
          web: {
            env_file: ['.env.required'],
          },
        },
      }),
    });

    const result = await inspectTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          composeFile: 'deploy/compose.yaml',
          requiredEnvFiles: ['.env.required'],
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('unsupported');
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_required_env_file',
          message: expect.stringContaining(path.join(worktreePath, 'deploy', '.env.required')),
        }),
        expect.objectContaining({
          code: 'missing_required_env_file',
          message: expect.stringContaining(path.join(worktreePath, '.env.required')),
        }),
      ]),
    );
  });

  it('promotes fixed host port conflicts to errors when the port is already in use by another process', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const listener = await listenOnRandomPort();

    try {
      const runtime = createRuntime({
        getComposeConfig: vi.fn().mockResolvedValue({
          services: {
            web: {
              ports: [`127.0.0.1:${listener.port}:3000`],
            },
          },
        }),
      });

      const result = await inspectTaskContainers(
        createBaseRequest({
          userDataPath,
          worktreePath,
        }),
        runtime,
      );

      expect(result.status).toBe('unsupported');
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'fixed_host_port_conflict',
            severity: 'error',
          }),
        ]),
      );
    } finally {
      await listener.close();
    }
  });

  it('returns an error inspect result when compose project status cannot be queried', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime({
      getComposeProjectStatus: vi.fn().mockRejectedValue(new Error('compose ps failed')),
    });

    const result = await inspectTaskContainers(
      createBaseRequest({
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('error');
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'compose_status_failed',
        message: expect.stringContaining('compose ps failed'),
      }),
    ]);
  });

  it('starts a compose project with an override file and derives configured previews from published ports', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    let running = false;
    const runtime = createRuntime({
      getComposeProjectStatus: vi.fn().mockImplementation(async () => {
        return running
          ? {
              publishedPorts: [
                {
                  host: '127.0.0.1',
                  port: 3000,
                  protocol: 'http',
                  serviceName: 'web',
                  targetPort: 3000,
                },
              ],
              services: [
                {
                  containerId: 'abc123',
                  health: 'healthy',
                  name: 'web',
                  publishedPorts: [
                    {
                      host: '127.0.0.1',
                      port: 3000,
                      protocol: 'http',
                      serviceName: 'web',
                      targetPort: 3000,
                    },
                  ],
                  state: 'running',
                },
              ],
            }
          : {
              publishedPorts: [],
              services: [],
            };
      }),
      composeUp: vi.fn().mockImplementation(async () => {
        running = true;
      }),
    });

    const result = await startTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          previewPorts: [{ label: 'Web', port: 3000 }],
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('running');
    expect(result.previews).toEqual([
      {
        label: 'Web',
        port: 3000,
        protocol: 'http',
        source: 'configured',
      },
    ]);

    const composeUpMock = vi.mocked(runtime.composeUp);
    const composeUpCall = composeUpMock.mock.calls[0]?.[0];
    expect(composeUpCall?.composeProjectName).toMatch(/^parallel-/u);
    const overrideFile = composeUpCall?.overrideFile;
    expect(overrideFile).toBeTruthy();
    const overrideContents = await fs.promises.readFile(overrideFile, 'utf8');
    expect(overrideContents).toContain('io.parallel-code.managed');
    expect(overrideContents).not.toContain('com.docker.compose.project');
  });

  it('records container preview targets separately from task port exposure state', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime({
      getComposeProjectStatus: vi.fn().mockResolvedValue({
        publishedPorts: [
          {
            host: '0.0.0.0',
            port: 3000,
            protocol: 'http',
            serviceName: 'web',
            targetPort: 3000,
          },
        ],
        services: [
          {
            containerId: 'abc123',
            health: 'healthy',
            name: 'web',
            publishedPorts: [
              {
                host: '0.0.0.0',
                port: 3000,
                protocol: 'http',
                serviceName: 'web',
                targetPort: 3000,
              },
            ],
            state: 'running',
          },
        ],
      }),
    });

    await inspectTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          previewPorts: [{ label: 'Web', port: 3000 }],
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(hasTaskContainerPreviewTarget('task-1', 3000)).toBe(true);
    expect(resolveTaskContainerPreviewTarget('task-1', 3000)).toBe('http://127.0.0.1:3000');
  });

  it('clears recorded container preview targets for a removed task', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime({
      getComposeProjectStatus: vi.fn().mockResolvedValue({
        publishedPorts: [
          {
            host: '0.0.0.0',
            port: 3000,
            protocol: 'http',
            serviceName: 'web',
            targetPort: 3000,
          },
        ],
        services: [
          {
            containerId: 'abc123',
            health: 'healthy',
            name: 'web',
            publishedPorts: [
              {
                host: '0.0.0.0',
                port: 3000,
                protocol: 'http',
                serviceName: 'web',
                targetPort: 3000,
              },
            ],
            state: 'running',
          },
        ],
      }),
    });

    await inspectTaskContainers(
      createBaseRequest({
        projectContainerConfig: {
          previewPorts: [{ label: 'Web', port: 3000 }],
        },
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    removeTaskContainerPreviewTargets('task-1');

    expect(hasTaskContainerPreviewTarget('task-1', 3000)).toBe(false);
    expect(resolveTaskContainerPreviewTarget('task-1', 3000)).toBeNull();
  });

  it('returns an action error when compose config cannot be reloaded before start', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime({
      getComposeConfig: vi
        .fn()
        .mockResolvedValueOnce({
          services: {
            web: {},
          },
        })
        .mockRejectedValueOnce(new Error('compose config changed')),
    });

    const result = await startTaskContainers(
      createBaseRequest({
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.status).toBe('error');
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'compose_config_failed',
        message: `failed for ${worktreePath}`,
      }),
    ]);
    expect(runtime.composeUp).not.toHaveBeenCalled();
  });

  it('stops and destroys only when a compose project is currently running or configured', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime({
      getComposeProjectStatus: vi.fn().mockResolvedValue({
        publishedPorts: [],
        services: [
          {
            containerId: 'abc123',
            health: 'healthy',
            name: 'web',
            publishedPorts: [],
            state: 'running',
          },
        ],
      }),
    });

    await stopTaskContainers(
      createBaseRequest({
        userDataPath,
        worktreePath,
      }),
      runtime,
    );
    await destroyTaskContainers(
      createBaseRequest({
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(runtime.composeStop).toHaveBeenCalledTimes(1);
    expect(runtime.composeDown).toHaveBeenCalledTimes(1);
  });

  it('falls back to ownership-label cleanup when the compose file is rejected', async () => {
    const worktreePath = await createTempDir('parallel-task-containers-worktree-');
    const userDataPath = await createTempDir('parallel-task-containers-userdata-');
    const outsidePath = await createTempDir('parallel-task-containers-outside-');
    await fs.promises.symlink(
      path.join(outsidePath, 'compose.yaml'),
      path.join(worktreePath, 'compose.yaml'),
    );
    const runtime = createRuntime();
    const request = createBaseRequest({
      projectContainerConfig: {
        composeFile: 'compose.yaml',
      },
      userDataPath,
      worktreePath,
    });

    const stopResult = await stopTaskContainers(request, runtime);
    await destroyTaskContainers(request, runtime);

    expect(runtime.composeStop).not.toHaveBeenCalled();
    expect(runtime.composeDown).not.toHaveBeenCalled();
    expect(stopResult.projectName).toMatch(/^parallel-/u);
    expect(runtime.cleanupManagedProjectByLabels).toHaveBeenCalledTimes(2);
    expect(runtime.cleanupManagedProjectByLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'stop',
        composeProjectName: stopResult.projectName,
        ownershipLabels: expect.objectContaining({
          'io.parallel-code.managed': 'true',
          'io.parallel-code.task-id': request.taskId,
        }),
        worktreePath,
      }),
    );
    expect(runtime.cleanupManagedProjectByLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'destroy',
      }),
    );
  });

  it('loads recent logs without claiming truncation just because the default tail size is below the maximum', async () => {
    const { userDataPath, worktreePath } = await createComposeWorktree();
    const runtime = createRuntime({
      getComposeProjectStatus: vi.fn().mockResolvedValue({
        publishedPorts: [],
        services: [
          {
            containerId: 'abc123',
            health: 'healthy',
            name: 'web',
            publishedPorts: [],
            state: 'running',
          },
        ],
      }),
      composeLogs: vi.fn().mockResolvedValue('hello from logs'),
    });

    const result = await getTaskContainerLogs(
      createBaseRequest({
        userDataPath,
        worktreePath,
      }),
      runtime,
    );

    expect(result.text).toBe('hello from logs');
    expect(result.truncated).toBe(false);
  });
});
