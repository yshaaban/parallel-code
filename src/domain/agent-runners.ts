import { isRecord } from '../lib/type-guards.js';
import type { ProjectContainerConfig } from './task-containers.js';

export const AGENT_RUNNER_PROVIDERS = ['host', 'docker-container', 'docker-sandbox'] as const;

export type AgentRunnerProvider = (typeof AGENT_RUNNER_PROVIDERS)[number];

export type AgentRunnerStatus =
  | 'not_configured'
  | 'preflight_pending'
  | 'preflight_failed'
  | 'ready'
  | 'preparing'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'orphaned'
  | 'cleaned';

export const AGENT_RUNNER_ISSUE_CODES = [
  'docker_unavailable',
  'docker_daemon_unreachable',
  'docker_image_missing',
  'docker_build_failed',
  'dockerfile_invalid',
  'workspace_mount_invalid',
  'env_policy_rejected',
  'resource_limit_invalid',
  'network_policy_rejected',
  'container_name_conflict',
  'container_start_failed',
  'pty_attach_failed',
  'container_orphaned',
  'cleanup_failed',
  'sandbox_unavailable',
  'sandbox_auth_required',
] as const;

export type AgentRunnerIssueCode = (typeof AGENT_RUNNER_ISSUE_CODES)[number];
export type AgentRunnerIssueSeverity = 'warning' | 'error';

const AGENT_RUNNER_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const BLOCKED_AGENT_RUNNER_ENV_NAMES = new Set([
  'DYLD_INSERT_LIBRARIES',
  'ELECTRON_RUN_AS_NODE',
  'HOME',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PATH',
  'SHELL',
  'USER',
]);

export interface AgentRunnerIssue {
  code: AgentRunnerIssueCode;
  message: string;
  severity: AgentRunnerIssueSeverity;
}

export interface AgentRunnerMountConfig {
  readonly?: boolean;
  source: string;
  target: string;
}

export interface AgentRunnerResourceConfig {
  cpus?: string;
  memory?: string;
}

export interface AgentRunnerNetworkConfig {
  mode?: 'bridge' | 'none' | 'host';
}

export interface AgentRunnerProfileConfig {
  dockerfile?: string;
  env?: Record<string, string>;
  envAllowlist?: string[];
  image?: string;
  mounts?: AgentRunnerMountConfig[];
  network?: AgentRunnerNetworkConfig;
  provider: AgentRunnerProvider;
  resources?: AgentRunnerResourceConfig;
  user?: string;
  workdir?: string;
  workspaceMountTarget?: string;
}

export type AgentRunnerProfileSource = 'default' | 'project-config' | 'legacy-container-config';

export interface AgentRunnerProfileResolution {
  activeProvider: AgentRunnerProvider;
  configuredProfile: AgentRunnerProfileConfig | null;
  message: string | null;
  source: AgentRunnerProfileSource;
  status: 'not_configured' | 'resolved' | 'unsupported';
}

export interface AgentRuntimeIdentity {
  agentId: string;
  containerId?: string;
  containerName?: string;
  imageRef?: string;
  labels: Record<string, string>;
  profileId: string;
  provider: AgentRunnerProvider;
  runnerInstanceId: string;
  startedAt: string;
  stoppedAt?: string;
  taskId: string;
}

export function createHostAgentRunnerResolution(): AgentRunnerProfileResolution {
  return {
    activeProvider: 'host',
    configuredProfile: null,
    message: 'No agent runner is configured; agents run on the host.',
    source: 'default',
    status: 'not_configured',
  };
}

export function isAgentRunnerProvider(value: unknown): value is AgentRunnerProvider {
  return typeof value === 'string' && AGENT_RUNNER_PROVIDERS.some((provider) => provider === value);
}

export function isValidAgentRunnerEnvName(value: string): boolean {
  return AGENT_RUNNER_ENV_NAME_PATTERN.test(value);
}

export function isAllowedAgentRunnerEnvName(value: string): boolean {
  return isValidAgentRunnerEnvName(value) && !BLOCKED_AGENT_RUNNER_ENV_NAMES.has(value);
}

function parseOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === 'string' ? value : null;
}

function parseOptionalStringRecord(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return null;
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return null;
    }

    record[key] = entry;
  }
  return record;
}

function parseOptionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return null;
  }

  return [...value];
}

function parseOptionalMounts(value: unknown): AgentRunnerMountConfig[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const mounts: AgentRunnerMountConfig[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.source !== 'string' ||
      typeof entry.target !== 'string' ||
      (entry.readonly !== undefined && typeof entry.readonly !== 'boolean')
    ) {
      return null;
    }

    mounts.push({
      ...(entry.readonly !== undefined ? { readonly: entry.readonly } : {}),
      source: entry.source,
      target: entry.target,
    });
  }
  return mounts;
}

