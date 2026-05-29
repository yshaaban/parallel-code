import { execFile } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { promisify } from 'util';

import type {
  ProjectContainerConfig,
  ProjectContainerRunnerProfileConfig,
  TaskContainerInspectResult,
  TaskContainerIssue,
  TaskContainerIssueCode,
  TaskContainerLifecycleAction,
  TaskContainerLogsResult,
  TaskContainerPreview,
  TaskContainerPublishedPort,
  TaskContainerRunnerProfileResolution,
  TaskContainerServiceSnapshot,
  TaskContainerServiceState,
} from '../../src/domain/task-containers.js';
import { createTaskContainerIdentity } from './task-container-identity.js';
import {
  isLoopbackTaskPreviewHost,
  normalizeTaskPreviewHost,
} from '../../src/domain/server-state.js';

const execFileAsync = promisify(execFile);

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 1_000;
const COMPOSE_FILE_CANDIDATES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
] as const;
const taskContainerPreviewTargets = new Map<string, Map<number, string>>();

interface TaskContainerActionRequest {
  projectContainerConfig?: ProjectContainerConfig;
  projectPath: string;
  taskId: string;
  userDataPath: string;
  worktreePath: string;
}

interface TaskContainerRuntimeAvailability {
  available: boolean;
  message: string | null;
}

interface TaskContainerComposeSelection {
  composeFile: string;
  issues: TaskContainerIssue[];
  status: TaskContainerInspectResult['status'];
}

interface UnsupportedRunnerProfileSelection {
  inspect: TaskContainerInspectResult;
  supported: false;
}

interface SupportedRunnerProfileSelection {
  runnerProfile: TaskContainerRunnerProfileResolution;
  supported: true;
}

type TaskContainerRunnerProfileSelection =
  | SupportedRunnerProfileSelection
  | UnsupportedRunnerProfileSelection;

interface ComposeFileContainmentResult {
  composeFile: string;
  issue: TaskContainerIssue | null;
}

interface DockerComposePublishedPort {
  host: string | null;
  port: number;
  protocol: 'http' | 'https';
  serviceName: string;
  targetPort: number | null;
}

interface DockerComposeServiceStatus {
  containerId: string | null;
  health: string | null;
  name: string;
  publishedPorts: DockerComposePublishedPort[];
  state: TaskContainerServiceState;
}

interface DockerComposeProjectStatus {
  publishedPorts: DockerComposePublishedPort[];
  services: DockerComposeServiceStatus[];
}

interface DockerComposeServiceConfig {
  container_name?: unknown;
  env_file?: unknown;
  ports?: unknown;
}

interface DockerComposeNamedResourceConfig {
  external?: unknown;
  name?: unknown;
}

interface DockerComposeConfig {
  networks?: Record<string, DockerComposeNamedResourceConfig>;
  services?: Record<string, DockerComposeServiceConfig>;
  volumes?: Record<string, DockerComposeNamedResourceConfig>;
}

export interface TaskContainerRuntime {
  cleanupManagedProjectByLabels: (request: {
    action: Extract<TaskContainerLifecycleAction, 'stop' | 'destroy'>;
    composeProjectName: string;
    ownershipLabels: Record<string, string>;
    worktreePath: string;
  }) => Promise<void>;
  composeDown: (request: {
    composeFile: string;
    composeProjectName: string;
    worktreePath: string;
  }) => Promise<void>;
  composeLogs: (request: {
    composeFile: string;
    composeProjectName: string;
    lines: number;
    worktreePath: string;
  }) => Promise<string>;
  composeStop: (request: {
    composeFile: string;
    composeProjectName: string;
    worktreePath: string;
  }) => Promise<void>;
  composeUp: (request: {
    composeFile: string;
    composeProjectName: string;
    overrideFile: string;
    worktreePath: string;
  }) => Promise<void>;
  getComposeConfig: (request: {
    composeFile: string;
    composeProjectName: string;
    worktreePath: string;
  }) => Promise<DockerComposeConfig>;
  getComposeConfigErrorIssue: (worktreePath: string, error: unknown) => TaskContainerIssue;
  getComposeProjectStatus: (request: {
    composeFile: string;
    composeProjectName: string;
    worktreePath: string;
  }) => Promise<DockerComposeProjectStatus>;
  getComposeRuntimeAvailability: () => Promise<TaskContainerRuntimeAvailability>;
  getDockerRuntimeAvailability: () => Promise<TaskContainerRuntimeAvailability>;
}

type TaskContainerPlanOperation =
  | {
      action: Extract<TaskContainerLifecycleAction, 'stop' | 'destroy'>;
      composeProjectName: string;
      kind: 'cleanup_managed_project_by_labels';
      ownershipLabels: Record<string, string>;
      worktreePath: string;
    }
  | {
      composeFile: string;
      composeProjectName: string;
      kind: 'compose_down';
      worktreePath: string;
    }
  | {
      composeFile: string;
      composeProjectName: string;
      kind: 'compose_stop';
      worktreePath: string;
    }
  | {
      composeFile: string;
      composeProjectName: string;
      kind: 'compose_up';
      overrideFile: string;
      worktreePath: string;
    }
  | {
      contents: string;
      filePath: string;
      kind: 'write_override_file';
    };

function createIssue(
  code: TaskContainerIssueCode,
  message: string,
  severity: TaskContainerIssue['severity'] = 'error',
): TaskContainerIssue {
  return {
    code,
    message,
    severity,
  };
}

function createInspectResult(
  taskId: string,
  overrides: Partial<TaskContainerInspectResult>,
): TaskContainerInspectResult {
  return {
    composeFile: null,
    issues: [],
    observedAt: Date.now(),
    previews: [],
    projectName: null,
    publishedPorts: [],
    runtime: null,
    ...(overrides.runnerProfile ? { runnerProfile: overrides.runnerProfile } : {}),
    services: [],
    status: 'not_configured',
    taskId,
    ...overrides,
  };
}

