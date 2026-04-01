import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ProjectContainerConfig,
  TaskContainerInspectStatus,
} from '../../src/domain/task-containers.js';
import {
  destroyTaskContainers,
  getTaskContainerLogs,
  inspectTaskContainers,
  startTaskContainers,
  stopTaskContainers,
} from './task-containers.js';

const RUN_DOCKER_INTEGRATION = process.env.RUN_DOCKER_INTEGRATION === '1';
const dockerReady = RUN_DOCKER_INTEGRATION && isDockerComposeAvailable();
const describeDockerIntegration = dockerReady ? describe : describe.skip;
const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void>> = [];

interface TaskContainerIntegrationRequest {
  projectContainerConfig?: ProjectContainerConfig;
  projectPath: string;
  taskId: string;
  userDataPath: string;
  worktreePath: string;
}

function isDockerComposeAvailable(): boolean {
  const dockerVersion = spawnSync('docker', ['version'], {
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (dockerVersion.status !== 0 || dockerVersion.error) {
    return false;
  }

  const composeVersion = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 5_000,
  });
  return composeVersion.status === 0 && !composeVersion.error;
}

async function createTempDir(prefix: string): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dirPath);
  return dirPath;
}

async function copyFixtureIntoWorktree(
  fixtureName: 'single-service' | 'unsupported-container-name',
  options: { projectPath?: string; taskId: string },
): Promise<TaskContainerIntegrationRequest> {
  const projectPath =
    options.projectPath ?? (await createTempDir('parallel-task-containers-project-'));
  const worktreePath = path.join(projectPath, '.worktrees', options.taskId);
  const userDataPath = await createTempDir('parallel-task-containers-userdata-');
  const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'task-containers', fixtureName);

  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  await fs.promises.cp(fixturePath, worktreePath, { recursive: true });

  return {
    projectPath,
    taskId: options.taskId,
    userDataPath,
    worktreePath,
  };
}

async function writeComposeWorktree(
  composeContents: string,
  options: { projectPath?: string; taskId: string },
): Promise<TaskContainerIntegrationRequest> {
  const projectPath =
    options.projectPath ?? (await createTempDir('parallel-task-containers-project-'));
  const worktreePath = path.join(projectPath, '.worktrees', options.taskId);
  const userDataPath = await createTempDir('parallel-task-containers-userdata-');

  await fs.promises.mkdir(worktreePath, { recursive: true });
  await fs.promises.writeFile(path.join(worktreePath, 'compose.yaml'), composeContents, 'utf8');

  return {
    projectPath,
    taskId: options.taskId,
    userDataPath,
    worktreePath,
  };
}

function registerCleanup(request: TaskContainerIntegrationRequest): void {
  cleanupCallbacks.push(async () => {
    await destroyTaskContainers(request).catch(() => undefined);
  });
}

async function waitForInspectStatus(
  request: TaskContainerIntegrationRequest,
  allowedStatuses: ReadonlyArray<TaskContainerInspectStatus>,
  timeoutMs = 20_000,
): Promise<Awaited<ReturnType<typeof inspectTaskContainers>>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const inspect = await inspectTaskContainers(request);
    if (allowedStatuses.includes(inspect.status)) {
      return inspect;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return inspectTaskContainers(request);
}

