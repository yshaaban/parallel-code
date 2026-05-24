export const TASK_CONTAINER_INSPECT_STATUSES = [
  'not_configured',
  'unsupported',
  'ready',
  'running',
  'error',
] as const;

export type TaskContainerInspectStatus = (typeof TASK_CONTAINER_INSPECT_STATUSES)[number];

export const TASK_CONTAINER_ISSUE_CODES = [
  'compose_file_missing',
  'docker_unavailable',
  'compose_unavailable',
  'unsupported_runner_profile',
  'missing_required_env_file',
  'explicit_container_name',
  'named_network',
  'named_volume',
  'external_network_declared',
  'external_volume_declared',
  'fixed_host_port_conflict',
  'multiple_compose_files_unsupported',
  'unsupported_compose_feature',
  'compose_config_failed',
  'compose_status_failed',
  'task_worktree_missing',
] as const;

export type TaskContainerIssueCode = (typeof TASK_CONTAINER_ISSUE_CODES)[number];
export type TaskContainerIssueSeverity = 'warning' | 'error';
export type TaskContainerRuntimeKind = 'docker-compose';
export type TaskContainerLifecycleAction = 'start' | 'stop' | 'destroy';
export type TaskContainerRunnerProfileKind = 'compose' | 'docker';
export type TaskContainerRunnerProfileStatus = 'not_configured' | 'resolved' | 'unsupported';
export type TaskContainerRunnerProfileSource = 'default' | 'project-config';
export type TaskContainerServiceState =
  | 'running'
  | 'stopped'
  | 'exited'
  | 'created'
  | 'restarting'
  | 'missing'
  | 'unknown';

export interface ProjectContainerPreviewPort {
  label?: string;
  port: number;
  protocol?: 'http' | 'https';
}

export interface ProjectContainerConfig {
  composeFile?: string;
  previewPorts?: ProjectContainerPreviewPort[];
  requiredEnvFiles?: string[];
  runnerProfile?: ProjectContainerRunnerProfileConfig;
}

export interface ProjectContainerRunnerProfileConfig {
  dockerfile?: string;
  image?: string;
  kind: TaskContainerRunnerProfileKind;
}

export interface TaskContainerRunnerProfileResolution {
  activeProfile: TaskContainerRunnerProfileKind | null;
  configuredProfile: ProjectContainerRunnerProfileConfig | null;
  fallbackProfile: TaskContainerRunnerProfileKind | null;
  message: string | null;
  source: TaskContainerRunnerProfileSource;
  status: TaskContainerRunnerProfileStatus;
}

export interface TaskContainerIssue {
  code: TaskContainerIssueCode;
  message: string;
  severity: TaskContainerIssueSeverity;
}

export interface TaskContainerPublishedPort {
  host: string | null;
  containerPort: number | null;
  port: number;
  protocol: 'http' | 'https';
  serviceName: string;
}

export interface TaskContainerPreview {
  label: string;
  port: number;
  protocol: 'http' | 'https';
  source: 'configured' | 'single-published-port';
}

export interface TaskContainerServiceSnapshot {
  containerId: string | null;
  health: string | null;
  name: string;
  publishedPorts: TaskContainerPublishedPort[];
  state: TaskContainerServiceState;
}

export interface TaskContainerInspectResult {
  composeFile: string | null;
  issues: TaskContainerIssue[];
  observedAt: number;
  previews: TaskContainerPreview[];
  projectName: string | null;
  publishedPorts: TaskContainerPublishedPort[];
  runnerProfile?: TaskContainerRunnerProfileResolution;
  runtime: TaskContainerRuntimeKind | null;
  services: TaskContainerServiceSnapshot[];
  status: TaskContainerInspectStatus;
  taskId: string;
}

export interface TaskContainerLogsResult {
  generatedAt: number;
  taskId: string;
  text: string;
  truncated: boolean;
}