function normalizeConfiguredRunnerProfile(
  runnerProfile: ProjectContainerRunnerProfileConfig,
): ProjectContainerRunnerProfileConfig {
  return {
    ...(runnerProfile.dockerfile !== undefined ? { dockerfile: runnerProfile.dockerfile } : {}),
    ...(runnerProfile.image !== undefined ? { image: runnerProfile.image } : {}),
    kind: runnerProfile.kind,
  };
}

function createDefaultRunnerProfileResolution(): TaskContainerRunnerProfileResolution {
  return {
    activeProfile: 'compose',
    configuredProfile: null,
    fallbackProfile: 'compose',
    message:
      'No runner profile is configured; using the Docker Compose task-container profile when a supported Compose file is present.',
    source: 'default',
    status: 'not_configured',
  };
}

function resolveTaskContainerRunnerProfile(
  projectConfig: ProjectContainerConfig | undefined,
): TaskContainerRunnerProfileResolution {
  const configuredProfile = projectConfig?.runnerProfile;
  if (!configuredProfile) {
    return createDefaultRunnerProfileResolution();
  }

  const normalizedProfile = normalizeConfiguredRunnerProfile(configuredProfile);
  if (normalizedProfile.kind === 'compose') {
    return {
      activeProfile: 'compose',
      configuredProfile: normalizedProfile,
      fallbackProfile: null,
      message: null,
      source: 'project-config',
      status: 'resolved',
    };
  }

  return {
    activeProfile: null,
    configuredProfile: normalizedProfile,
    fallbackProfile: null,
    message:
      'Docker runner profiles require a separate backend runner execution policy and are not supported by task-container lifecycle yet.',
    source: 'project-config',
    status: 'unsupported',
  };
}

function selectTaskContainerRunnerProfile(
  request: TaskContainerActionRequest,
): TaskContainerRunnerProfileSelection {
  const runnerProfile = resolveTaskContainerRunnerProfile(request.projectContainerConfig);
  if (runnerProfile.status !== 'unsupported') {
    return {
      runnerProfile,
      supported: true,
    };
  }

  return {
    inspect: createInspectResult(request.taskId, {
      issues: [createIssue('unsupported_runner_profile', runnerProfile.message ?? '')],
      runnerProfile,
      status: 'unsupported',
    }),
    supported: false,
  };
}

