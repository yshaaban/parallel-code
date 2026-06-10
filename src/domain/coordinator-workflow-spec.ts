import type { CoordinatorSpawnSubtaskPayload } from './coordinator.js';

export const COORDINATOR_WORKFLOW_SPEC_VERSION = 2 as const;
export const COORDINATOR_WORKFLOW_SUPPORTED_SPEC_VERSIONS = [1, 2] as const;

export const COORDINATOR_WORKFLOW_SPEC_STEP_KINDS = [
  'decision',
  'fanout',
  'synthesize',
  'verify',
  'worker',
] as const;

export const COORDINATOR_WORKFLOW_SPEC_STEP_JOIN_MODES = [
  'all',
  'any',
  'first-success',
  'quorum',
] as const;

export const COORDINATOR_WORKFLOW_DYNAMIC_ACTION_KINDS = [
  'append_branch_bundle',
  'append_fanout',
  'append_synthesize',
  'append_verify',
  'append_worker',
  'mark_blocked',
  'stop_workflow',
] as const;

export type CoordinatorWorkflowSpecVersion =
  (typeof COORDINATOR_WORKFLOW_SUPPORTED_SPEC_VERSIONS)[number];
export type CoordinatorWorkflowSpecStepKind = (typeof COORDINATOR_WORKFLOW_SPEC_STEP_KINDS)[number];
export type CoordinatorWorkflowSpecStepJoinMode =
  (typeof COORDINATOR_WORKFLOW_SPEC_STEP_JOIN_MODES)[number];
export type CoordinatorWorkflowDynamicActionKind =
  (typeof COORDINATOR_WORKFLOW_DYNAMIC_ACTION_KINDS)[number];

export interface CoordinatorWorkflowSpecLaneSnapshot {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  assignment?: string;
  dedupeKey?: string;
  id: string;
  name: string;
  role?: string;
}

export type CoordinatorWorkflowSpecVerifierSnapshot = CoordinatorWorkflowSpecLaneSnapshot;

export interface CoordinatorWorkflowSpecStepPolicySnapshot {
  joinMode?: CoordinatorWorkflowSpecStepJoinMode;
  quorumCount?: number;
  resultRequired?: boolean;
  retryBackoffMs?: number;
  retryCount?: number;
  timeoutMs?: number;
}

export interface CoordinatorWorkflowSpecStepSnapshot {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  assignment?: string;
  dependsOn: string[];
  findingSourceStepId?: string;
  id: string;
  includeEvidence?: boolean;
  includeFindings?: boolean;
  includeUnverifiedFindings?: boolean;
  includeVerdicts?: boolean;
  kind: CoordinatorWorkflowSpecStepKind;
  lanes: CoordinatorWorkflowSpecLaneSnapshot[];
  minimumVerifierCount?: number;
  name: string;
  policy?: CoordinatorWorkflowSpecStepPolicySnapshot;
  prompt?: string;
  resultSourceStepIds: string[];
  role?: string;
  sourceStepIds: string[];
  verifiers: CoordinatorWorkflowSpecVerifierSnapshot[];
}

export interface CoordinatorWorkflowSpecSnapshot {
  description?: string;
  inputs?: Record<string, unknown>;
  steps: CoordinatorWorkflowSpecStepSnapshot[];
  version: CoordinatorWorkflowSpecVersion;
}

export interface CoordinatorWorkflowSpecPayload {
  description?: string;
  inputs?: Record<string, unknown>;
  steps: unknown[];
  version?: CoordinatorWorkflowSpecVersion;
}

export interface CoordinatorWorkflowStepAppendNormalizationResult {
  appendedSteps: CoordinatorWorkflowSpecStepSnapshot[];
  sourceSpec: CoordinatorWorkflowSpecSnapshot;
}

export interface CoordinatorWorkflowDynamicAppendActionSnapshot {
  actionId?: string;
  kind: Extract<
    CoordinatorWorkflowDynamicActionKind,
    'append_fanout' | 'append_synthesize' | 'append_verify' | 'append_worker'
  >;
  step: CoordinatorWorkflowSpecStepSnapshot;
}

export interface CoordinatorWorkflowDynamicBranchBundleReduceSnapshot {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  id?: string;
  includeFindings?: boolean;
  includeVerdicts?: boolean;
  name?: string;
  prompt?: string;
  role?: string;
}

export interface CoordinatorWorkflowDynamicBranchBundleVerifySnapshot {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  id?: string;
  includeEvidence?: boolean;
  includeFindings?: boolean;
  joinMode?: CoordinatorWorkflowSpecStepJoinMode;
  minimumVerifierCount?: number;
  name?: string;
  quorumCount?: number;
  verifiers: CoordinatorWorkflowSpecVerifierSnapshot[];
}

export interface CoordinatorWorkflowDynamicBranchBundleActionSnapshot {
  actionId?: string;
  branchKey?: string;
  bundleId: string;
  dependsOn?: string[];
  kind: 'append_branch_bundle';
  lanes: CoordinatorWorkflowSpecLaneSnapshot[];
  maxIterations?: number;
  name?: string;
  reduce?: CoordinatorWorkflowDynamicBranchBundleReduceSnapshot;
  verify?: CoordinatorWorkflowDynamicBranchBundleVerifySnapshot;
}

