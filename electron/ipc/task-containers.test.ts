import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getTaskContainerLogs,
  inspectTaskContainers,
  startTaskContainers,
  stopTaskContainers,
  destroyTaskContainers,
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
    fileNames.map((fileName) =>
      fs.promises.writeFile(
        path.join(worktreePath, fileName),
        'services:\n  web:\n    image: nginx\n',
      ),
    ),
  );
  return { userDataPath, worktreePath };
}

function createBaseRequest(
  overrides: Partial<{
    projectContainerConfig: {
      composeFile?: string;
      previewPorts?: Array<{ label?: string; port: number; protocol?: 'http' | 'https' }>;
      requiredEnvFiles?: string[];
    };
    projectPath: string;
    taskId: string;
    userDataPath: string;
    worktreePath: string;
  }> = {},
): {
  projectContainerConfig?: {
    composeFile?: string;
    previewPorts?: Array<{ label?: string; port: number; protocol?: 'http' | 'https' }>;
    requiredEnvFiles?: string[];
  };
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

function createRuntime(overrides: Partial<Parameters<typeof inspectTaskContainers>[1]> = {}) {
  return {
    composeDown: vi.fn().mockResolvedValue(undefined),
    composeLogs: vi.fn().mockResolvedValue('container log output'),
    composeStop: vi.fn().mockResolvedValue(undefined),
    composeUp: vi.fn().mockResolvedValue(undefined),
    getComposeConfig: vi.fn().mockResolvedValue({
      services: {
        web: {},
      },
    }),
    getComposeConfigErrorIssue: vi.fn((worktreePath: string) => ({
      code: 'compose_config_failed',
      message: `failed for ${worktreePath}`,
      severity: 'error',
    })),
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

  it('marks unsupported compose blockers and resolves required env files relative to the worktree', async () => {
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

    const composeUpCall = runtime.composeUp.mock.calls[0]?.[0];
    expect(composeUpCall?.composeProjectName).toMatch(/^parallel-/u);
    const overrideFile = composeUpCall?.overrideFile;
    expect(overrideFile).toBeTruthy();
    const overrideContents = await fs.promises.readFile(overrideFile, 'utf8');
    expect(overrideContents).toContain('io.parallel-code.managed');
    expect(overrideContents).not.toContain('com.docker.compose.project');
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
