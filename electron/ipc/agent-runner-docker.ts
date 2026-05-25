import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentRunnerMountConfig,
  AgentRunnerProfileConfig,
  AgentRuntimeIdentity,
} from '../../src/domain/agent-runners.js';
import {
  isAllowedAgentRunnerEnvName,
  isValidAgentRunnerEnvName,
} from '../../src/domain/agent-runners.js';

interface DockerAgentRunnerLaunchRequest {
  agentId: string;
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string>;
  profile: AgentRunnerProfileConfig;
  taskId: string;
}

interface DockerAgentRunnerImageResolution {
  builtImage: boolean;
  image: string;
}

export interface DockerAgentRunnerLaunch {
  args: string[];
  command: 'docker';
  cleanup: () => void;
  cwd: string;
  env: Record<string, string>;
  identity: AgentRuntimeIdentity;
}

const MANAGED_LABELS = {
  managed: 'com.parallel-code.managed',
  resource: 'com.parallel-code.resource',
  provider: 'com.parallel-code.provider',
  taskId: 'com.parallel-code.task-id',
  agentId: 'com.parallel-code.agent-id',
  runnerInstanceId: 'com.parallel-code.runner-instance-id',
  profileId: 'com.parallel-code.profile-id',
  createdAt: 'com.parallel-code.created-at',
} as const;

const DEFAULT_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_HOME',
  'GEMINI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
];
const DOCKER_SYNC_TIMEOUT_MS = 5_000;

function runDockerSync(
  args: string[],
  options: {
    cwd?: string;
    maxBuffer?: number;
  } = {},
): SpawnSyncReturns<string> {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: DOCKER_SYNC_TIMEOUT_MS,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
  });
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function normalizeDockerNameSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || 'unknown';
}

function createRunnerInstanceId(): string {
  return `runner-${crypto.randomUUID()}`;
}

function createContainerName(taskId: string, agentId: string, runnerInstanceId: string): string {
  return [
    'parallel-code',
    normalizeDockerNameSegment(taskId).slice(0, 28),
    normalizeDockerNameSegment(agentId).slice(0, 28),
    runnerInstanceId.slice(-12),
  ].join('-');
}

function createProfileId(profile: AgentRunnerProfileConfig): string {
  return `profile-${shortHash(JSON.stringify(profile))}`;
}

export function createDockerAgentRunnerLabels(
  taskId: string,
  agentId: string,
  profile: AgentRunnerProfileConfig,
  runnerInstanceId: string,
  createdAt: string,
): Record<string, string> {
  return {
    [MANAGED_LABELS.managed]: 'true',
    [MANAGED_LABELS.resource]: 'agent-runner',
    [MANAGED_LABELS.provider]: 'docker-container',
    [MANAGED_LABELS.taskId]: taskId,
    [MANAGED_LABELS.agentId]: agentId,
    [MANAGED_LABELS.runnerInstanceId]: runnerInstanceId,
    [MANAGED_LABELS.profileId]: createProfileId(profile),
    [MANAGED_LABELS.createdAt]: createdAt,
  };
}