export interface CoordinatorWorkflowDynamicTerminalActionSnapshot {
  actionId?: string;
  kind: Extract<CoordinatorWorkflowDynamicActionKind, 'mark_blocked' | 'stop_workflow'>;
  reason: string;
}

export type CoordinatorWorkflowDynamicActionSnapshot =
  | CoordinatorWorkflowDynamicBranchBundleActionSnapshot
  | CoordinatorWorkflowDynamicAppendActionSnapshot
  | CoordinatorWorkflowDynamicTerminalActionSnapshot;

export interface CoordinatorWorkflowSpecValidationLimits {
  assignmentTextMaxChars: number;
  maxWorkflowBranchIterations?: number;
  maxWorkflowLanes: number;
  maxWorkflowMetadataBytes: number;
  maxWorkflowShortTextChars: number;
  workflowMaxLaneTimeoutMs: number;
}

const COORDINATOR_WORKFLOW_SNAPSHOT_VALIDATION_LIMITS: CoordinatorWorkflowSpecValidationLimits = {
  assignmentTextMaxChars: Number.MAX_SAFE_INTEGER,
  maxWorkflowBranchIterations: Number.MAX_SAFE_INTEGER,
  maxWorkflowLanes: Number.MAX_SAFE_INTEGER,
  maxWorkflowMetadataBytes: Number.MAX_SAFE_INTEGER,
  maxWorkflowShortTextChars: Number.MAX_SAFE_INTEGER,
  workflowMaxLaneTimeoutMs: Number.MAX_SAFE_INTEGER,
};

export class CoordinatorWorkflowSpecValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinatorWorkflowSpecValidationError';
  }
}

interface WorkflowSpecNormalizationOptions {
  fallbackAgent?: CoordinatorSpawnSubtaskPayload['agent'];
  limits: CoordinatorWorkflowSpecValidationLimits;
}

interface NormalizedStepInput {
  agent?: unknown;
  assignment?: string;
  dependsOn?: unknown;
  findingSourceStepId?: unknown;
  id?: unknown;
  includeEvidence?: unknown;
  includeFindings?: unknown;
  includeUnverifiedFindings?: unknown;
  includeVerdicts?: unknown;
  kind?: unknown;
  lanes?: unknown;
  minimumVerifierCount?: unknown;
  name?: unknown;
  policy?: unknown;
  prompt?: unknown;
  resultSourceStepIds?: unknown;
  role?: unknown;
  sourceStepIds?: unknown;
  verifiers?: unknown;
}

interface NormalizedBranchBundleInput {
  actionId?: unknown;
  branchKey?: unknown;
  bundleId?: unknown;
  dependsOn?: unknown;
  kind?: unknown;
  lanes?: unknown;
  maxIterations?: unknown;
  name?: unknown;
  reduce?: unknown;
  verify?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must be an object`);
  }
}

function assertJsonSize(
  value: unknown,
  label: string,
  limits: CoordinatorWorkflowSpecValidationLimits,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must be JSON-serializable`);
  }

  if (new TextEncoder().encode(serialized).length > limits.maxWorkflowMetadataBytes) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label} must be no larger than ${limits.maxWorkflowMetadataBytes} bytes`,
    );
  }
}

function readOptionalString(value: unknown, label: string, maxChars: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must be a string`);
  }
  if (value.length === 0) {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must not be empty`);
  }
  if (value.length > maxChars) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label} must be no longer than ${maxChars} characters`,
    );
  }

  return value;
}

function readRequiredString(value: unknown, label: string, maxChars: number): string {
  const text = readOptionalString(value, label, maxChars);
  if (text === undefined) {
    throw new CoordinatorWorkflowSpecValidationError(`${label} is required`);
  }

  return text;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must be a boolean`);
  }

  return value;
}

function readOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must be a non-negative integer`);
  }

  return value;
}

function readOptionalStringArray(value: unknown, label: string, maxChars: number): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must be an array`);
  }

  return value.map((entry, index) => readRequiredString(entry, `${label}[${index}]`, maxChars));
}

function readOptionalStringRecord(
  value: unknown,
  label: string,
  maxChars: number,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must be an object`);
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    readRequiredString(key, `${label} key`, maxChars);
    record[key] = readRequiredString(entry, `${label}.${key}`, maxChars);
  }

  return record;
}