function createDockerRuntime(): TaskContainerRuntime {
  return {
    cleanupManagedProjectByLabels: async ({
      action,
      composeProjectName,
      ownershipLabels,
    }): Promise<void> => {
      const labelFilters = [
        createDockerLabelFilters(ownershipLabels),
        createDockerLabelFilters({
          'com.docker.compose.project': composeProjectName,
        }),
      ];
      if (action === 'stop') {
        const runningContainerIds = await listDockerIdsForLabelSets(['ps', '-q'], labelFilters);
        if (runningContainerIds.length > 0) {
          await execDocker(['stop', ...runningContainerIds]);
        }
        return;
      }

      const containerIds = await listDockerIdsForLabelSets(['ps', '-aq'], labelFilters);
      if (containerIds.length > 0) {
        await execDocker(['rm', '-f', ...containerIds]);
      }

      const networkIds = await listDockerIdsForLabelSets(['network', 'ls', '-q'], labelFilters);
      if (networkIds.length > 0) {
        await execDocker(['network', 'rm', ...networkIds]);
      }

      const volumeIds = await listDockerIdsForLabelSets(['volume', 'ls', '-q'], labelFilters);
      if (volumeIds.length > 0) {
        await execDocker(['volume', 'rm', '-f', ...volumeIds]);
      }
    },
    getDockerRuntimeAvailability: async (): Promise<TaskContainerRuntimeAvailability> => {
      try {
        await execDocker(['version', '--format', '{{json .Client.Version}}']);
        return { available: true, message: null };
      } catch (error) {
        return {
          available: false,
          message: getCommandErrorMessage(error, 'Docker is not available on PATH'),
        };
      }
    },
    getComposeRuntimeAvailability: async (): Promise<TaskContainerRuntimeAvailability> => {
      try {
        await execDocker(['compose', 'version']);
        return { available: true, message: null };
      } catch (error) {
        return {
          available: false,
          message: getCommandErrorMessage(error, 'Docker Compose is not available'),
        };
      }
    },
    getComposeConfig: async ({
      composeFile,
      composeProjectName,
      worktreePath,
    }): Promise<DockerComposeConfig> => {
      const stdout = await execDocker(
        ['compose', '-p', composeProjectName, '-f', composeFile, 'config', '--format', 'json'],
        worktreePath,
      );
      const parsed = JSON.parse(stdout) as unknown;
      if (!isRecord(parsed)) {
        throw new Error('Docker Compose returned an invalid config payload');
      }
      return parsed as DockerComposeConfig;
    },
    getComposeConfigErrorIssue: (worktreePath, error): TaskContainerIssue => {
      const message = getCommandErrorMessage(error, 'Failed to read Docker Compose config');
      const envFileMatch =
        /env file\s+(?<path>\S+)\s+not found/iu.exec(message) ??
        /couldn't find env file:\s+(?<path>\S+)/iu.exec(message);

      if (envFileMatch?.groups?.path) {
        return createIssue(
          'missing_required_env_file',
          `Required env file is missing: ${resolveDisplayPath(worktreePath, envFileMatch.groups.path)}`,
        );
      }

      return createIssue('compose_config_failed', message);
    },
    getComposeProjectStatus: async ({
      composeFile,
      composeProjectName,
      worktreePath,
    }): Promise<DockerComposeProjectStatus> => {
      const stdout = await execDocker(
        ['compose', '-p', composeProjectName, '-f', composeFile, 'ps', '--all', '--format', 'json'],
        worktreePath,
      ).catch((error) => {
        const message = getCommandErrorMessage(error, '');
        if (/no such service|no containers/i.test(message)) {
          return '[]';
        }

        throw error;
      });

      const rows = parseComposePsRows(stdout);
      const services = rows.map((row) => createComposeServiceStatus(row));
      return {
        publishedPorts: services.flatMap((service) => service.publishedPorts),
        services,
      };
    },
    composeUp: async ({
      composeFile,
      composeProjectName,
      overrideFile,
      worktreePath,
    }): Promise<void> => {
      await execDocker(
        [
          'compose',
          '-p',
          composeProjectName,
          '-f',
          composeFile,
          '-f',
          overrideFile,
          'up',
          '-d',
          '--build',
          '--remove-orphans',
        ],
        worktreePath,
      );
    },
    composeStop: async ({ composeFile, composeProjectName, worktreePath }): Promise<void> => {
      await execDocker(
        ['compose', '-p', composeProjectName, '-f', composeFile, 'stop'],
        worktreePath,
      );
    },
    composeDown: async ({ composeFile, composeProjectName, worktreePath }): Promise<void> => {
      await execDocker(
        [
          'compose',
          '-p',
          composeProjectName,
          '-f',
          composeFile,
          'down',
          '--remove-orphans',
          '--volumes',
        ],
        worktreePath,
      );
    },
    composeLogs: async ({
      composeFile,
      composeProjectName,
      lines,
      worktreePath,
    }): Promise<string> => {
      return execDocker(
        [
          'compose',
          '-p',
          composeProjectName,
          '-f',
          composeFile,
          'logs',
          '--no-color',
          '--tail',
          String(lines),
        ],
        worktreePath,
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getCommandErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const stderr = 'stderr' in error ? error.stderr : undefined;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim();
    }

    const message = 'message' in error ? error.message : undefined;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
  }

  return fallback;
}

async function execDocker(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('docker', args, {
    ...(cwd ? { cwd } : {}),
    maxBuffer: 10 * 1024 * 1024,
  });

  return result.stdout;
}

function resolveDisplayPath(worktreePath: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.join(worktreePath, filePath);
}

function createDockerLabelFilters(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`]);
}

function splitDockerIds(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function listDockerIdsForLabelSets(
  args: string[],
  labelFilterSets: string[][],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const labelFilters of labelFilterSets) {
    const stdout = await execDocker([...args, ...labelFilters]);
    for (const id of splitDockerIds(stdout)) {
      ids.add(id);
    }
  }
  return [...ids];
}

function createComposeServiceStatus(row: Record<string, unknown>): DockerComposeServiceStatus {
  const state = normalizeComposeServiceState(
    typeof row.State === 'string' ? row.State : typeof row.state === 'string' ? row.state : '',
  );
  const health =
    typeof row.Health === 'string'
      ? row.Health
      : typeof row.health === 'string'
        ? row.health
        : null;
  const serviceName =
    typeof row.Service === 'string'
      ? row.Service
      : typeof row.service === 'string'
        ? row.service
        : typeof row.Name === 'string'
          ? row.Name
          : 'service';

  return {
    containerId:
      typeof row.ID === 'string' ? row.ID : typeof row.ID === 'number' ? String(row.ID) : null,
    health,
    name: serviceName,
    publishedPorts: parseComposePublishers(row.Publishers, serviceName),
    state,
  };
}

function normalizeComposeServiceState(rawState: string): TaskContainerServiceState {
  const normalized = rawState.trim().toLowerCase();
  if (normalized.includes('running')) {
    return 'running';
  }
  if (normalized.includes('restarting')) {
    return 'restarting';
  }
  if (normalized.includes('exited')) {
    return 'exited';
  }
  if (normalized.includes('created')) {
    return 'created';
  }
  if (normalized.includes('stopped')) {
    return 'stopped';
  }
  if (normalized.length === 0) {
    return 'missing';
  }

  return 'unknown';
}

function parseComposePsRows(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }

  if (isRecord(parsed)) {
    return [parsed];
  }

  return [];
}

function parseComposePublishers(value: unknown, serviceName: string): DockerComposePublishedPort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const publishedPorts: DockerComposePublishedPort[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const publishedPort = readInteger(entry.PublishedPort ?? entry.publishedPort);
    if (publishedPort === null) {
      continue;
    }

    const targetPort = readInteger(entry.TargetPort ?? entry.targetPort);
    const protocol = normalizePortProtocol(entry.Protocol ?? entry.protocol);
    const host = normalizeTaskPreviewHost(
      typeof entry.URL === 'string'
        ? entry.URL
        : typeof entry.HostIP === 'string'
          ? entry.HostIP
          : null,
    );

    publishedPorts.push({
      host,
      port: publishedPort,
      protocol,
      serviceName,
      targetPort,
    });
  }

  return publishedPorts;
}

function readInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }

  return null;
}

function normalizePortProtocol(value: unknown): 'http' | 'https' {
  return typeof value === 'string' && value.toLowerCase() === 'https' ? 'https' : 'http';
}

function isPathInsideDirectory(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  const firstSegment = relativePath.split(/[\\/]/)[0];
  return relativePath.length === 0 || (firstSegment !== '..' && !path.isAbsolute(relativePath));
}

function createComposeOutsideWorktreeIssue(): TaskContainerIssue {
  return createIssue(
    'unsupported_compose_feature',
    'Configured Compose file must stay inside the task worktree.',
  );
}

function resolveContainedComposeFile(
  worktreePath: string,
  configuredComposeFile: string,
): ComposeFileContainmentResult {
  const composeFile = path.resolve(worktreePath, configuredComposeFile);
  if (!isPathInsideDirectory(worktreePath, composeFile)) {
    return {
      composeFile: '',
      issue: createComposeOutsideWorktreeIssue(),
    };
  }

  let fileStats: fs.Stats;
  try {
    fileStats = fs.lstatSync(composeFile);
  } catch {
    return {
      composeFile,
      issue: null,
    };
  }

  try {
    if (fileStats.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(composeFile);
      const resolvedLinkTarget = path.resolve(path.dirname(composeFile), linkTarget);
      if (!isPathInsideDirectory(worktreePath, resolvedLinkTarget)) {
        return {
          composeFile: '',
          issue: createComposeOutsideWorktreeIssue(),
        };
      }
    }

    const realWorktreePath = fs.realpathSync(worktreePath);
    const realComposeFile = fs.realpathSync(composeFile);
    if (!isPathInsideDirectory(realWorktreePath, realComposeFile)) {
      return {
        composeFile: '',
        issue: createComposeOutsideWorktreeIssue(),
      };
    }
  } catch {
    return {
      composeFile,
      issue: createIssue(
        'compose_file_missing',
        `Configured Compose file was not found: ${composeFile}`,
      ),
    };
  }

  return {
    composeFile,
    issue: null,
  };
}

function resolveComposeSelection(
  request: TaskContainerActionRequest,
): TaskContainerComposeSelection {
  if (!fs.existsSync(request.worktreePath)) {
    return {
      composeFile: '',
      issues: [
        createIssue(
          'task_worktree_missing',
          `Task worktree no longer exists: ${request.worktreePath}`,
        ),
      ],
      status: 'error',
    };
  }

  const configuredComposeFile = request.projectContainerConfig?.composeFile?.trim();
  if (configuredComposeFile) {
    const containedComposeFile = resolveContainedComposeFile(
      request.worktreePath,
      configuredComposeFile,
    );
    if (containedComposeFile.issue?.code === 'unsupported_compose_feature') {
      return {
        composeFile: '',
        issues: [containedComposeFile.issue],
        status: 'unsupported',
      };
    }

    const composeFile = containedComposeFile.composeFile;
    if (containedComposeFile.issue) {
      return {
        composeFile,
        issues: [containedComposeFile.issue],
        status: 'not_configured',
      };
    }

    if (!fs.existsSync(composeFile)) {
      return {
        composeFile,
        issues: [
          createIssue(
            'compose_file_missing',
            `Configured Compose file was not found: ${composeFile}`,
          ),
        ],
        status: 'not_configured',
      };
    }

    return {
      composeFile,
      issues: [],
      status: 'ready',
    };
  }

  const candidateResults = COMPOSE_FILE_CANDIDATES.map((fileName) =>
    resolveContainedComposeFile(request.worktreePath, fileName),
  );

  const existingCandidates = candidateResults.filter(
    (result) => !result.issue && fs.existsSync(result.composeFile),
  );

  if (existingCandidates.length > 1) {
    const composeFiles = existingCandidates.map((candidate) => candidate.composeFile);
    return {
      composeFile: '',
      issues: [
        createIssue(
          'multiple_compose_files_unsupported',
          `Multiple Compose files were found. Configure one explicit file to enable task containers: ${composeFiles.map((filePath) => path.basename(filePath)).join(', ')}`,
        ),
      ],
      status: 'unsupported',
    };
  }

  if (existingCandidates.length === 1) {
    const candidate = existingCandidates[0];
    return {
      composeFile: candidate?.composeFile ?? '',
      issues: [],
      status: 'ready',
    };
  }

  const unsupportedCandidate = candidateResults.find(
    (candidate) => candidate.issue?.code === 'unsupported_compose_feature',
  );
  if (unsupportedCandidate?.issue) {
    return {
      composeFile: '',
      issues: [unsupportedCandidate.issue],
      status: 'unsupported',
    };
  }

  return {
    composeFile: '',
    issues: [
      createIssue(
        'compose_file_missing',
        'No supported Compose file was found in the task worktree.',
      ),
    ],
    status: 'not_configured',
  };
}

function collectComposeConfigIssues(
  config: DockerComposeConfig,
  composeProjectName: string,
  request: TaskContainerActionRequest,
  projectStatus: DockerComposeProjectStatus,
  composeFile: string,
): TaskContainerIssue[] {
  const issues: TaskContainerIssue[] = [];

  for (const [serviceName, service] of Object.entries(config.services ?? {})) {
    if (typeof service.container_name === 'string' && service.container_name.trim().length > 0) {
      issues.push(
        createIssue(
          'explicit_container_name',
          `Service "${serviceName}" sets container_name, which prevents task-scoped isolation.`,
        ),
      );
    }
  }

  for (const [networkName, network] of Object.entries(config.networks ?? {})) {
    if (network.external === true) {
      issues.push(
        createIssue(
          'external_network_declared',
          `Network "${networkName}" is external, so it cannot be owned safely by one task.`,
        ),
      );
    }
    if (typeof network.name === 'string' && network.name.trim().length > 0) {
      if (isGeneratedComposeResourceName(networkName, network.name, composeProjectName)) {
        continue;
      }
      issues.push(
        createIssue(
          'named_network',
          `Network "${networkName}" sets an explicit global name, which breaks task isolation.`,
        ),
      );
    }
  }

  for (const [volumeName, volume] of Object.entries(config.volumes ?? {})) {
    if (volume.external === true) {
      issues.push(
        createIssue(
          'external_volume_declared',
          `Volume "${volumeName}" is external, so it cannot be owned safely by one task.`,
        ),
      );
    }
    if (typeof volume.name === 'string' && volume.name.trim().length > 0) {
      if (isGeneratedComposeResourceName(volumeName, volume.name, composeProjectName)) {
        continue;
      }
      issues.push(
        createIssue(
          'named_volume',
          `Volume "${volumeName}" sets an explicit global name, which breaks task isolation.`,
        ),
      );
    }
  }

  for (const requiredEnvFile of resolveRequiredEnvFiles(
    config,
    request.projectContainerConfig,
    request.worktreePath,
    composeFile,
  )) {
    if (!fs.existsSync(requiredEnvFile)) {
      issues.push(
        createIssue(
          'missing_required_env_file',
          `Required env file is missing: ${requiredEnvFile}`,
        ),
      );
    }
  }

  const ownedPublishedPortSet = new Set(projectStatus.publishedPorts.map((port) => port.port));
  for (const publishedPort of collectConfiguredPublishedHostPorts(config)) {
    if (ownedPublishedPortSet.has(publishedPort)) {
      continue;
    }

    issues.push(
      createIssue(
        'fixed_host_port_conflict',
        `Host port ${publishedPort} is fixed by the Compose project and must be free before this task can start.`,
        'warning',
      ),
    );
  }

  return issues;
}

function isGeneratedComposeResourceName(
  resourceName: string,
  configuredName: string,
  composeProjectName: string,
): boolean {
  return configuredName === `${composeProjectName}_${resourceName}`;
}

async function promotePortConflictsToErrors(
  issues: TaskContainerIssue[],
  config: DockerComposeConfig,
  projectStatus: DockerComposeProjectStatus,
): Promise<TaskContainerIssue[]> {
  const fixedPorts = collectConfiguredPublishedHostPorts(config);
  if (fixedPorts.length === 0) {
    return issues;
  }

  const ownedPublishedPortSet = new Set(projectStatus.publishedPorts.map((port) => port.port));
  const nextIssues: TaskContainerIssue[] = [];
  for (const issue of issues) {
    if (issue.code !== 'fixed_host_port_conflict') {
      nextIssues.push(issue);
      continue;
    }

    const match = /\b(\d+)\b/u.exec(issue.message);
    const port = match ? Number.parseInt(match[1] ?? '', 10) : null;
    if (port === null || ownedPublishedPortSet.has(port) || (await isPortAvailable(port))) {
      continue;
    }

    nextIssues.push({
      ...issue,
      severity: 'error',
      message: `Host port ${port} is already in use, so this task-scoped Compose project cannot start safely.`,
    });
  }

  return nextIssues;
}

function resolveRequiredEnvFiles(
  config: DockerComposeConfig,
  projectConfig: ProjectContainerConfig | undefined,
  worktreePath: string,
  composeFile: string,
): string[] {
  const files = new Set<string>();

  function addRequiredFile(filePath: string, basePath: string): void {
    const trimmedFilePath = filePath.trim();
    if (!trimmedFilePath) {
      return;
    }

    files.add(
      path.isAbsolute(trimmedFilePath)
        ? path.normalize(trimmedFilePath)
        : path.join(basePath, trimmedFilePath),
    );
  }

  for (const configuredFile of projectConfig?.requiredEnvFiles ?? []) {
    addRequiredFile(configuredFile, worktreePath);
  }

  const composeFileDirectory = path.dirname(composeFile);
  for (const service of Object.values(config.services ?? {})) {
    for (const envFile of readEnvFileEntries(service.env_file)) {
      addRequiredFile(envFile, composeFileDirectory);
    }
  }

  return [...files];
}

function readEnvFileEntries(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      entries.push(entry);
      continue;
    }

    if (!isRecord(entry)) {
      continue;
    }

    const envPath = entry.path;
    if (typeof envPath === 'string' && envPath.trim().length > 0) {
      if (entry.required === false) {
        continue;
      }
      entries.push(envPath);
    }
  }

  return entries;
}

function collectConfiguredPublishedHostPorts(config: DockerComposeConfig): number[] {
  const publishedPorts = new Set<number>();
  for (const service of Object.values(config.services ?? {})) {
    for (const port of readConfiguredHostPorts(service.ports)) {
      publishedPorts.add(port);
    }
  }
  return [...publishedPorts].sort((left, right) => left - right);
}

function readConfiguredHostPorts(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ports: number[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const port = parseConfiguredHostPort(entry);
      if (port !== null) {
        ports.push(port);
      }
      continue;
    }

    if (!isRecord(entry)) {
      continue;
    }

    const published = readInteger(entry.published ?? entry.Published);
    if (published !== null) {
      ports.push(published);
    }
  }

  return ports;
}

function parseConfiguredHostPort(entry: string): number | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const slashIndex = trimmed.indexOf('/');
  const withoutProtocol = slashIndex >= 0 ? trimmed.slice(0, slashIndex) : trimmed;
  const segments = withoutProtocol.split(':').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }

  const possibleHostPort = segments[segments.length - 2];
  if (!possibleHostPort) {
    return null;
  }
  return /^\d+$/u.test(possibleHostPort) ? Number.parseInt(possibleHostPort, 10) : null;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    // Probe the loopback interface explicitly. Compose publishes fixed host ports to
    // 127.0.0.1, and an unbound listen() binds the IPv6/dual-stack wildcard instead. On
    // macOS that wildcard does not collide with an existing IPv4 loopback bind, so the
    // conflict would be missed; binding 127.0.0.1 detects it consistently across platforms.
    server.listen(port, '127.0.0.1');
  });
}

function createOverrideFileContents(
  labels: Record<string, string>,
  config: DockerComposeConfig,
): string {
  const lines = ['services:'];

  for (const serviceName of Object.keys(config.services ?? {})) {
    lines.push(`  ${serviceName}:`);
    lines.push('    labels:');
    for (const [key, value] of Object.entries(labels)) {
      lines.push(`      ${escapeYamlString(key)}: ${escapeYamlString(value)}`);
    }
  }

  if (Object.keys(config.networks ?? {}).length > 0) {
    lines.push('networks:');
    for (const networkName of Object.keys(config.networks ?? {})) {
      lines.push(`  ${networkName}:`);
      lines.push('    labels:');
      for (const [key, value] of Object.entries(labels)) {
        lines.push(`      ${escapeYamlString(key)}: ${escapeYamlString(value)}`);
      }
    }
  }

  if (Object.keys(config.volumes ?? {}).length > 0) {
    lines.push('volumes:');
    for (const volumeName of Object.keys(config.volumes ?? {})) {
      lines.push(`  ${volumeName}:`);
      lines.push('    labels:');
      for (const [key, value] of Object.entries(labels)) {
        lines.push(`      ${escapeYamlString(key)}: ${escapeYamlString(value)}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value);
}