async function waitForLogsContaining(
  request: TaskContainerIntegrationRequest,
  needle: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const logs = await getTaskContainerLogs(request);
    if (logs.text.includes(needle)) {
      return logs.text;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const finalLogs = await getTaskContainerLogs(request);
  return finalLogs.text;
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

describeDockerIntegration('task-containers docker integration', () => {
  afterEach(async () => {
    while (cleanupCallbacks.length > 0) {
      const cleanup = cleanupCallbacks.pop();
      if (!cleanup) {
        continue;
      }
      await cleanup();
    }

    await Promise.all(
      tempDirs
        .splice(0)
        .map((dirPath) => fs.promises.rm(dirPath, { force: true, recursive: true })),
    );
  }, 60_000);

  it('inspects, starts, logs, stops, and destroys a supported single-service compose project', async () => {
    const request = await copyFixtureIntoWorktree('single-service', { taskId: 'task-runtime-a' });
    registerCleanup(request);

    const initialInspect = await inspectTaskContainers(request);
    expect(initialInspect.status).toBe('ready');
    expect(initialInspect.composeFile).toMatch(/compose\.yaml$/u);
    expect(initialInspect.projectName).toMatch(/^parallel-/u);

    const startResult = await startTaskContainers(request);
    expect(startResult.status).toMatch(/^(ready|running)$/u);

    const runningInspect = await waitForInspectStatus(request, ['running']);
    expect(runningInspect.status).toBe('running');
    expect(runningInspect.runtime).toBe('docker-compose');
    expect(runningInspect.services.some((service) => service.state === 'running')).toBe(true);
    expect(runningInspect.publishedPorts.length).toBeGreaterThan(0);
    expect(runningInspect.previews).toEqual([
      expect.objectContaining({
        source: 'single-published-port',
      }),
    ]);

    const logs = await waitForLogsContaining(request, 'task-container-ready');
    expect(logs).toContain('task-container-ready');

    const stopResult = await stopTaskContainers(request);
    expect(stopResult.status).toMatch(/^(ready|running)$/u);

    const readyAfterStop = await waitForInspectStatus(request, ['ready']);
    expect(readyAfterStop.status).toBe('ready');
    expect(readyAfterStop.services.every((service) => service.state !== 'running')).toBe(true);

    const destroyResult = await destroyTaskContainers(request);
    expect(destroyResult.status).toBe('ready');

    const readyAfterDestroy = await inspectTaskContainers(request);
    expect(readyAfterDestroy.status).toBe('ready');
    expect(readyAfterDestroy.services.some((service) => service.state === 'running')).toBe(false);
  }, 90_000);

  it('surfaces fixed host-port conflicts using real compose config parsing', async () => {
    const listener = await listenOnRandomPort();

    try {
      const request = await writeComposeWorktree(
        `services:\n  web:\n    image: busybox:1.36.1\n    command:\n      - sh\n      - -c\n      - echo port-conflict && sleep 3600\n    ports:\n      - "127.0.0.1:${listener.port}:5678"\n`,
        { taskId: 'task-runtime-conflict' },
      );

      const inspect = await inspectTaskContainers(request);
      expect(inspect.status).toBe('unsupported');
      expect(inspect.issues).toEqual(
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
  }, 30_000);

  it('surfaces unsupported explicit container naming from real compose config output', async () => {
    const request = await copyFixtureIntoWorktree('unsupported-container-name', {
      taskId: 'task-runtime-unsupported',
    });

    const inspect = await inspectTaskContainers(request);
    expect(inspect.status).toBe('unsupported');
    expect(inspect.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'explicit_container_name',
        }),
      ]),
    );
  }, 30_000);

  it('derives configured previews from real published ports', async () => {
    const listener = await listenOnRandomPort();
    const availablePort = listener.port;
    await listener.close();

    const request = await writeComposeWorktree(
      `services:
  web:
    image: busybox:1.36
    command:
      - sh
      - -c
      - |
        echo configured-preview-ready
        httpd -f -p 8080
    ports:
      - "127.0.0.1:${availablePort}:8080"
`,
      {
        taskId: 'task-runtime-configured-preview',
      },
    );
    request.projectContainerConfig = {
      previewPorts: [
        {
          label: 'Configured preview',
          port: availablePort,
          protocol: 'http',
        },
      ],
    };
    registerCleanup(request);

    await startTaskContainers(request);

    const runningInspect = await waitForInspectStatus(request, ['running']);
    expect(runningInspect.previews).toEqual([
      {
        label: 'Configured preview',
        port: availablePort,
        protocol: 'http',
        source: 'configured',
      },
    ]);
  }, 60_000);

  it('isolates two worktrees of the same project with distinct compose project identities', async () => {
    const projectPath = await createTempDir('parallel-task-containers-shared-project-');
    const first = await copyFixtureIntoWorktree('single-service', {
      projectPath,
      taskId: 'task-runtime-one',
    });
    const second = await copyFixtureIntoWorktree('single-service', {
      projectPath,
      taskId: 'task-runtime-two',
    });
    registerCleanup(first);
    registerCleanup(second);

    await startTaskContainers(first);
    await startTaskContainers(second);

    const firstRunning = await waitForInspectStatus(first, ['running']);
    const secondRunning = await waitForInspectStatus(second, ['running']);

    expect(firstRunning.projectName).not.toBe(secondRunning.projectName);
    expect(firstRunning.projectName).toMatch(/^parallel-/u);
    expect(secondRunning.projectName).toMatch(/^parallel-/u);
    expect(firstRunning.publishedPorts.length).toBeGreaterThan(0);
    expect(secondRunning.publishedPorts.length).toBeGreaterThan(0);
    expect(firstRunning.publishedPorts[0]?.port).not.toBe(secondRunning.publishedPorts[0]?.port);
  }, 120_000);
});
