import type { CoordinatorSpawnSubtaskPayload } from './coordinator.js';

export const COORDINATOR_WORKFLOW_SPEC_VERSION = 1 as const;

export const COORDINATOR_WORKFLOW_SPEC_STEP_KINDS = [
  'fanout',
  'synthesize',
  'verify',
  'worker',
] as const;

export type CoordinatorWorkflowSpecVersion = typeof COORDINATOR_WORKFLOW_SPEC_VERSION;
export type CoordinatorWorkflowSpecStepKind = (typeof COORDINATOR_WORKFLOW_SPEC_STEP_KINDS)[number];

export interface CoordinatorWorkflowSpecLaneSnapshot {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  assignment?: string;
  dedupeKey?: string;
  id: string;
  name: string;
  role?: string;
}

export interface CoordinatorWorkflowSpecVerifierSnapshot {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  assignment?: string;
  dedupeKey?: string;
  id: string;
  name: string;
  role?: string;
}

export interface CoordinatorWorkflowSpecStepPolicySnapshot {
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

export interface CoordinatorWorkflowSpecValidationLimits {
  assignmentTextMaxChars: number;
  maxWorkflowLanes: number;
  maxWorkflowMetadataBytes: number;
  maxWorkflowShortTextChars: number;
  workflowMaxLaneTimeoutMs: number;
}

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
  const name = readOptionalString(
    value.name,
    `${label}.name`,
    options.limits.maxWorkflowShortTextChars,
  );
  const skipPermissionsArgs = readOptionalStringArray(
    value.skipPermissionsArgs,
    `${label}.skipPermissionsArgs`,
    options.limits.maxWorkflowShortTextChars,
  );

  return {
    ...(args.length > 0 ? { args } : {}),
    command,
    ...(env !== undefined ? { env } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(skipPermissionsArgs.length > 0 ? { skipPermissionsArgs } : {}),
  };
}

function readStepKind(value: unknown, label: string): CoordinatorWorkflowSpecStepKind {
  if (value !== 'fanout' && value !== 'synthesize' && value !== 'verify' && value !== 'worker') {
    throw new CoordinatorWorkflowSpecValidationError(
      `${label} must be fanout, synthesize, verify, or worker`,
    );
  }

  return value;
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
  if (timeoutMs !== undefined && timeoutMs > limits.workflowMaxLaneTimeoutMs) {
    throw new CoordinatorWorkflowSpecValidationError(
      `step.policy.timeoutMs must be no greater than ${limits.workflowMaxLaneTimeoutMs}`,
    );
  }
  const resultRequired = readOptionalBoolean(value.resultRequired, 'step.policy.resultRequired');

  return {
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

function readStep(
  value: unknown,
  index: number,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowSpecStepSnapshot {
  assertRecord(value, `steps[${index}]`);
  const step = value as NormalizedStepInput;
  const kind = readStepKind(step.kind, `steps[${index}].kind`);
  const id = readRequiredString(
    step.id,
    `steps[${index}].id`,
    options.limits.maxWorkflowShortTextChars,
  );
  const name =
    readOptionalString(
      step.name,
      `steps[${index}].name`,
      options.limits.maxWorkflowShortTextChars,
    ) ?? id;
  const agent = readAgent(step.agent, `steps[${index}].agent`, options, options.fallbackAgent);
  const lanes = readLanes(step.lanes, `steps[${index}].lanes`, options, agent);
  const verifiers = readLanes(step.verifiers, `steps[${index}].verifiers`, options, agent);
  const policy = readStepPolicy(step.policy, options.limits);
  const assignment = readOptionalString(
    step.assignment,
    `steps[${index}].assignment`,
    options.limits.assignmentTextMaxChars,
  );
  const findingSourceStepId = readOptionalString(
    step.findingSourceStepId,
    `steps[${index}].findingSourceStepId`,
    options.limits.maxWorkflowShortTextChars,
  );
  const includeEvidence = readOptionalBoolean(
    step.includeEvidence,
    `steps[${index}].includeEvidence`,
  );
  const includeFindings = readOptionalBoolean(
    step.includeFindings,
    `steps[${index}].includeFindings`,
  );
  const includeUnverifiedFindings = readOptionalBoolean(
    step.includeUnverifiedFindings,
    `steps[${index}].includeUnverifiedFindings`,
  );
  const includeVerdicts = readOptionalBoolean(
    step.includeVerdicts,
    `steps[${index}].includeVerdicts`,
  );
  const minimumVerifierCount = readOptionalNonNegativeInteger(
    step.minimumVerifierCount,
    `steps[${index}].minimumVerifierCount`,
  );
  const prompt = readOptionalString(
    step.prompt,
    `steps[${index}].prompt`,
    options.limits.assignmentTextMaxChars,
  );
  const role = readOptionalString(
    step.role,
    `steps[${index}].role`,
    options.limits.maxWorkflowShortTextChars,
  );

  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(assignment !== undefined ? { assignment } : {}),
    dependsOn: readOptionalStringArray(
      step.dependsOn,
      `steps[${index}].dependsOn`,
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
      `steps[${index}].resultSourceStepIds`,
      options.limits.maxWorkflowShortTextChars,
    ),
    ...(role !== undefined ? { role } : {}),
    sourceStepIds: readOptionalStringArray(
      step.sourceStepIds,
      `steps[${index}].sourceStepIds`,
      options.limits.maxWorkflowShortTextChars,
    ),
    verifiers,
  };
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
  }
}

function assertStepShape(step: CoordinatorWorkflowSpecStepSnapshot): void {
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
  }
}

function countSpecLanes(steps: CoordinatorWorkflowSpecStepSnapshot[]): number {
  return steps.reduce((count, step) => {
    if (step.kind === 'verify') {
      return count + step.verifiers.length;
    }
    if (step.kind === 'synthesize') {
      return count + 1;
    }
    if (step.kind === 'worker' && step.lanes.length === 0) {
      return count + 1;
    }

    return count + step.lanes.length;
  }, 0);
}

export function normalizeCoordinatorWorkflowSpec(
  value: unknown,
  options: WorkflowSpecNormalizationOptions,
): CoordinatorWorkflowSpecSnapshot {
  assertRecord(value, 'spec');
  if (value.version !== undefined && value.version !== COORDINATOR_WORKFLOW_SPEC_VERSION) {
    throw new CoordinatorWorkflowSpecValidationError(
      `spec.version must be ${COORDINATOR_WORKFLOW_SPEC_VERSION}`,
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
  assertNoCycles(steps);

  const laneCount = countSpecLanes(steps);
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

export function isCoordinatorWorkflowSpecSnapshot(
  value: unknown,
): value is CoordinatorWorkflowSpecSnapshot {
  if (!isRecord(value) || value.version !== COORDINATOR_WORKFLOW_SPEC_VERSION) {
    return false;
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    return false;
  }
  if (value.inputs !== undefined && !isRecord(value.inputs)) {
    return false;
  }

  return Array.isArray(value.steps);
}