function buildOverrideFilePath(userDataPath: string, composeProjectName: string): string {
  return path.join(userDataPath, 'task-containers', `${composeProjectName}.override.compose.yml`);
}

function getPreviews(
  projectConfig: ProjectContainerConfig | undefined,
  publishedPorts: TaskContainerPublishedPort[],
): TaskContainerPreview[] {
  const configuredPreviews = projectConfig?.previewPorts ?? [];
  if (configuredPreviews.length > 0) {
    const previews: TaskContainerPreview[] = [];
    for (const previewPort of configuredPreviews) {
      const publishedPort = publishedPorts.find((entry) => entry.port === previewPort.port);
      if (!publishedPort) {
        continue;
      }

      previews.push({
        label: previewPort.label ?? `Preview ${previewPort.port}`,
        port: publishedPort.port,
        protocol: previewPort.protocol ?? publishedPort.protocol,
        source: 'configured',
      });
    }
    return previews;
  }

  if (publishedPorts.length === 1) {
    const onlyPort = publishedPorts[0];
    if (onlyPort) {
      return [
        {
          label: `Preview ${onlyPort.port}`,
          port: onlyPort.port,
          protocol: onlyPort.protocol,
          source: 'single-published-port',
        },
      ];
    }
  }

  return [];
}

function formatTargetHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function getPublishedPortPreviewHost(
  publishedPort: TaskContainerPublishedPort | undefined,
): string {
  const normalizedHost = normalizeTaskPreviewHost(publishedPort?.host);
  if (normalizedHost && isLoopbackTaskPreviewHost(normalizedHost)) {
    return normalizedHost;
  }

  return '127.0.0.1';
}