function readAgent(
  value: unknown,
  label: string,
  options: WorkflowSpecNormalizationOptions,
  fallbackAgent?: CoordinatorSpawnSubtaskPayload['agent'],
): CoordinatorSpawnSubtaskPayload['agent'] | undefined {
  if (value === undefined) {
    return fallbackAgent;
  }
  assertRecord(value, label);

  const args = readOptionalStringArray(
    value.args,
    `${label}.args`,
    options.limits.maxWorkflowShortTextChars,
  );
  const command = readRequiredString(
    value.command,
    `${label}.command`,
    options.limits.maxWorkflowShortTextChars,
  );
  const env = readOptionalStringRecord(
    value.env,
    `${label}.env`,
    options.limits.maxWorkflowShortTextChars,
  );
  const followupPromptMode = readOptionalString(
    value.followupPromptMode,
    `${label}.followupPromptMode`,
    options.limits.maxWorkflowShortTextChars,
  );
  if (
    followupPromptMode !== undefined &&
    followupPromptMode !== 'post-ready-prompt' &&
    followupPromptMode !== 'disallow'
  ) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.followupPromptMode must be post-ready-prompt or disallow`,
    );
  }
  const initialAssignmentMode = readOptionalString(
    value.initialAssignmentMode,
    `${label}.initialAssignmentMode`,
    options.limits.maxWorkflowShortTextChars,
  );
  if (
    initialAssignmentMode !== undefined &&
    initialAssignmentMode !== 'spawn-seeded-interactive' &&
    initialAssignmentMode !== 'post-ready-prompt'
  ) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.initialAssignmentMode must be spawn-seeded-interactive or post-ready-prompt`,
    );
  }
  const name = readOptionalString(
    value.name,
    `${label}.name`,
    options.limits.maxWorkflowShortTextChars,
  );
  const readinessPolicy = readOptionalString(
    value.readinessPolicy,
    `${label}.readinessPolicy`,
    options.limits.maxWorkflowShortTextChars,
  );
  if (
    readinessPolicy !== undefined &&
    readinessPolicy !== 'codex' &&
    readinessPolicy !== 'shell' &&
    readinessPolicy !== 'terminal-generic'
  ) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.readinessPolicy must be codex, shell, or terminal-generic`,
    );
  }
  const skipPermissionsArgs = readOptionalStringArray(
    value.skipPermissionsArgs,
    `${label}.skipPermissionsArgs`,
    options.limits.maxWorkflowShortTextChars,
  );

  return {
    ...(args.length > 0 ? { args } : {}),
    command,
    ...(env !== undefined ? { env } : {}),
    ...(followupPromptMode !== undefined ? { followupPromptMode } : {}),
    ...(initialAssignmentMode !== undefined ? { initialAssignmentMode } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(readinessPolicy !== undefined ? { readinessPolicy } : {}),
    ...(skipPermissionsArgs.length > 0 ? { skipPermissionsArgs } : {}),
  };
}

function readStepKind(value: unknown, label: string): CoordinatorWorkflowSpecStepKind {
  if (
    value !== 'decision' &&
    value !== 'fanout' &&
    value !== 'synthesize' &&
    value !== 'verify' &&
    value !== 'worker'
  ) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label} must be decision, fanout, synthesize, verify, or worker`,
    );
  }

  return value;
}

function readDynamicActionKind(
  value: unknown,
  label: string,
): CoordinatorWorkflowDynamicActionKind {
  if (
    value !== 'append_branch_bundle' &&
    value !== 'append_fanout' &&
    value !== 'append_synthesize' &&
    value !== 'append_verify' &&
    value !== 'append_worker' &&
    value !== 'mark_blocked' &&
    value !== 'stop_workflow'
  ) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label} must be append_branch_bundle, append_fanout, append_synthesize, append_verify, append_worker, mark_blocked, or stop_workflow`,
    );
  }

  return value;
}

function readOptionalJoinMode(
  value: unknown,
  label: string,
): CoordinatorWorkflowSpecStepJoinMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'all' && value !== 'any' && value !== 'first-success' && value !== 'quorum') {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label} must be all, any, first-success, or quorum`,
    );
  }

  return value;
}

function assertJoinModePolicy(
  label: string,
  joinMode: CoordinatorWorkflowSpecStepJoinMode | undefined,
  quorumCount: number | undefined,
  lanes?: { count: number; noun: string },
): void {
  if (lanes !== undefined && joinMode !== undefined && joinMode !== 'all' && lanes.count < 2) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label} requires at least 2 ${lanes.noun} for joinMode ${joinMode}`,
    );
  }
  if (joinMode !== 'quorum' && quorumCount !== undefined) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.quorumCount requires ${label}.joinMode quorum`,
    );
  }
  if (joinMode === 'quorum' && (quorumCount === undefined || quorumCount < 1)) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.quorumCount is required when ${label}.joinMode is quorum`,
    );
  }
  if (
    joinMode === 'quorum' &&
    lanes !== undefined &&
    quorumCount !== undefined &&
    quorumCount > lanes.count
  ) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.quorumCount must be no greater than ${lanes.count}`,
    );
  }
}

function assertVerifierThresholdPolicy(
  label: string,
  verifierCount: number,
  joinMode: CoordinatorWorkflowSpecStepJoinMode | undefined,
  minimumVerifierCount: number | undefined,
  quorumCount: number | undefined,
): void {
  if (minimumVerifierCount === undefined) {
    return;
  }
  if (minimumVerifierCount < 1) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.minimumVerifierCount must be positive`,
    );
  }
  if (minimumVerifierCount > verifierCount) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.minimumVerifierCount must be no greater than ${verifierCount}`,
    );
  }
  if ((joinMode === 'any' || joinMode === 'first-success') && minimumVerifierCount > 1) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.minimumVerifierCount must be 1 when ${label}.joinMode is ${joinMode}`,
    );
  }
  if (joinMode === 'quorum' && quorumCount !== undefined && minimumVerifierCount > quorumCount) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.minimumVerifierCount must be no greater than ${label}.quorumCount`,
    );
  }
}

