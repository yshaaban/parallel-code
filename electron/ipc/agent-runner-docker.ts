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
import { isPathInside, isPathInsideOrEqual, validateRelativePath } from './path-utils.js';
import { BadRequestError } from './errors.js';
import { execFileWithDeadline } from './bounded-process.js';

interface DockerAgentRunnerLaunchRequest {
  agentId: string;
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string>;
  profile: AgentRunnerProfileConfig;
  signal?: AbortSignal;
  taskId: string;
}

interface DockerAgentRunnerImageResolution {
  builtImage: boolean;
  image: string;
}

interface PendingDockerImageCleanup {
  agentId: string;
  cleanupPromise?: Promise<void>;
  image: string;
  taskId: string;
}

export interface DockerAgentRunnerLaunch {
  args: string[];
  command: 'docker';
  cleanup: () => Promise<void>;
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
export const DOCKER_QUERY_TIMEOUT_MS = 5_000;
export const DOCKER_CLEANUP_TIMEOUT_MS = 30_000;
export const DOCKER_BUILD_TIMEOUT_MS = 10 * 60_000;
const pendingDockerImageCleanups = new Set<PendingDockerImageCleanup>();

function runDockerCommand(
  args: string[],
  options: {
    cwd?: string;
    maxBuffer?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<{ stderr: string; stdout: string }> {
  return execFileWithDeadline('docker', args, {
    encoding: 'utf8',
    timeoutMs: options.timeoutMs ?? DOCKER_QUERY_TIMEOUT_MS,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

function getSubprocessOutput(error: unknown, stream: 'stderr' | 'stdout'): string {
  if (!error || typeof error !== 'object' || !(stream in error)) {
    return '';
  }
  const value = (error as Record<'stderr' | 'stdout', unknown>)[stream];
  return Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : '';
}

function getDockerFailureMessage(error: unknown, fallback: string): string {
  return (
    getSubprocessOutput(error, 'stderr').trim() ||
    getSubprocessOutput(error, 'stdout').trim() ||
    (error instanceof Error ? error.message : '') ||
    fallback
  );
}

function createDockerCommandError(message: string, cause: unknown): Error {
  const error = new Error(message);
  Object.defineProperty(error, 'cause', {
    configurable: true,
    value: cause,
    writable: true,
  });
  return error;
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

async function assertDockerAvailable(signal?: AbortSignal): Promise<void> {
  try {
    await runDockerCommand(['version', '--format', '{{.Server.Version}}'], {
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    throw createDockerCommandError(
      `Docker is unavailable: ${getDockerFailureMessage(error, 'unknown error')}`,
      error,
    );
  }
}

function resolveDockerfilePath(profile: AgentRunnerProfileConfig, cwd: string): string | undefined {
  if (!profile.dockerfile) {
    return undefined;
  }

  validateRelativePath(profile.dockerfile, 'agentRunnerProfile.dockerfile');
  const resolvedCwd = path.resolve(cwd);
  const dockerfilePath = path.resolve(resolvedCwd, profile.dockerfile);
  if (!isPathInside(resolvedCwd, dockerfilePath)) {
    throw new BadRequestError('Dockerfile must stay inside the task worktree');
  }
  if (!fs.existsSync(dockerfilePath)) {
    throw new BadRequestError(`Dockerfile does not exist: ${dockerfilePath}`);
  }
  const realCwd = fs.realpathSync(resolvedCwd);
  const realDockerfilePath = fs.realpathSync(dockerfilePath);
  if (!isPathInside(realCwd, realDockerfilePath)) {
    throw new BadRequestError('Dockerfile must stay inside the task worktree');
  }

  return dockerfilePath;
}

function assertAbsoluteContainerPath(value: string, fieldName: string): void {
  if (!value.startsWith('/')) {
    throw new BadRequestError(`${fieldName} must be an absolute container path`);
  }
}

function assertDockerMountValueSafe(value: string, fieldName: string): void {
  if (value.includes(',') || value.includes('=')) {
    throw new BadRequestError(`${fieldName} must not contain "," or "="`);
  }
}

function assertExistingHostPath(value: string, fieldName: string, allowedParent?: string): void {
  if (!path.isAbsolute(value)) {
    throw new BadRequestError(`${fieldName} must be an absolute host path`);
  }
  if (!fs.existsSync(value)) {
    throw new BadRequestError(`${fieldName} does not exist: ${value}`);
  }
  if (allowedParent === undefined) {
    return;
  }

  const realAllowedParent = fs.realpathSync(allowedParent);
  const realValue = fs.realpathSync(value);
  if (!isPathInsideOrEqual(realAllowedParent, realValue)) {
    throw new BadRequestError(`${fieldName} must stay inside the task worktree`);
  }
}

async function resolveImage(
  profile: AgentRunnerProfileConfig,
  cwd: string,
  dockerfilePath: string | undefined,
  runnerInstanceId: string,
  request: Pick<DockerAgentRunnerLaunchRequest, 'agentId' | 'taskId'>,
  signal?: AbortSignal,
): Promise<DockerAgentRunnerImageResolution> {
  if (dockerfilePath !== undefined) {
    const tag = `parallel-code-agent-${runnerInstanceId.slice('runner-'.length)}`;
    const pendingCleanup: PendingDockerImageCleanup = {
      agentId: request.agentId,
      image: tag,
      taskId: request.taskId,
    };
    pendingDockerImageCleanups.add(pendingCleanup);
    try {
      await runDockerCommand(['build', '-t', tag, '-f', dockerfilePath, cwd], {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        ...(signal !== undefined ? { signal } : {}),
        timeoutMs: DOCKER_BUILD_TIMEOUT_MS,
      });
    } catch (error) {
      try {
        await cleanupPendingDockerImage(pendingCleanup);
      } catch (cleanupError) {
        throw createDockerCommandError(
          `Docker build failed and image cleanup also failed: ${getDockerFailureMessage(error, 'unknown build error')}`,
          [error, cleanupError],
        );
      }
      throw createDockerCommandError(getDockerFailureMessage(error, 'Docker build failed'), error);
    }
    pendingDockerImageCleanups.delete(pendingCleanup);
    return {
      builtImage: true,
      image: tag,
    };
  }

  if (!profile.image) {
    throw new BadRequestError('Docker agent runner requires an image or dockerfile');
  }

  return {
    builtImage: false,
    image: profile.image,
  };
}

function createMountArg(mount: AgentRunnerMountConfig, worktreePath: string): string {
  assertDockerMountValueSafe(mount.source, 'agentRunnerProfile.mounts.source');
  assertExistingHostPath(mount.source, 'agentRunnerProfile.mounts.source', worktreePath);
  assertAbsoluteContainerPath(mount.target, 'agentRunnerProfile.mounts.target');
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
    throw new BadRequestError(`${fieldName} must be a valid environment variable name`);
  }

  if (!isAllowedAgentRunnerEnvName(value)) {
    throw new BadRequestError(`${fieldName} is not allowed for Docker agent runners`);
  }
}

function appendDockerRunOption(args: string[], flag: string, value: string | undefined): void {
  if (value === undefined || value.trim() === '') {
    return;
  }
  args.push(flag, value);
}

async function isExactManagedContainer(
  containerName: string,
  labels: Record<string, string>,
): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await runDockerCommand([
      'container',
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      containerName,
    ]));
  } catch (error) {
    const detail = getDockerFailureMessage(error, 'unknown inspect error');
    if (/\bno such (?:container|object)\b/iu.test(detail)) {
      return false;
    }
    throw createDockerCommandError(`Docker container inspect failed: ${detail}`, error);
  }

  const rawLabels = stdout.trim();
  if (!rawLabels) {
    throw new Error(`Docker container inspect returned no labels for ${containerName}`);
  }

  try {
    const inspectedLabels = JSON.parse(rawLabels) as unknown;
    if (!inspectedLabels || typeof inspectedLabels !== 'object' || Array.isArray(inspectedLabels)) {
      throw new Error('labels must be an object');
    }

    return Object.entries(labels).every(
      ([key, value]) => (inspectedLabels as Record<string, unknown>)[key] === value,
    );
  } catch (error) {
    throw createDockerCommandError(
      `Docker container inspect returned invalid labels for ${containerName}`,
      error,
    );
  }
}

async function runDockerCleanupCommand(
  args: string[],
  label: string,
  notFoundPattern?: RegExp,
): Promise<void> {
  try {
    await runDockerCommand(args, { timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS });
  } catch (error) {
    const detail = getDockerFailureMessage(error, `${label} failed`);
    if (notFoundPattern?.test(detail)) {
      return;
    }
    throw createDockerCommandError(detail, error);
  }
}

async function cleanupPendingDockerImage(cleanup: PendingDockerImageCleanup): Promise<void> {
  if (!cleanup.cleanupPromise) {
    cleanup.cleanupPromise = runDockerCleanupCommand(
      ['image', 'rm', '--force', cleanup.image],
      'Docker image cleanup',
      /\bno such image\b/iu,
    ).then(
      () => {
        pendingDockerImageCleanups.delete(cleanup);
      },
      (error: unknown) => {
        delete cleanup.cleanupPromise;
        throw error;
      },
    );
  }
  await cleanup.cleanupPromise;
}

export async function cleanupPendingDockerAgentRunnerBuilds(
  options: {
    agentIds?: ReadonlySet<string>;
    taskId?: string;
  } = {},
): Promise<void> {
  const cleanups = [...pendingDockerImageCleanups].filter(
    (cleanup) =>
      (options.taskId === undefined || cleanup.taskId === options.taskId) &&
      (options.agentIds === undefined || options.agentIds.has(cleanup.agentId)),
  );
  const results = await Promise.allSettled(
    cleanups.map((cleanup) => cleanupPendingDockerImage(cleanup)),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw createDockerCommandError('Failed to clean pending Docker agent runner images', failures);
  }
}

async function cleanupDockerAgentRunnerResources(
  containerName: string,
  image: string,
  builtImage: boolean,
  labels: Record<string, string>,
): Promise<void> {
  const failures: unknown[] = [];
  let shouldRemoveContainer = false;
  try {
    shouldRemoveContainer = await isExactManagedContainer(containerName, labels);
  } catch (error) {
    failures.push(error);
  }

  if (shouldRemoveContainer) {
    try {
      await runDockerCleanupCommand(
        ['rm', '--force', containerName],
        'Docker container cleanup',
        /\bno such (?:container|object)\b/iu,
      );
    } catch (error) {
      failures.push(error);
    }
  }

  if (builtImage) {
    try {
      await runDockerCleanupCommand(
        ['image', 'rm', '--force', image],
        'Docker image cleanup',
        /\bno such image\b/iu,
      );
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    const detail = failures
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join('; ');
    throw createDockerCommandError(`Docker runner cleanup failed: ${detail}`, failures);
  }
}

export async function createDockerAgentRunnerLaunch(
  request: DockerAgentRunnerLaunchRequest,
): Promise<DockerAgentRunnerLaunch> {
  assertExistingHostPath(request.cwd, 'cwd');

  const dockerfilePath = resolveDockerfilePath(request.profile, request.cwd);
  if (!request.profile.image && dockerfilePath === undefined) {
    throw new BadRequestError('Docker agent runner requires an image or dockerfile');
  }

  const workspaceMountTarget = request.profile.workspaceMountTarget ?? '/workspace';
  const workdir = request.profile.workdir ?? workspaceMountTarget;
  assertAbsoluteContainerPath(workspaceMountTarget, 'agentRunnerProfile.workspaceMountTarget');
  assertAbsoluteContainerPath(workdir, 'agentRunnerProfile.workdir');
  assertDockerMountValueSafe(request.cwd, 'cwd');
  assertDockerMountValueSafe(workspaceMountTarget, 'agentRunnerProfile.workspaceMountTarget');
  const profileMountArgs = (request.profile.mounts ?? []).map((mount) =>
    createMountArg(mount, request.cwd),
  );
  const dockerEnv = collectDockerEnv(request.profile, request.env);

  await assertDockerAvailable(request.signal);

  const runnerInstanceId = createRunnerInstanceId();
  const { builtImage, image } = await resolveImage(
    request.profile,
    request.cwd,
    dockerfilePath,
    runnerInstanceId,
    request,
    request.signal,
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

  const dockerArgs = ['run', '--rm', '--name', containerName, '--interactive', '--tty'];
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
  let cleanupPromise: Promise<void> | undefined;

  return {
    args: dockerArgs,
    command: 'docker',
    cleanup: () => {
      if (!cleanupPromise) {
        cleanupPromise = cleanupDockerAgentRunnerResources(
          containerName,
          image,
          builtImage,
          labels,
        ).catch((error: unknown) => {
          cleanupPromise = undefined;
          throw error;
        });
      }
      return cleanupPromise;
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