function recordTaskContainerPreviewTargets(inspect: TaskContainerInspectResult): void {
  if (inspect.previews.length === 0) {
    taskContainerPreviewTargets.delete(inspect.taskId);
    return;
  }

  const targets = new Map<number, string>();
  for (const preview of inspect.previews) {
    const publishedPort = inspect.publishedPorts.find((entry) => entry.port === preview.port);
    const host = getPublishedPortPreviewHost(publishedPort);
    targets.set(preview.port, `${preview.protocol}://${formatTargetHost(host)}:${preview.port}`);
  }

  if (targets.size === 0) {
    taskContainerPreviewTargets.delete(inspect.taskId);
    return;
  }

  taskContainerPreviewTargets.set(inspect.taskId, targets);
}

export function hasTaskContainerPreviewTarget(taskId: string, port: number): boolean {
  return taskContainerPreviewTargets.get(taskId)?.has(port) ?? false;
}

export function resolveTaskContainerPreviewTarget(taskId: string, port: number): string | null {
  return taskContainerPreviewTargets.get(taskId)?.get(port) ?? null;
}

export function removeTaskContainerPreviewTargets(taskId: string): void {
  taskContainerPreviewTargets.delete(taskId);
}

export function clearTaskContainerPreviewTargets(): void {
  taskContainerPreviewTargets.clear();
}