function readStepPolicy(
  value: unknown,
  limits: CoordinatorWorkflowSpecValidationLimits,
): CoordinatorWorkflowSpecStepPolicySnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertRecord(value, 'step.policy');
  const retryBackoffMs = readOptionalNonNegativeInteger(
    value.retryBackoffMs,
    'step.policy.retryBackoffMs',
  );
  const retryCount = readOptionalNonNegativeInteger(value.retryCount, 'step.policy.retryCount');
  const timeoutMs = readOptionalNonNegativeInteger(value.timeoutMs, 'step.policy.timeoutMs');
  const joinMode = readOptionalJoinMode(value.joinMode, 'step.policy.joinMode');
  const quorumCount = readOptionalNonNegativeInteger(value.quorumCount, 'step.policy.quorumCount');
  if (timeoutMs !== undefined && timeoutMs > limits.workflowMaxLaneTimeoutMs) {
    throw new CoordinatorWorkflowSpecValidationError(
      `step.policy.timeoutMs must be no greater than ${limits.workflowMaxLaneTimeoutMs}`,
    );
  }
  if (quorumCount !== undefined && quorumCount === 0) {
    throw new CoordinatorWorkflowSpecValidationError('step.policy.quorumCount must be positive');
  }
  assertJoinModePolicy('step.policy', joinMode, quorumCount);
  const resultRequired = readOptionalBoolean(value.resultRequired, 'step.policy.resultRequired');

  return {
    ...(joinMode !== undefined ? { joinMode } : {}),
    ...(quorumCount !== undefined ? { quorumCount } : {}),
    ...(resultRequired !== undefined ? { resultRequired } : {}),
    ...(retryBackoffMs !== undefined ? { retryBackoffMs } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function readLane(
  value: unknown,
  label: string,
  options: WorkflowSpecNormalizationOptions,
  fallbackAgent?: CoordinatorSpawnSubtaskPayload['agent'],
): CoordinatorWorkflowSpecLaneSnapshot {
  assertRecord(value, label);
  const id = readRequiredString(
    value.id ?? value.name,
    `${label}.id`,
    options.limits.maxWorkflowShortTextChars,
  );
  const assignment = readOptionalString(
    value.assignment,
    `${label}.assignment`,
    options.limits.assignmentTextMaxChars,
  );
  const dedupeKey = readOptionalString(
    value.dedupeKey,
    `${label}.dedupeKey`,
    options.limits.maxWorkflowShortTextChars,
  );
  const name = readRequiredString(
    value.name ?? id,
    `${label}.name`,
    options.limits.maxWorkflowShortTextChars,
  );
  const role = readOptionalString(
    value.role,
    `${label}.role`,
    options.limits.maxWorkflowShortTextChars,
  );
  const agent = readAgent(value.agent, `${label}.agent`, options, fallbackAgent);

  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(assignment !== undefined ? { assignment } : {}),
    ...(dedupeKey !== undefined ? { dedupeKey } : {}),
    id,
    name,
    ...(role !== undefined ? { role } : {}),
  };
}

function readLanes(
  value: unknown,
  label: string,
  options: WorkflowSpecNormalizationOptions,
  fallbackAgent?: CoordinatorSpawnSubtaskPayload['agent'],
): CoordinatorWorkflowSpecLaneSnapshot[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new CoordinatorWorkflowSpecValidationError(`${label} must be an array`);
  }

  return value.map((entry, index) => readLane(entry, `${label}[${index}]`, options, fallbackAgent));
}

function normalizeStepRecord(
  step: NormalizedStepInput,
  label: string,
  options: WorkflowSpecNormalizationOptions,
  forcedKind?: CoordinatorWorkflowSpecStepKind,
): CoordinatorWorkflowSpecStepSnapshot {
  const kind = forcedKind ?? readStepKind(step.kind, `${label}.kind`);
  const id = readRequiredString(step.id, `${label}.id`, options.limits.maxWorkflowShortTextChars);
  const name =
    readOptionalString(step.name, `${label}.name`, options.limits.maxWorkflowShortTextChars) ?? id;
  const agent = readAgent(step.agent, `${label}.agent`, options, options.fallbackAgent);
  const lanes = readLanes(step.lanes, `${label}.lanes`, options, agent);
  const verifiers = readLanes(step.verifiers, `${label}.verifiers`, options, agent);
  const policy = readStepPolicy(step.policy, options.limits);
  const assignment = readOptionalString(
    step.assignment,
    `${label}.assignment`,
    options.limits.assignmentTextMaxChars,
  );
  const findingSourceStepId = readOptionalString(
    step.findingSourceStepId,
    `${label}.findingSourceStepId`,
    options.limits.maxWorkflowShortTextChars,
  );
  const includeEvidence = readOptionalBoolean(step.includeEvidence, `${label}.includeEvidence`);
  const includeFindings = readOptionalBoolean(step.includeFindings, `${label}.includeFindings`);
  const includeUnverifiedFindings = readOptionalBoolean(
    step.includeUnverifiedFindings,
    `${label}.includeUnverifiedFindings`,
  );
  const includeVerdicts = readOptionalBoolean(step.includeVerdicts, `${label}.includeVerdicts`);
  const minimumVerifierCount = readOptionalNonNegativeInteger(
    step.minimumVerifierCount,
    `${label}.minimumVerifierCount`,
  );
  const prompt = readOptionalString(
    step.prompt,
    `${label}.prompt`,
    options.limits.assignmentTextMaxChars,
  );
  const role = readOptionalString(
    step.role,
    `${label}.role`,
    options.limits.maxWorkflowShortTextChars,
  );

  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(assignment !== undefined ? { assignment } : {}),
    dependsOn: readOptionalStringArray(
      step.dependsOn,
      `${label}.dependsOn`,
      options.limits.maxWorkflowShortTextChars,
    ),
    ...(findingSourceStepId !== undefined ? { findingSourceStepId } : {}),
    id,
    ...(includeEvidence !== undefined ? { includeEvidence } : {}),
    ...(includeFindings !== undefined ? { includeFindings } : {}),
    ...(includeUnverifiedFindings !== undefined ? { includeUnverifiedFindings } : {}),
    ...(includeVerdicts !== undefined ? { includeVerdicts } : {}),
    kind,
    lanes,
    ...(minimumVerifierCount !== undefined ? { minimumVerifierCount } : {}),
    name,
    ...(policy !== undefined ? { policy } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    resultSourceStepIds: readOptionalStringArray(
      step.resultSourceStepIds,
      `${label}.resultSourceStepIds`,
      options.limits.maxWorkflowShortTextChars,
    ),
    ...(role !== undefined ? { role } : {}),
    sourceStepIds: readOptionalStringArray(
      step.sourceStepIds,
      `${label}.sourceStepIds`,
      options.limits.maxWorkflowShortTextChars,
    ),
    verifiers,
  };
}