function assertDockerAvailable(): void {
  const result = runDockerSync(['version', '--format', '{{.Server.Version}}']);
  if (result.error) {
    throw new Error(`Docker is unavailable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || 'Docker daemon is unavailable';
    throw new Error(message);
  }
}

function resolveDockerfilePath(profile: AgentRunnerProfileConfig, cwd: string): string | undefined {
  if (!profile.dockerfile) {
    return undefined;
  }

  const resolvedCwd = path.resolve(cwd);
  const dockerfilePath = path.resolve(resolvedCwd, profile.dockerfile);
  if (!dockerfilePath.startsWith(`${resolvedCwd}${path.sep}`)) {
    throw new Error('Dockerfile must stay inside the task worktree');
  }
  if (!fs.existsSync(dockerfilePath)) {
    throw new Error(`Dockerfile does not exist: ${dockerfilePath}`);
  }

  return dockerfilePath;
}

function assertAbsoluteContainerPath(value: string, fieldName: string): void {
  if (!value.startsWith('/')) {
    throw new Error(`${fieldName} must be an absolute container path`);
  }
}

function assertDockerMountValueSafe(value: string, fieldName: string): void {
  if (value.includes(',') || value.includes('=')) {
    throw new Error(`${fieldName} must not contain "," or "="`);
  }
}

function assertExistingHostPath(value: string, fieldName: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`${fieldName} must be an absolute host path`);
  }
  if (!fs.existsSync(value)) {
    throw new Error(`${fieldName} does not exist: ${value}`);
  }
}

function resolveImage(
  profile: AgentRunnerProfileConfig,
  cwd: string,
  dockerfilePath: string | undefined,
  runnerInstanceId: string,
): DockerAgentRunnerImageResolution {
  if (dockerfilePath !== undefined) {
    const tag = `parallel-code-agent-${runnerInstanceId.slice('runner-'.length)}`;
    const result = runDockerSync(['build', '-t', tag, '-f', dockerfilePath, cwd], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) {
      throw new Error(`Docker build failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || 'Docker build failed';
      throw new Error(message);
    }
    return {
      builtImage: true,
      image: tag,
    };
  }

  if (!profile.image) {
    throw new Error('Docker agent runner requires an image or dockerfile');
  }

  return {
    builtImage: false,
    image: profile.image,
  };
}

function createMountArg(mount: AgentRunnerMountConfig): string {
  assertExistingHostPath(mount.source, 'agentRunnerProfile.mounts.source');
  assertAbsoluteContainerPath(mount.target, 'agentRunnerProfile.mounts.target');
  assertDockerMountValueSafe(mount.source, 'agentRunnerProfile.mounts.source');
  assertDockerMountValueSafe(mount.target, 'agentRunnerProfile.mounts.target');

  const parts = [`type=bind`, `src=${mount.source}`, `dst=${mount.target}`];
  if (mount.readonly) {
    parts.push('readonly');
  }
  return parts.join(',');
}

function collectDockerEnv(
  profile: AgentRunnerProfileConfig,
  resolvedLaunchEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    assertDockerEnvNameAllowed(key, `agentRunnerProfile.env.${key}`);
    env[key] = value;
  }

  for (const [key, value] of Object.entries(resolvedLaunchEnv)) {
    if (isAllowedAgentRunnerEnvName(key)) {
      env[key] = value;
    }
  }

  for (const key of profile.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) {
    assertDockerEnvNameAllowed(key, 'agentRunnerProfile.envAllowlist');
    const value = process.env[key];
    if (value !== undefined && env[key] === undefined) {
      env[key] = value;
    }
  }
  return env;
}

function assertDockerEnvNameAllowed(value: string, fieldName: string): void {
  if (!isValidAgentRunnerEnvName(value)) {
    throw new Error(`${fieldName} must be a valid environment variable name`);
  }

  if (!isAllowedAgentRunnerEnvName(value)) {
    throw new Error(`${fieldName} is not allowed for Docker agent runners`);
  }
}

function appendDockerRunOption(args: string[], flag: string, value: string | undefined): void {
  if (value === undefined || value.trim() === '') {
    return;
  }
  args.push(flag, value);
}

function isExactManagedContainer(containerName: string, labels: Record<string, string>): boolean {
  const result = runDockerSync([
    'container',
    'inspect',
    '--format',
    '{{json .Config.Labels}}',
    containerName,
  ]);
  if (result.error || result.status !== 0) {
    return false;
  }

  const rawLabels = result.stdout.trim();
  if (!rawLabels) {
    return false;
  }

  try {
    const inspectedLabels = JSON.parse(rawLabels) as unknown;
    if (!inspectedLabels || typeof inspectedLabels !== 'object') {
      return false;
    }

    const inspectedParallelCodeLabels = Object.fromEntries(
      Object.entries(inspectedLabels as Record<string, unknown>).filter(([key]) =>
        key.startsWith('com.parallel-code.'),
      ),
    );
    return (
      Object.keys(inspectedParallelCodeLabels).length === Object.keys(labels).length &&
      Object.entries(labels).every(([key, value]) => inspectedParallelCodeLabels[key] === value)
    );
  } catch {
    return false;
  }
}