function parseOptionalNetwork(value: unknown): AgentRunnerNetworkConfig | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (
    value.mode !== undefined &&
    value.mode !== 'bridge' &&
    value.mode !== 'none' &&
    value.mode !== 'host'
  ) {
    return null;
  }

  return {
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
  };
}

function parseOptionalResources(value: unknown): AgentRunnerResourceConfig | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return null;
  }

  const cpus = parseOptionalString(value.cpus);
  const memory = parseOptionalString(value.memory);
  if (cpus === null || memory === null) {
    return null;
  }

  return {
    ...(cpus !== undefined ? { cpus } : {}),
    ...(memory !== undefined ? { memory } : {}),
  };
}

export function parseAgentRunnerProfileConfig(
  value: unknown,
): AgentRunnerProfileConfig | undefined {
  if (!isRecord(value) || !isAgentRunnerProvider(value.provider)) {
    return undefined;
  }

  const dockerfile = parseOptionalString(value.dockerfile);
  const env = parseOptionalStringRecord(value.env);
  const envAllowlist = parseOptionalStringArray(value.envAllowlist);
  const image = parseOptionalString(value.image);
  const mounts = parseOptionalMounts(value.mounts);
  const network = parseOptionalNetwork(value.network);
  const resources = parseOptionalResources(value.resources);
  const user = parseOptionalString(value.user);
  const workdir = parseOptionalString(value.workdir);
  const workspaceMountTarget = parseOptionalString(value.workspaceMountTarget);
  if (
    dockerfile === null ||
    env === null ||
    envAllowlist === null ||
    image === null ||
    mounts === null ||
    network === null ||
    resources === null ||
    user === null ||
    workdir === null ||
    workspaceMountTarget === null
  ) {
    return undefined;
  }

  return {
    ...(dockerfile !== undefined ? { dockerfile } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(envAllowlist !== undefined ? { envAllowlist } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(mounts !== undefined ? { mounts } : {}),
    ...(network !== undefined ? { network } : {}),
    provider: value.provider,
    ...(resources !== undefined ? { resources } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(workdir !== undefined ? { workdir } : {}),
    ...(workspaceMountTarget !== undefined ? { workspaceMountTarget } : {}),
  };
}

function isRunnableDockerContainerProfile(profile: AgentRunnerProfileConfig): boolean {
  return profile.provider !== 'docker-container' || Boolean(profile.image || profile.dockerfile);
}

function createUnsupportedDockerRunnerResolution(
  configuredProfile: AgentRunnerProfileConfig,
  source: Exclude<AgentRunnerProfileSource, 'default'>,
): AgentRunnerProfileResolution {
  return {
    activeProvider: 'docker-container',
    configuredProfile,
    message: 'Docker container agent runners require an image or Dockerfile.',
    source,
    status: 'unsupported',
  };
}

function getResolvedProjectRunnerMessage(
  profile: AgentRunnerProfileConfig,
): AgentRunnerProfileResolution['message'] {
  if (profile.provider === 'docker-sandbox') {
    return 'Docker sandbox agent runners are reserved for a future provider and are not supported by this build.';
  }

  return null;
}

function getResolvedProjectRunnerStatus(
  profile: AgentRunnerProfileConfig,
): AgentRunnerProfileResolution['status'] {
  if (profile.provider === 'docker-sandbox') {
    return 'unsupported';
  }

  return 'resolved';
}

export function resolveAgentRunnerProfile(
  projectRunnerConfig: AgentRunnerProfileConfig | undefined,
  projectContainerConfig?: ProjectContainerConfig,
): AgentRunnerProfileResolution {
  if (projectRunnerConfig) {
    if (!isRunnableDockerContainerProfile(projectRunnerConfig)) {
      return createUnsupportedDockerRunnerResolution(projectRunnerConfig, 'project-config');
    }

    return {
      activeProvider: projectRunnerConfig.provider,
      configuredProfile: projectRunnerConfig,
      message: getResolvedProjectRunnerMessage(projectRunnerConfig),
      source: 'project-config',
      status: getResolvedProjectRunnerStatus(projectRunnerConfig),
    };
  }

  const legacyProfile = projectContainerConfig?.runnerProfile;
  if (legacyProfile?.kind === 'docker') {
    const configuredProfile: AgentRunnerProfileConfig = {
      ...(legacyProfile.dockerfile !== undefined ? { dockerfile: legacyProfile.dockerfile } : {}),
      ...(legacyProfile.image !== undefined ? { image: legacyProfile.image } : {}),
      provider: 'docker-container',
    };
    if (!isRunnableDockerContainerProfile(configuredProfile)) {
      return createUnsupportedDockerRunnerResolution(configuredProfile, 'legacy-container-config');
    }

    return {
      activeProvider: 'docker-container',
      configuredProfile,
      message:
        'Using the legacy Docker runner profile from the task-container configuration for agent execution.',
      source: 'legacy-container-config',
      status: 'resolved',
    };
  }

  return createHostAgentRunnerResolution();
}