function readStep(
  value: unknown,
  index: number,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowSpecStepSnapshot {
  const label = `steps[${index}]`;
  assertRecord(value, label);
  const step = value as NormalizedStepInput;
  return normalizeStepRecord(step, label, options);
}

function assertUniqueIds(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new CoordinatorWorkflowSpecValidationError(`${label} contains duplicate id ${value}`);
    }
    seen.add(value);
  }
}

function assertUniqueLaneDedupeKeys(steps: CoordinatorWorkflowSpecStepSnapshot[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    const plannedLanes = [...step.lanes, ...step.verifiers];
    for (const lane of plannedLanes) {
      if (lane.dedupeKey === undefined) {
        continue;
      }
      if (seen.has(lane.dedupeKey)) {
        throw new CoordinatorWorkflowSpecValidationError(
          `workflow spec reuses lane dedupeKey ${lane.dedupeKey}`,
        );
      }
      seen.add(lane.dedupeKey);
    }
  }
}

function assertAppendDoesNotModifyExistingSteps(
  existingSteps: CoordinatorWorkflowSpecStepSnapshot[],
  sourceSpec: CoordinatorWorkflowSpecSnapshot,
): void {
  const preservedSteps = sourceSpec.steps.slice(0, existingSteps.length);
  if (JSON.stringify(preservedSteps) !== JSON.stringify(existingSteps)) {
    throw new CoordinatorWorkflowSpecValidationError(
      'append steps must not modify existing workflow steps',
    );
  }
}

function assertNoCycles(steps: CoordinatorWorkflowSpecStepSnapshot[]): void {
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(stepId: string): void {
    if (visited.has(stepId)) {
      return;
    }
    if (visiting.has(stepId)) {
      throw new CoordinatorWorkflowSpecValidationError(
        `workflow spec contains a dependency cycle at ${stepId}`,
      );
    }
    const step = stepsById.get(stepId);
    if (!step) {
      throw new CoordinatorWorkflowSpecValidationError(
        `workflow spec references missing dependency ${stepId}`,
      );
    }

    visiting.add(stepId);
    for (const dependencyId of step.dependsOn) {
      visit(dependencyId);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  }

  for (const step of steps) {
    visit(step.id);
  }
}

function assertStepReferences(steps: CoordinatorWorkflowSpecStepSnapshot[]): void {
  const ids = new Set(steps.map((step) => step.id));
  const stepsById = new Map(steps.map((step) => [step.id, step]));

  function getReachableDependencyIds(
    step: CoordinatorWorkflowSpecStepSnapshot,
    seen: Set<string> = new Set(),
  ): Set<string> {
    for (const dependencyId of step.dependsOn) {
      if (seen.has(dependencyId)) {
        continue;
      }
      seen.add(dependencyId);
      const dependency = stepsById.get(dependencyId);
      if (dependency) {
        getReachableDependencyIds(dependency, seen);
      }
    }
    return seen;
  }

  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      if (!ids.has(dependencyId)) {
        throw new CoordinatorWorkflowSpecValidationError(
          `step ${step.id} depends on missing step ${dependencyId}`,
        );
      }
    }
    for (const sourceId of step.sourceStepIds) {
      if (!ids.has(sourceId)) {
        throw new CoordinatorWorkflowSpecValidationError(
          `step ${step.id} references missing source step ${sourceId}`,
        );
      }
    }
    for (const sourceId of step.resultSourceStepIds) {
      if (!ids.has(sourceId)) {
        throw new CoordinatorWorkflowSpecValidationError(
          `step ${step.id} references missing result source step ${sourceId}`,
        );
      }
    }
    if (step.findingSourceStepId !== undefined && !ids.has(step.findingSourceStepId)) {
      throw new CoordinatorWorkflowSpecValidationError(
        `step ${step.id} references missing finding source step ${step.findingSourceStepId}`,
      );
    }

    const reachableDependencyIds = getReachableDependencyIds(step);
    for (const sourceId of step.sourceStepIds) {
      if (!reachableDependencyIds.has(sourceId)) {
        throw new CoordinatorWorkflowSpecValidationError(
          `step ${step.id} must depend on source step ${sourceId}`,
        );
      }
    }
    for (const sourceId of step.resultSourceStepIds) {
      if (!reachableDependencyIds.has(sourceId)) {
        throw new CoordinatorWorkflowSpecValidationError(
          `step ${step.id} must depend on result source step ${sourceId}`,
        );
      }
    }
    if (
      step.findingSourceStepId !== undefined &&
      !reachableDependencyIds.has(step.findingSourceStepId)
    ) {
      throw new CoordinatorWorkflowSpecValidationError(
        `step ${step.id} must depend on finding source step ${step.findingSourceStepId}`,
      );
    }
  }
}