function createInspectFromSelection(
  request: TaskContainerActionRequest,
  selection: TaskContainerComposeSelection,
  runnerProfile: TaskContainerRunnerProfileResolution,
): TaskContainerInspectResult {
  const projectName =
    selection.status === 'unsupported'
      ? createTaskContainerIdentity({
          projectPath: request.projectPath,
          taskId: request.taskId,
          worktreePath: request.worktreePath,
        }).composeProjectName
      : null;

  return createInspectResult(request.taskId, {
    composeFile: selection.composeFile || null,
    issues: selection.issues,
    projectName,
    runnerProfile,
    runtime: null,
    status: selection.status,
  });
}

function createActionFailureResult(
  inspect: TaskContainerInspectResult,
  error: unknown,
): TaskContainerInspectResult {
  return createActionIssueFailureResult(
    inspect,
    createIssue('compose_config_failed', getCommandErrorMessage(error, 'Container action failed')),
  );
}

function createActionIssueFailureResult(
  inspect: TaskContainerInspectResult,
  issue: TaskContainerIssue,
): TaskContainerInspectResult {
  return {
    ...inspect,
    issues: [
      ...inspect.issues.filter(
        (existingIssue) =>
          existingIssue.code !== issue.code && existingIssue.code !== 'compose_config_failed',
      ),
      issue,
    ],
    observedAt: Date.now(),
    status: 'error',
  };
}

function createComposeStatusFailureResult(
  request: TaskContainerActionRequest,
  composeFile: string,
  composeProjectName: string,
  runnerProfile: TaskContainerRunnerProfileResolution,
  error: unknown,
): TaskContainerInspectResult {
  return createInspectResult(request.taskId, {
    composeFile,
    issues: [
      createIssue(
        'compose_status_failed',
        getCommandErrorMessage(error, 'Failed to inspect Docker Compose project state'),
      ),
    ],
    projectName: composeProjectName,
    runnerProfile,
    runtime: 'docker-compose',
    status: 'error',
  });
}