function runDockerCleanupCommand(args: string[], label: string): void {
  const result = runDockerSync(args);
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `${label} failed`;
    throw new Error(message);
  }
}

function cleanupDockerAgentRunnerResources(
  containerName: string,
  image: string,
  builtImage: boolean,
  labels: Record<string, string>,
): void {
  if (isExactManagedContainer(containerName, labels)) {
    runDockerCleanupCommand(['rm', '--force', containerName], 'Docker container cleanup');
  }

  if (builtImage) {
    runDockerCleanupCommand(['image', 'rm', '--force', image], 'Docker image cleanup');
  }
}

export function createDockerAgentRunnerLaunch(
  request: DockerAgentRunnerLaunchRequest,
): DockerAgentRunnerLaunch {
  assertExistingHostPath(request.cwd, 'cwd');

  const dockerfilePath = resolveDockerfilePath(request.profile, request.cwd);
  if (!request.profile.image && dockerfilePath === undefined) {
    throw new Error('Docker agent runner requires an image or dockerfile');
  }

  const workspaceMountTarget = request.profile.workspaceMountTarget ?? '/workspace';
  const workdir = request.profile.workdir ?? workspaceMountTarget;
  assertAbsoluteContainerPath(workspaceMountTarget, 'agentRunnerProfile.workspaceMountTarget');
  assertAbsoluteContainerPath(workdir, 'agentRunnerProfile.workdir');
  assertDockerMountValueSafe(request.cwd, 'cwd');
  assertDockerMountValueSafe(workspaceMountTarget, 'agentRunnerProfile.workspaceMountTarget');
  const profileMountArgs = (request.profile.mounts ?? []).map((mount) => createMountArg(mount));
  const dockerEnv = collectDockerEnv(request.profile, request.env);

  assertDockerAvailable();

  const runnerInstanceId = createRunnerInstanceId();
  const { builtImage, image } = resolveImage(
    request.profile,
    request.cwd,
    dockerfilePath,
    runnerInstanceId,
  );
  const containerName = createContainerName(request.taskId, request.agentId, runnerInstanceId);
  const createdAt = new Date().toISOString();
  const labels = createDockerAgentRunnerLabels(
    request.taskId,
    request.agentId,
    request.profile,
    runnerInstanceId,
    createdAt,
  );

  const dockerArgs = ['run', '--name', containerName, '--interactive', '--tty'];
  for (const [key, value] of Object.entries(labels)) {
    dockerArgs.push('--label', `${key}=${value}`);
  }

  dockerArgs.push('--mount', `type=bind,src=${request.cwd},dst=${workspaceMountTarget}`);
  for (const mountArg of profileMountArgs) {
    dockerArgs.push('--mount', mountArg);
  }

  appendDockerRunOption(dockerArgs, '--workdir', workdir);
  appendDockerRunOption(dockerArgs, '--user', request.profile.user);
  appendDockerRunOption(dockerArgs, '--cpus', request.profile.resources?.cpus);
  appendDockerRunOption(dockerArgs, '--memory', request.profile.resources?.memory);
  appendDockerRunOption(dockerArgs, '--network', request.profile.network?.mode);

  for (const [key, value] of Object.entries(dockerEnv)) {
    dockerArgs.push('--env', `${key}=${value}`);
  }

  dockerArgs.push(image, request.command, ...request.args);

  return {
    args: dockerArgs,
    command: 'docker',
    cleanup: () => {
      cleanupDockerAgentRunnerResources(containerName, image, builtImage, labels);
    },
    cwd: request.cwd,
    env: {},
    identity: {
      agentId: request.agentId,
      containerName,
      imageRef: image,
      labels,
      profileId: createProfileId(request.profile),
      provider: 'docker-container',
      runnerInstanceId,
      startedAt: createdAt,
      taskId: request.taskId,
    },
  };
}