function assertStepShape(step: CoordinatorWorkflowSpecStepSnapshot): void {
  const laneCount = countCoordinatorWorkflowSpecStepLanes(step);
  if (step.kind === 'decision') {
    if (step.verifiers.length > 0) {
      throw new CoordinatorWorkflowSpecValidationError(
        `decision step ${step.id} must not define verifiers`,
      );
    }
    if (step.lanes.length > 1) {
      throw new CoordinatorWorkflowSpecValidationError(
        `decision step ${step.id} supports one lane`,
      );
    }
  }
  if (step.kind === 'fanout' && step.lanes.length === 0) {
    throw new CoordinatorWorkflowSpecValidationError(`fanout step ${step.id} requires lanes`);
  }
  if (step.kind === 'worker' && step.lanes.length > 1) {
    throw new CoordinatorWorkflowSpecValidationError(`worker step ${step.id} supports one lane`);
  }
  if (step.kind === 'verify') {
    if (step.verifiers.length === 0) {
      throw new CoordinatorWorkflowSpecValidationError(`verify step ${step.id} requires verifiers`);
    }
    if (step.findingSourceStepId === undefined && step.resultSourceStepIds.length === 0) {
      throw new CoordinatorWorkflowSpecValidationError(
        `verify step ${step.id} requires a finding or result source`,
      );
    }
    assertVerifierThresholdPolicy(
      `step ${step.id}`,
      step.verifiers.length,
      step.policy?.joinMode,
      step.minimumVerifierCount,
      step.policy?.quorumCount,
    );
  }

  assertJoinModePolicy(`step ${step.id}`, step.policy?.joinMode, step.policy?.quorumCount, {
    count: laneCount,
    noun: 'lanes',
  });
}

export function countCoordinatorWorkflowSpecStepLanes(
  step: CoordinatorWorkflowSpecStepSnapshot,
): number {
  if (step.kind === 'decision') {
    return Math.max(1, step.lanes.length);
  }
  if (step.kind === 'verify') {
    return step.verifiers.length;
  }
  if (step.kind === 'synthesize') {
    return 1;
  }
  if (step.kind === 'worker' && step.lanes.length === 0) {
    return 1;
  }

  return step.lanes.length;
}

export function countCoordinatorWorkflowSpecLanes(
  steps: CoordinatorWorkflowSpecStepSnapshot[],
): number {
  return steps.reduce((count, step) => count + countCoordinatorWorkflowSpecStepLanes(step), 0);
}

function mapDynamicActionToStepKind(
  kind: Extract<
    CoordinatorWorkflowDynamicActionKind,
    'append_fanout' | 'append_synthesize' | 'append_verify' | 'append_worker'
  >,
): CoordinatorWorkflowSpecStepKind {
  switch (kind) {
    case 'append_fanout':
      return 'fanout';
    case 'append_synthesize':
      return 'synthesize';
    case 'append_verify':
      return 'verify';
    case 'append_worker':
      return 'worker';
  }
}