async function inspectTaskContainersInternal(
  request: TaskContainerActionRequest,
  runtime: TaskContainerRuntime = createDockerRuntime(),
): Promise<TaskContainerInspectResult> {
  const runnerProfileSelection = selectTaskContainerRunnerProfile(request);
  if (!runnerProfileSelection.supported) {
    return runnerProfileSelection.inspect;
  }
  const { runnerProfile } = runnerProfileSelection;

  const selection = resolveComposeSelection(request);
  if (selection.issues.length > 0 || selection.status !== 'ready') {
    return createInspectFromSelection(request, selection, runnerProfile);
  }

  const dockerAvailability = await runtime.getDockerRuntimeAvailability();
  if (!dockerAvailability.available) {
    return createInspectResult(request.taskId, {
      composeFile: selection.composeFile,
      issues: [
        createIssue(
          'docker_unavailable',
          dockerAvailability.message ?? 'Docker is not available on this machine.',
        ),
      ],
      runnerProfile,
      status: 'unsupported',
    });
  }

  const composeAvailability = await runtime.getComposeRuntimeAvailability();
  if (!composeAvailability.available) {
    return createInspectResult(request.taskId, {
      composeFile: selection.composeFile,
      issues: [
        createIssue(
          'compose_unavailable',
          composeAvailability.message ?? 'Docker Compose is not available on this machine.',
        ),
      ],
      runnerProfile,
      runtime: 'docker-compose',
      status: 'unsupported',
    });
  }

  const identity = createTaskContainerIdentity({
    projectPath: request.projectPath,
    taskId: request.taskId,
    worktreePath: request.worktreePath,
  });

  let composeConfig: DockerComposeConfig;
  try {
    composeConfig = await runtime.getComposeConfig({
      composeFile: selection.composeFile,
      composeProjectName: identity.composeProjectName,
      worktreePath: request.worktreePath,
    });
  } catch (error) {
    return createInspectResult(request.taskId, {
      composeFile: selection.composeFile,
      issues: [runtime.getComposeConfigErrorIssue(request.worktreePath, error)],
      projectName: identity.composeProjectName,
      runnerProfile,
      runtime: 'docker-compose',
      status: 'unsupported',
    });
  }

  let projectStatus: DockerComposeProjectStatus;
  try {
    projectStatus = await runtime.getComposeProjectStatus({
      composeFile: selection.composeFile,
      composeProjectName: identity.composeProjectName,
      worktreePath: request.worktreePath,
    });
  } catch (error) {
    return createComposeStatusFailureResult(
      request,
      selection.composeFile,
      identity.composeProjectName,
      runnerProfile,
      error,
    );
  }

  const initialIssues = collectComposeConfigIssues(
    composeConfig,
    identity.composeProjectName,
    request,
    projectStatus,
    selection.composeFile,
  );
  const issues = await promotePortConflictsToErrors(initialIssues, composeConfig, projectStatus);
  const hasErrorIssue = issues.some((issue) => issue.severity === 'error');
  const isRunning = projectStatus.services.some((service) => service.state === 'running');

  return createInspectResult(request.taskId, {
    composeFile: selection.composeFile,
    issues,
    previews: getPreviews(
      request.projectContainerConfig,
      projectStatus.publishedPorts.map(convertPublishedPort),
    ),
    projectName: identity.composeProjectName,
    publishedPorts: projectStatus.publishedPorts.map(convertPublishedPort),
    runnerProfile,
    runtime: 'docker-compose',
    services: projectStatus.services.map(convertServiceSnapshot),
    status: hasErrorIssue ? 'unsupported' : isRunning ? 'running' : 'ready',
  });
}

export async function inspectTaskContainers(
  request: TaskContainerActionRequest,
  runtime: TaskContainerRuntime = createDockerRuntime(),
): Promise<TaskContainerInspectResult> {
  const result = await inspectTaskContainersInternal(request, runtime);
  recordTaskContainerPreviewTargets(result);
  return result;
}

function convertPublishedPort(port: DockerComposePublishedPort): TaskContainerPublishedPort {
  return {
    containerPort: port.targetPort,
    host: port.host,
    port: port.port,
    protocol: port.protocol,
    serviceName: port.serviceName,
  };
}

function convertServiceSnapshot(service: DockerComposeServiceStatus): TaskContainerServiceSnapshot {
  return {
    containerId: service.containerId,
    health: service.health,
    name: service.name,
    publishedPorts: service.publishedPorts.map(convertPublishedPort),
    state: service.state,
  };
}

function planTaskContainerAction(
  action: TaskContainerLifecycleAction,
  inspect: TaskContainerInspectResult,
  request: TaskContainerActionRequest,
  config: DockerComposeConfig | null,
): TaskContainerPlanOperation[] {
  if (!inspect.composeFile || !inspect.projectName) {
    const canUseLabelCleanup =
      inspect.status !== 'not_configured' &&
      !inspect.issues.some((issue) => issue.code === 'docker_unavailable');

    if ((action === 'stop' || action === 'destroy') && canUseLabelCleanup) {
      const identity = createTaskContainerIdentity({
        projectPath: request.projectPath,
        taskId: request.taskId,
        worktreePath: request.worktreePath,
      });
      return [
        {
          action,
          composeProjectName: inspect.projectName ?? identity.composeProjectName,
          kind: 'cleanup_managed_project_by_labels',
          ownershipLabels: identity.ownershipLabels,
          worktreePath: request.worktreePath,
        },
      ];
    }

    return [];
  }

  switch (action) {
    case 'start': {
      if (inspect.status === 'running' || !config) {
        return [];
      }

      const identity = createTaskContainerIdentity({
        projectPath: request.projectPath,
        taskId: request.taskId,
        worktreePath: request.worktreePath,
      });
      const overrideFile = buildOverrideFilePath(request.userDataPath, identity.composeProjectName);
      return [
        {
          contents: createOverrideFileContents(identity.ownershipLabels, config),
          filePath: overrideFile,
          kind: 'write_override_file',
        },
        {
          composeFile: inspect.composeFile,
          composeProjectName: inspect.projectName,
          kind: 'compose_up',
          overrideFile,
          worktreePath: request.worktreePath,
        },
      ];
    }
    case 'stop':
      return inspect.status === 'running'
        ? [
            {
              composeFile: inspect.composeFile,
              composeProjectName: inspect.projectName,
              kind: 'compose_stop',
              worktreePath: request.worktreePath,
            },
          ]
        : [];
    case 'destroy':
      return [
        {
          composeFile: inspect.composeFile,
          composeProjectName: inspect.projectName,
          kind: 'compose_down',
          worktreePath: request.worktreePath,
        },
      ];
    default:
      return [];
  }
}