function normalizeCoordinatorWorkflowDynamicAppendAction(
  value: Record<string, unknown>,
  label: string,
  kind: Extract<
    CoordinatorWorkflowDynamicActionKind,
    'append_fanout' | 'append_synthesize' | 'append_verify' | 'append_worker'
  >,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowDynamicAppendActionSnapshot {
  const actionId = readOptionalString(
    value.actionId,
    `${label}.actionId`,
    options.limits.maxWorkflowShortTextChars,
  );
  const step = normalizeStepRecord(
    {
      ...(value as NormalizedStepInput),
      kind: mapDynamicActionToStepKind(kind),
    },
    `${label}.step`,
    options,
    mapDynamicActionToStepKind(kind),
  );

  return {
    ...(actionId !== undefined ? { actionId } : {}),
    kind,
    step,
  };
}

function readBranchBundleReduce(
  value: unknown,
  label: string,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowDynamicBranchBundleReduceSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertRecord(value, label);
  const agent = readAgent(value.agent, `${label}.agent`, options);
  const id = readOptionalString(value.id, `${label}.id`, options.limits.maxWorkflowShortTextChars);
  const includeFindings = readOptionalBoolean(value.includeFindings, `${label}.includeFindings`);
  const includeVerdicts = readOptionalBoolean(value.includeVerdicts, `${label}.includeVerdicts`);
  const name = readOptionalString(
    value.name,
    `${label}.name`,
    options.limits.maxWorkflowShortTextChars,
  );
  const prompt = readOptionalString(
    value.prompt,
    `${label}.prompt`,
    options.limits.assignmentTextMaxChars,
  );
  const role = readOptionalString(
    value.role,
    `${label}.role`,
    options.limits.maxWorkflowShortTextChars,
  );

  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(includeFindings !== undefined ? { includeFindings } : {}),
    ...(includeVerdicts !== undefined ? { includeVerdicts } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(role !== undefined ? { role } : {}),
  };
}

function readBranchBundleVerify(
  value: unknown,
  label: string,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowDynamicBranchBundleVerifySnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertRecord(value, label);
  if (!Array.isArray(value.verifiers) || value.verifiers.length === 0) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.verifiers must be a non-empty array`,
    );
  }

  const agent = readAgent(value.agent, `${label}.agent`, options);
  const id = readOptionalString(value.id, `${label}.id`, options.limits.maxWorkflowShortTextChars);
  const includeEvidence = readOptionalBoolean(value.includeEvidence, `${label}.includeEvidence`);
  const includeFindings = readOptionalBoolean(value.includeFindings, `${label}.includeFindings`);
  const joinMode = readOptionalJoinMode(value.joinMode, `${label}.joinMode`);
  const minimumVerifierCount = readOptionalNonNegativeInteger(
    value.minimumVerifierCount,
    `${label}.minimumVerifierCount`,
  );
  const name = readOptionalString(
    value.name,
    `${label}.name`,
    options.limits.maxWorkflowShortTextChars,
  );
  const quorumCount = readOptionalNonNegativeInteger(value.quorumCount, `${label}.quorumCount`);
  const verifiers = value.verifiers.map((entry, index) =>
    readLane(entry, `${label}.verifiers[${index}]`, options, agent),
  );

  assertJoinModePolicy(label, joinMode, quorumCount, {
    count: verifiers.length,
    noun: 'verifiers',
  });
  assertVerifierThresholdPolicy(
    label,
    verifiers.length,
    joinMode,
    minimumVerifierCount,
    quorumCount,
  );

  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(includeEvidence !== undefined ? { includeEvidence } : {}),
    ...(includeFindings !== undefined ? { includeFindings } : {}),
    ...(joinMode !== undefined ? { joinMode } : {}),
    ...(minimumVerifierCount !== undefined ? { minimumVerifierCount } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(quorumCount !== undefined ? { quorumCount } : {}),
    verifiers,
  };
}

function normalizeCoordinatorWorkflowDynamicBranchBundleAction(
  value: Record<string, unknown>,
  label: string,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowDynamicBranchBundleActionSnapshot {
  const bundle = value as NormalizedBranchBundleInput;
  const actionId = readOptionalString(
    bundle.actionId,
    `${label}.actionId`,
    options.limits.maxWorkflowShortTextChars,
  );
  const branchKey = readOptionalString(
    bundle.branchKey,
    `${label}.branchKey`,
    options.limits.maxWorkflowShortTextChars,
  );
  const bundleId = readRequiredString(
    bundle.bundleId,
    `${label}.bundleId`,
    options.limits.maxWorkflowShortTextChars,
  );
  const dependsOn = readOptionalStringArray(
    bundle.dependsOn,
    `${label}.dependsOn`,
    options.limits.maxWorkflowShortTextChars,
  );
  if (!Array.isArray(bundle.lanes) || bundle.lanes.length === 0) {
    throw new CoordinatorWorkflowSpecValidationError(`${label}.lanes must be a non-empty array`);
  }
  const lanes = bundle.lanes.map((entry, index) =>
    readLane(entry, `${label}.lanes[${index}]`, options),
  );
  const maxIterations = readOptionalNonNegativeInteger(
    bundle.maxIterations,
    `${label}.maxIterations`,
  );
  if (maxIterations !== undefined && maxIterations === 0) {
    throw new CoordinatorWorkflowSpecValidationError(`${label}.maxIterations must be positive`);
  }
  const limit = options.limits.maxWorkflowBranchIterations;
  if (limit !== undefined && maxIterations !== undefined && maxIterations > limit) {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label}.maxIterations must be no greater than ${limit}`,
    );
  }
  const name = readOptionalString(
    bundle.name,
    `${label}.name`,
    options.limits.maxWorkflowShortTextChars,
  );
  const reduce = readBranchBundleReduce(bundle.reduce, `${label}.reduce`, options);
  const verify = readBranchBundleVerify(bundle.verify, `${label}.verify`, options);

  return {
    ...(actionId !== undefined ? { actionId } : {}),
    ...(branchKey !== undefined ? { branchKey } : {}),
    bundleId,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    kind: 'append_branch_bundle',
    lanes,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(reduce !== undefined ? { reduce } : {}),
    ...(verify !== undefined ? { verify } : {}),
  };
}