async function applyTaskContainerPlan(
  operations: ReadonlyArray<TaskContainerPlanOperation>,
  runtime: TaskContainerRuntime,
): Promise<void> {
  for (const operation of operations) {
    switch (operation.kind) {
      case 'cleanup_managed_project_by_labels':
        await runtime.cleanupManagedProjectByLabels(operation);
        break;
      case 'write_override_file':
        fs.mkdirSync(path.dirname(operation.filePath), { recursive: true });
        fs.writeFileSync(operation.filePath, operation.contents, 'utf8');
        break;
      case 'compose_up':
        await runtime.composeUp(operation);
        break;
      case 'compose_stop':
        await runtime.composeStop(operation);
        break;
      case 'compose_down':
        await runtime.composeDown(operation);
        break;
    }
  }
}

async function mutateTaskContainers(
  action: TaskContainerLifecycleAction,
  request: TaskContainerActionRequest,
  runtime: TaskContainerRuntime = createDockerRuntime(),
): Promise<TaskContainerInspectResult> {
  const inspect = await inspectTaskContainers(request, runtime);
  if (action === 'start' && inspect.status !== 'ready' && inspect.status !== 'running') {
    return inspect;
  }
  if (action === 'start' && inspect.status === 'running') {
    return inspect;
  }

  let composeConfig: DockerComposeConfig | null = null;
  if (action === 'start' && inspect.composeFile && inspect.projectName) {
    try {
      composeConfig = await runtime.getComposeConfig({
        composeFile: inspect.composeFile,
        composeProjectName: inspect.projectName,
        worktreePath: request.worktreePath,
      });
    } catch (error) {
      return createActionIssueFailureResult(
        inspect,
        runtime.getComposeConfigErrorIssue(request.worktreePath, error),
      );
    }
  }

  const plan = planTaskContainerAction(action, inspect, request, composeConfig);
  if (plan.length === 0) {
    return inspect;
  }

  try {
    await applyTaskContainerPlan(plan, runtime);
  } catch (error) {
    return createActionFailureResult(inspect, error);
  }

  return inspectTaskContainers(request, runtime);
}

export async function startTaskContainers(
  request: TaskContainerActionRequest,
  runtime?: TaskContainerRuntime,
): Promise<TaskContainerInspectResult> {
  return mutateTaskContainers('start', request, runtime);
}

export async function stopTaskContainers(
  request: TaskContainerActionRequest,
  runtime?: TaskContainerRuntime,
): Promise<TaskContainerInspectResult> {
  return mutateTaskContainers('stop', request, runtime);
}

export async function destroyTaskContainers(
  request: TaskContainerActionRequest,
  runtime?: TaskContainerRuntime,
): Promise<TaskContainerInspectResult> {
  return mutateTaskContainers('destroy', request, runtime);
}

export async function destroyManagedTaskContainersByLabels(
  request: Pick<TaskContainerActionRequest, 'projectPath' | 'taskId' | 'worktreePath'>,
  runtime: TaskContainerRuntime = createDockerRuntime(),
): Promise<void> {
  const availability = await runtime.getDockerRuntimeAvailability();
  if (!availability.available) {
    return;
  }

  const identity = createTaskContainerIdentity({
    projectPath: request.projectPath,
    taskId: request.taskId,
    worktreePath: request.worktreePath,
  });

  await runtime.cleanupManagedProjectByLabels({
    action: 'destroy',
    composeProjectName: identity.composeProjectName,
    ownershipLabels: identity.ownershipLabels,
    worktreePath: request.worktreePath,
  });
}

export async function getTaskContainerLogs(
  request: TaskContainerActionRequest & { lines?: number },
  runtime: TaskContainerRuntime = createDockerRuntime(),
): Promise<TaskContainerLogsResult> {
  const inspect = await inspectTaskContainers(request, runtime);
  if (!inspect.composeFile || !inspect.projectName) {
    return {
      generatedAt: Date.now(),
      taskId: request.taskId,
      text: '',
      truncated: false,
    };
  }

  const lines = Math.min(Math.max(request.lines ?? DEFAULT_LOG_LINES, 1), MAX_LOG_LINES);
  const text = await runtime
    .composeLogs({
      composeFile: inspect.composeFile,
      composeProjectName: inspect.projectName,
      lines,
      worktreePath: request.worktreePath,
    })
    .catch((error) => getCommandErrorMessage(error, 'Failed to load container logs'));

  return {
    generatedAt: Date.now(),
    taskId: request.taskId,
    text,
    truncated: false,
  };
}

export const __taskContainerTestExports = {
  collectConfiguredPublishedHostPorts,
  collectComposeConfigIssues,
  createDockerRuntime,
  createOverrideFileContents,
  getPreviews,
  parseConfiguredHostPort,
  parseComposePsRows,
  planTaskContainerAction,
  readConfiguredHostPorts,
  resolveComposeSelection,
  resolveTaskContainerRunnerProfile,
};