function normalizeCoordinatorWorkflowDynamicTerminalAction(
  value: Record<string, unknown>,
  label: string,
  kind: Extract<CoordinatorWorkflowDynamicActionKind, 'mark_blocked' | 'stop_workflow'>,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowDynamicTerminalActionSnapshot {
  const actionId = readOptionalString(
    value.actionId,
    `${label}.actionId`,
    options.limits.maxWorkflowShortTextChars,
  );
  const reason = readRequiredString(
    value.reason,
    `${label}.reason`,
    options.limits.assignmentTextMaxChars,
  );

  return {
    ...(actionId !== undefined ? { actionId } : {}),
    kind,
    reason,
  };
}

export function normalizeCoordinatorWorkflowSpec(
  value: unknown,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowSpecSnapshot {
  assertRecord(value, 'spec');
  if (
    value.version !== undefined &&
    !COORDINATOR_WORKFLOW_SUPPORTED_SPEC_VERSIONS.includes(
      value.version as CoordinatorWorkflowSpecVersion,
    )
  ) {
    throw new CoordinatorWorkflowSpecValidationError(
      `spec.version must be one of ${COORDINATOR_WORKFLOW_SUPPORTED_SPEC_VERSIONS.join(', ')}`,
    );
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new CoordinatorWorkflowSpecValidationError('spec.steps must be a non-empty array');
  }

  assertJsonSize(value, 'spec', options.limits);
  const steps = value.steps.map((step, index) => readStep(step, index, options));
  assertUniqueIds(
    steps.map((step) => step.id),
    'spec.steps',
  );
  for (const step of steps) {
    assertUniqueIds(
      step.lanes.map((lane) => lane.id),
      `step ${step.id} lanes`,
    );
    assertUniqueIds(
      step.verifiers.map((verifier) => verifier.id),
      `step ${step.id} verifiers`,
    );
    assertStepShape(step);
  }
  assertStepReferences(steps);
  assertUniqueLaneDedupeKeys(steps);
  assertNoCycles(steps);

  const laneCount = countCoordinatorWorkflowSpecLanes(steps);
  if (laneCount > options.limits.maxWorkflowLanes) {
    throw new CoordinatorWorkflowSpecValidationError(
      `workflow spec creates ${laneCount} lanes, above limit ${options.limits.maxWorkflowLanes}`,
    );
  }
  const description = readOptionalString(
    value.description,
    'spec.description',
    options.limits.assignmentTextMaxChars,
  );
  const inputs = value.inputs;
  if (inputs !== undefined && !isRecord(inputs)) {
    throw new CoordinatorWorkflowSpecValidationError('spec.inputs must be an object');
  }

  return {
    ...(description !== undefined ? { description } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    steps,
    version: COORDINATOR_WORKFLOW_SPEC_VERSION,
  };
}

export function normalizeCoordinatorWorkflowStepAppend(
  existingSpec: CoordinatorWorkflowSpecSnapshot,
  steps: unknown,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowStepAppendNormalizationResult {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new CoordinatorWorkflowSpecValidationError('steps must be a non-empty array');
  }

  const sourceSpec = normalizeCoordinatorWorkflowSpec(
    {
      ...(existingSpec.description !== undefined ? { description: existingSpec.description } : {}),
      ...(existingSpec.inputs !== undefined ? { inputs: existingSpec.inputs } : {}),
      steps: [...existingSpec.steps, ...steps],
      version: existingSpec.version,
    },
    options,
  );
  assertAppendDoesNotModifyExistingSteps(existingSpec.steps, sourceSpec);

  return {
    appendedSteps: sourceSpec.steps.slice(existingSpec.steps.length),
    sourceSpec,
  };
}

export function normalizeCoordinatorWorkflowDynamicActions(
  value: unknown,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowDynamicActionSnapshot[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CoordinatorWorkflowSpecValidationError('workflowActions must be a non-empty array');
  }

  const actions = value.map((entry, index) => {
    const label = `workflowActions[${index}]`;
    assertRecord(entry, label);
    const kind = readDynamicActionKind(entry.kind, `${label}.kind`);
    switch (kind) {
      case 'append_branch_bundle':
        return normalizeCoordinatorWorkflowDynamicBranchBundleAction(entry, label, options);
      case 'append_fanout':
      case 'append_synthesize':
      case 'append_verify':
      case 'append_worker':
        return normalizeCoordinatorWorkflowDynamicAppendAction(entry, label, kind, options);
      case 'mark_blocked':
      case 'stop_workflow':
        return normalizeCoordinatorWorkflowDynamicTerminalAction(entry, label, kind, options);
    }
  });

  const seenActionIds = new Set<string>();
  for (const action of actions) {
    if (action.actionId === undefined) {
      continue;
    }
    if (seenActionIds.has(action.actionId)) {
      throw new CoordinatorWorkflowSpecValidationError(
        `workflowActions reuse actionId ${action.actionId}`,
      );
    }
    seenActionIds.add(action.actionId);
  }

  const terminalActions = actions.filter(
    (action) => action.kind === 'mark_blocked' || action.kind === 'stop_workflow',
  );
  if (terminalActions.length > 1) {
    throw new CoordinatorWorkflowSpecValidationError(
      'workflowActions may include at most one terminal action',
    );
  }
  if (terminalActions.length === 1 && actions[actions.length - 1] !== terminalActions[0]) {
    throw new CoordinatorWorkflowSpecValidationError(
      'terminal workflowActions must be the final action',
    );
  }
  if (terminalActions.length === 1 && actions.length > 1) {
    throw new CoordinatorWorkflowSpecValidationError(
      'terminal workflowActions cannot be combined with append actions',
    );
  }

  return actions;
}

export function isCoordinatorWorkflowSpecSnapshot(
  value: unknown,
): value is CoordinatorWorkflowSpecSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  try {
    normalizeCoordinatorWorkflowSpec(value, {
      limits: COORDINATOR_WORKFLOW_SNAPSHOT_VALIDATION_LIMITS,
    });
    return true;
  } catch {
    return false;
  }
}
