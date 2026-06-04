import {
  COORDINATOR_LIMITS,
  isCoordinatorTerminalWorkflowLaneStatus,
  type CoordinatorSpawnManyLanePayload,
  type CoordinatorSpawnSubtaskPayload,
  type CoordinatorStartWorkflowLanePayload,
  type CoordinatorSubtaskSnapshot,
  type CoordinatorWorkflowExecutionSnapshot,
  type CoordinatorWorkflowFindingSnapshot,
  type CoordinatorWorkflowPolicyPayload,
  type CoordinatorWorkflowPolicySnapshot,
  type CoordinatorWorkflowResultSnapshot,
  type CoordinatorWorkflowSnapshot,
  type CoordinatorWorkflowStageKind,
  type CoordinatorWorkflowTemplate,
  type CoordinatorWorkflowVerdictSnapshot,
} from '../../src/domain/coordinator.js';
import {
  COORDINATOR_WORKFLOW_SPEC_VERSION,
  normalizeCoordinatorWorkflowSpec,
  type CoordinatorWorkflowSpecLaneSnapshot,
  type CoordinatorWorkflowSpecSnapshot,
  type CoordinatorWorkflowSpecStepSnapshot,
} from '../../src/domain/coordinator-workflow-spec.js';
import { BadRequestError } from '../ipc/errors.js';
import {
  appendCoordinatorWorkflowJournal,
  cancelCoordinatorPromptsForTask,
  createCoordinatorWorkflow,
  getCoordinatorRun,
  getCoordinatorWorkflow,
  updateCoordinatorWorkflow,
  updateCoordinatorWorkflowLane,
  updateCoordinatorWorkflowStage,
} from './runtime.js';

export const DEFAULT_WORKFLOW_AGENT_COMMAND = 'codex';
export const DEFAULT_WORKFLOW_CONCURRENCY = 3;

export interface WorkflowSpawnedLane {
  error?: string;
  laneId: string;
  subtask?: CoordinatorSubtaskSnapshot;
}

export type SpawnCoordinatorWorkflowLane = (
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
  lanePayload: CoordinatorSpawnManyLanePayload,
) => Promise<WorkflowSpawnedLane>;

export interface StartCoordinatorWorkflowExecutionOptions {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  lanes?: CoordinatorStartWorkflowLanePayload[];
  policy?: CoordinatorWorkflowPolicyPayload;
  problem: string;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  spec?: unknown;
  template: CoordinatorWorkflowTemplate;
  title?: string;
}

export interface StartCoordinatorWorkflowExecutionResult {
  lanes: WorkflowSpawnedLane[];
  workflow: CoordinatorWorkflowSnapshot;
}

export interface AdvanceCoordinatorWorkflowExecutionOptions {
  laneId: string;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

export interface TickCoordinatorWorkflowExecutionOptions {
  now?: number;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

interface ReconcileWorkflowOptions {
  now?: number;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

interface EffectiveStagePolicy {
  resultRequired: boolean;
  retryBackoffMs: number;
  retryCount: number;
  timeoutMs: number;
}

function getNow(now: number | undefined): number {
  return now ?? Date.now();
}

function getWorkflowOrThrow(runId: string, workflowId: string): CoordinatorWorkflowSnapshot {
  const workflow = getCoordinatorWorkflow(runId, workflowId);
  if (!workflow) {
    throw new BadRequestError('Coordinator workflow not found');
  }

  return workflow;
}

function mergeWorkflowPolicyPayload(
  policy: CoordinatorWorkflowPolicyPayload | undefined,
  laneCount: number,
): Partial<CoordinatorWorkflowPolicySnapshot> {
  return {
    maxConcurrentLanes: Math.max(DEFAULT_WORKFLOW_CONCURRENCY, laneCount),
    ...(policy ?? {}),
  };
}

function readSpec(
  value: unknown,
  options: Pick<StartCoordinatorWorkflowExecutionOptions, 'agent' | 'policy'>,
): CoordinatorWorkflowSpecSnapshot {
  try {
    return normalizeCoordinatorWorkflowSpec(value, {
      ...(options.agent !== undefined ? { fallbackAgent: options.agent } : {}),
      limits: {
        assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
        maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
        maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
        maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
        workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new BadRequestError(error.message);
    }

    throw new BadRequestError('Invalid workflow spec');
  }
}

function createWorkflowStageKind(
  template: CoordinatorWorkflowTemplate,
  step: CoordinatorWorkflowSpecStepSnapshot,
): CoordinatorWorkflowStageKind {
  if (template === 'map_reduce' && step.id === 'map') {
    return 'map';
  }
  if (template === 'map_reduce' && step.id === 'reduce') {
    return 'reduce';
  }
  if (template === 'adversarial_review' && step.id === 'find') {
    return 'find';
  }
  if (template === 'adversarial_review' && step.id === 'judge') {
    return 'judge';
  }

  switch (step.kind) {
    case 'fanout':
      return 'fan-out';
    case 'synthesize':
      return 'synthesize';
    case 'verify':
      return 'verify';
    case 'worker':
      return 'custom';
  }
}

function createStageDefinitions(
  template: CoordinatorWorkflowTemplate,
  spec: CoordinatorWorkflowSpecSnapshot,
): Array<{
  dependsOn?: string[];
  id: string;
  kind: CoordinatorWorkflowStageKind;
  name: string;
}> {
  return spec.steps.map((step) => ({
    dependsOn: step.dependsOn,
    id: step.id,
    kind: createWorkflowStageKind(template, step),
    name: step.name,
  }));
}

function getDefaultWorkflowLanes(
  payload: Pick<StartCoordinatorWorkflowExecutionOptions, 'lanes' | 'problem' | 'template'>,
): CoordinatorStartWorkflowLanePayload[] {
  if (payload.lanes && payload.lanes.length > 0) {
    return payload.lanes;
  }

  switch (payload.template) {
    case 'adversarial_review':
      return [
        {
          assignment: [
            'Find every plausible flaw, inconsistency, incomplete path, reliability risk, performance risk, or maintainability concern.',
            `Problem: ${payload.problem}`,
            'Return findings with concrete evidence. Do not fix anything.',
          ].join('\n'),
          name: 'Critic',
          role: 'critic',
        },
      ];
    case 'map_reduce':
      return [
        {
          assignment: `Analyze the backend/runtime angle for: ${payload.problem}`,
          name: 'Backend',
          role: 'map',
        },
        {
          assignment: `Analyze the UI/product angle for: ${payload.problem}`,
          name: 'UI',
          role: 'map',
        },
        {
          assignment: `Analyze the validation/testing angle for: ${payload.problem}`,
          name: 'Validation',
          role: 'map',
        },
      ];
    case 'custom':
      return [
        {
          assignment: payload.problem,
          name: 'Worker',
          role: 'custom',
        },
      ];
  }
}

function createLaneSnapshotFromStartLane(
  lane: CoordinatorStartWorkflowLanePayload,
  index: number,
  fallbackAgent?: CoordinatorSpawnSubtaskPayload['agent'],
): CoordinatorWorkflowSpecLaneSnapshot {
  const agent = lane.agent ?? fallbackAgent;
  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(lane.assignment !== undefined ? { assignment: lane.assignment } : {}),
    id: lane.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `lane-${index + 1}`,
    name: lane.name,
    ...(lane.role !== undefined ? { role: lane.role } : {}),
  };
}

function createTemplateWorkflowSpec(
  options: Pick<
    StartCoordinatorWorkflowExecutionOptions,
    'agent' | 'lanes' | 'problem' | 'template'
  >,
): CoordinatorWorkflowSpecSnapshot {
  const lanes = getDefaultWorkflowLanes(options).map((lane, index) =>
    createLaneSnapshotFromStartLane(lane, index, options.agent),
  );

  switch (options.template) {
    case 'adversarial_review':
      return {
        steps: [
          {
            dependsOn: [],
            id: 'find',
            kind: 'fanout',
            lanes,
            name: 'Find',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
          {
            dependsOn: ['find'],
            findingSourceStepId: 'find',
            id: 'verify',
            kind: 'verify',
            lanes: [],
            name: 'Verify',
            resultSourceStepIds: ['find'],
            sourceStepIds: ['find'],
            verifiers: [
              {
                id: 'skeptic',
                name: 'Skeptic',
                role: 'verifier',
              },
            ],
          },
          {
            dependsOn: ['verify'],
            id: 'judge',
            includeFindings: true,
            includeVerdicts: true,
            kind: 'synthesize',
            lanes: [],
            name: 'Judge',
            prompt:
              'Decide which verified findings are confirmed, semi-confirmed, or highly likely.',
            resultSourceStepIds: ['find', 'verify'],
            role: 'judge',
            sourceStepIds: ['find', 'verify'],
            verifiers: [],
          },
          {
            dependsOn: ['judge'],
            id: 'synthesize',
            includeFindings: true,
            includeVerdicts: true,
            kind: 'synthesize',
            lanes: [],
            name: 'Synthesize',
            resultSourceStepIds: ['find', 'verify', 'judge'],
            sourceStepIds: ['find', 'verify', 'judge'],
            verifiers: [],
          },
        ],
        version: COORDINATOR_WORKFLOW_SPEC_VERSION,
      };
    case 'map_reduce':
      return {
        steps: [
          {
            dependsOn: [],
            id: 'map',
            kind: 'fanout',
            lanes,
            name: 'Map',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
          {
            dependsOn: ['map'],
            id: 'reduce',
            includeFindings: true,
            kind: 'synthesize',
            lanes: [],
            name: 'Reduce',
            resultSourceStepIds: ['map'],
            role: 'reduce',
            sourceStepIds: ['map'],
            verifiers: [],
          },
        ],
        version: COORDINATOR_WORKFLOW_SPEC_VERSION,
      };
    case 'custom':
      return {
        steps: [
          {
            dependsOn: [],
            id: 'fan-out',
            kind: 'fanout',
            lanes,
            name: 'Fan-out',
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
        ],
        version: COORDINATOR_WORKFLOW_SPEC_VERSION,
      };
  }
}

function getStep(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): CoordinatorWorkflowSpecStepSnapshot | undefined {
  return workflow.sourceSpec?.steps.find((step) => step.id === stageId);
}

function getStage(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): CoordinatorWorkflowSnapshot['stages'][number] {
  const stage = workflow.stages.find((candidate) => candidate.id === stageId);
  if (!stage) {
    throw new BadRequestError('Coordinator workflow stage not found');
  }

  return stage;
}

function getStageLanes(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): Array<CoordinatorWorkflowSnapshot['lanes'][number]> {
  const stageLaneIds = new Set(getStage(workflow, stageId).laneIds);
  return workflow.lanes.filter((lane) => stageLaneIds.has(lane.id));
}

function getStageExecutionPolicy(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): EffectiveStagePolicy {
  const stepPolicy = getStep(workflow, stageId)?.policy;
  return {
    resultRequired: stepPolicy?.resultRequired ?? workflow.policy.resultRequired,
    retryBackoffMs: stepPolicy?.retryBackoffMs ?? workflow.policy.retryBackoffMs,
    retryCount: stepPolicy?.retryCount ?? workflow.policy.retryCount,
    timeoutMs: stepPolicy?.timeoutMs ?? workflow.policy.timeoutMs,
  };
}

function getLaneByTask(
  workflow: CoordinatorWorkflowSnapshot,
  taskId: string,
): CoordinatorWorkflowSnapshot['lanes'][number] | undefined {
  return workflow.lanes.find((lane) => lane.taskId === taskId);
}

function trimWorkflowAssignment(text: string): string {
  if (text.length <= COORDINATOR_LIMITS.assignmentTextMaxChars) {
    return text;
  }

  return `${text.slice(0, COORDINATOR_LIMITS.assignmentTextMaxChars - 32)}\n[truncated]`;
}

function getLaneBaseAssignment(
  workflow: CoordinatorWorkflowSnapshot,
  lane: Pick<CoordinatorSpawnManyLanePayload, 'assignment' | 'name' | 'role'>,
  problem: string,
): string {
  const body = lane.assignment ?? problem;
  return [
    `Workflow: ${workflow.title}`,
    lane.role !== undefined ? `Role: ${lane.role}` : `Lane: ${lane.name}`,
    body,
    '',
    'When finished, call submit_result with summary, findings, evidence, commandsRun, risks, and confidence.',
  ].join('\n');
}

function summarizeWorkflowResults(
  workflow: CoordinatorWorkflowSnapshot,
  sourceStageIds?: string[],
): string {
  const sourceIds = sourceStageIds !== undefined ? new Set(sourceStageIds) : null;
  const results = sourceIds
    ? workflow.results.filter(
        (result) => result.stageId !== undefined && sourceIds.has(result.stageId),
      )
    : workflow.results;
  if (results.length === 0) {
    return 'No typed results have been submitted yet.';
  }

  return results
    .map((result, index) => {
      const lane = result.laneId
        ? workflow.lanes.find((candidate) => candidate.id === result.laneId)
        : undefined;
      const label = lane?.name ?? result.taskId;
      const findings =
        result.findings.length > 0
          ? `\nFindings:\n${result.findings.map((finding) => `- ${finding.summary}`).join('\n')}`
          : '';
      const risks =
        result.risks.length > 0
          ? `\nRisks:\n${result.risks.map((risk) => `- ${risk}`).join('\n')}`
          : '';
      return [
        `Result ${index + 1}: ${label}`,
        `Status: ${result.status}`,
        `Confidence: ${result.confidence ?? 'unspecified'}`,
        result.summary,
        findings,
        risks,
      ]
        .filter((part) => part.length > 0)
        .join('\n');
    })
    .join('\n\n');
}

function summarizeWorkflowVerdicts(workflow: CoordinatorWorkflowSnapshot): string {
  if (!workflow.verdicts || workflow.verdicts.length === 0) {
    return 'No verifier verdicts have been submitted yet.';
  }

  return workflow.verdicts
    .map(
      (verdict, index) =>
        `Verdict ${index + 1}: ${verdict.status} ${verdict.findingId}\n${verdict.reason}`,
    )
    .join('\n\n');
}

function createVerificationAssignment(
  workflow: CoordinatorWorkflowSnapshot,
  step: CoordinatorWorkflowSpecStepSnapshot,
  verifier: CoordinatorWorkflowSpecLaneSnapshot,
): string {
  let sourceStageIds: string[];
  if (step.resultSourceStepIds.length > 0) {
    sourceStageIds = step.resultSourceStepIds;
  } else if (step.findingSourceStepId !== undefined) {
    sourceStageIds = [step.findingSourceStepId];
  } else {
    sourceStageIds = step.dependsOn;
  }

  return trimWorkflowAssignment(
    [
      `Workflow: ${workflow.title}`,
      `Role: ${verifier.role ?? 'verifier'}`,
      verifier.assignment ??
        'Try to disprove each submitted finding. Do not look for new issues unless needed to evaluate a finding.',
      '',
      summarizeWorkflowResults(workflow, sourceStageIds),
      '',
      'Submit metadata.verdicts as an array of { findingId, status, reason }. Use status confirmed, refuted, or needs-more-evidence.',
    ].join('\n'),
  );
}

function createSynthesisAssignment(
  workflow: CoordinatorWorkflowSnapshot,
  step: CoordinatorWorkflowSpecStepSnapshot,
): string {
  const sourceStageIds = step.sourceStepIds.length > 0 ? step.sourceStepIds : step.dependsOn;
  return trimWorkflowAssignment(
    [
      `Workflow: ${workflow.title}`,
      `Role: ${step.role ?? step.name}`,
      step.prompt ?? 'Synthesize the prior typed results into one decision-ready output.',
      '',
      summarizeWorkflowResults(workflow, sourceStageIds),
      '',
      step.includeVerdicts === true ? summarizeWorkflowVerdicts(workflow) : '',
      '',
      'When finished, call submit_result with summary, findings, evidence, commandsRun, risks, and confidence.',
    ]
      .filter((part) => part.length > 0)
      .join('\n'),
  );
}

function createWorkerLanePayload(
  workflow: CoordinatorWorkflowSnapshot,
  step: CoordinatorWorkflowSpecStepSnapshot,
  problem: string,
): CoordinatorSpawnManyLanePayload {
  const lane = step.lanes[0];
  const name = lane?.name ?? step.name;
  const role = lane?.role ?? step.role ?? step.kind;
  const assignment = lane?.assignment ?? step.assignment ?? step.prompt ?? problem;
  return {
    agent: lane?.agent ?? step.agent ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
    assignment: trimWorkflowAssignment(
      getLaneBaseAssignment(workflow, { assignment, name, role }, problem),
    ),
    dedupeKey: lane?.dedupeKey ?? `${workflow.id}:${step.id}:${name}`,
    name,
    role,
  };
}

function createFanoutLanePayloads(
  workflow: CoordinatorWorkflowSnapshot,
  step: CoordinatorWorkflowSpecStepSnapshot,
  problem: string,
): CoordinatorSpawnManyLanePayload[] {
  return step.lanes.map((lane) => {
    const role = lane.role ?? step.role ?? step.kind;
    const assignment = lane.assignment ?? step.assignment ?? step.prompt ?? problem;
    return {
      agent: lane.agent ?? step.agent ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
      assignment: trimWorkflowAssignment(
        getLaneBaseAssignment(workflow, { assignment, name: lane.name, role }, problem),
      ),
      dedupeKey: lane.dedupeKey ?? `${workflow.id}:${step.id}:${lane.id}`,
      name: lane.name,
      role,
    };
  });
}

function createStageLanePayloads(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): CoordinatorSpawnManyLanePayload[] {
  const step = getStep(workflow, stageId);
  if (!step) {
    return [
      {
        agent: { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
        assignment: trimWorkflowAssignment(
          [
            `Workflow: ${workflow.title}`,
            `Role: ${stageId}`,
            summarizeWorkflowResults(workflow),
            '',
            'When finished, call submit_result with summary, findings, evidence, commandsRun, risks, and confidence.',
          ].join('\n'),
        ),
        dedupeKey: `${workflow.id}:${stageId}`,
        name: getStage(workflow, stageId).name,
        role: stageId,
      },
    ];
  }

  switch (step.kind) {
    case 'fanout':
      return createFanoutLanePayloads(workflow, step, workflow.title);
    case 'synthesize':
      return [
        {
          agent: step.agent ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
          assignment: createSynthesisAssignment(workflow, step),
          dedupeKey: `${workflow.id}:${step.id}:${step.kind}`,
          name: step.name,
          role: step.role ?? step.kind,
        },
      ];
    case 'verify':
      return step.verifiers.map((verifier) => ({
        agent: verifier.agent ?? step.agent ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
        assignment: createVerificationAssignment(workflow, step, verifier),
        dedupeKey: verifier.dedupeKey ?? `${workflow.id}:${step.id}:${verifier.id}`,
        name: verifier.name,
        role: verifier.role ?? 'verifier',
      }));
    case 'worker':
      return [createWorkerLanePayload(workflow, step, workflow.title)];
  }
}

function countStepLanes(step: CoordinatorWorkflowSpecStepSnapshot | undefined): number {
  if (step === undefined) {
    return 0;
  }

  switch (step.kind) {
    case 'fanout':
      return step.lanes.length;
    case 'synthesize':
      return 1;
    case 'verify':
      return step.verifiers.length;
    case 'worker':
      return Math.max(1, step.lanes.length);
  }
}

function countWorkflowSpecLanes(spec: CoordinatorWorkflowSpecSnapshot): number {
  return spec.steps.reduce((count, step) => count + countStepLanes(step), 0);
}

function getCompletedStageStatus(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): CoordinatorWorkflowSnapshot['stages'][number]['status'] {
  const lanes = getStageLanes(workflow, stageId);
  const stagePolicy = getStageExecutionPolicy(workflow, stageId);
  const hasCancelledLane = lanes.some((lane) => lane.status === 'cancelled');
  const hasHardFailure = lanes.some(
    (lane) =>
      lane.status === 'failed' ||
      lane.status === 'timed-out' ||
      lane.status === 'stale-after-restore',
  );
  const hasBlockedLane = lanes.some(
    (lane) => lane.status === 'blocked' || lane.status === 'cancelled',
  );
  const resultCount = lanes.filter((lane) => lane.resultId !== undefined).length;
  const requiredResultCount = getRequiredStageResultCount(workflow, stageId);
  if (hasCancelledLane) {
    return 'cancelled';
  }
  if (hasBlockedLane) {
    return 'blocked';
  }
  if (stagePolicy.resultRequired && resultCount < requiredResultCount) {
    return 'failed';
  }
  if (hasHardFailure && !workflow.policy.continueOnFailure) {
    return 'failed';
  }
  if (hasHardFailure && resultCount === 0) {
    return 'failed';
  }

  return 'completed';
}

function getRequiredStageResultCount(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): number {
  const step = getStep(workflow, stageId);
  if (step?.kind === 'verify' && step.minimumVerifierCount !== undefined) {
    return step.minimumVerifierCount;
  }

  return 1;
}

function getCompletedWorkflowStatus(
  workflow: CoordinatorWorkflowSnapshot,
): CoordinatorWorkflowSnapshot['status'] {
  const hasCancelledStage = workflow.stages.some((stage) => stage.status === 'cancelled');
  const hasFailedStage = workflow.stages.some((stage) => stage.status === 'failed');
  const hasBlockedStage = workflow.stages.some((stage) => stage.status === 'blocked');
  if (hasCancelledStage) {
    return 'cancelled';
  }
  if (hasFailedStage) {
    return 'failed';
  }
  if (hasBlockedStage) {
    return 'blocked';
  }

  return 'completed';
}

function isStageReady(
  workflow: CoordinatorWorkflowSnapshot,
  stage: CoordinatorWorkflowSnapshot['stages'][number],
): boolean {
  if (stage.status !== 'pending' || stage.laneIds.length > 0) {
    return false;
  }

  return stage.dependsOn.every((dependencyId) => {
    const dependency = workflow.stages.find((candidate) => candidate.id === dependencyId);
    return dependency?.status === 'completed';
  });
}

function createExecutionSnapshot(
  workflow: CoordinatorWorkflowSnapshot,
  now: number,
): CoordinatorWorkflowExecutionSnapshot {
  const activeLaneCount = workflow.lanes.filter(
    (lane) => !isCoordinatorTerminalWorkflowLaneStatus(lane.status),
  ).length;
  const laneDedupeKeys = new Set(
    workflow.lanes.flatMap((lane) => (lane.dedupeKey !== undefined ? [lane.dedupeKey] : [])),
  );
  const failedLane = workflow.lanes.find(
    (lane) => lane.failure !== undefined && isCoordinatorTerminalWorkflowLaneStatus(lane.status),
  );
  const retryState = getWorkflowRetryState(workflow, now);
  return {
    activeLaneCount,
    ...(failedLane?.failure !== undefined ? { failureSummary: failedLane.failure } : {}),
    lastTickAt: now,
    ...(retryState.nextRetryAt !== undefined ? { nextRetryAt: retryState.nextRetryAt } : {}),
    pendingRetryLaneIds: retryState.pendingLaneIds.filter((laneId) => {
      const lane = workflow.lanes.find((candidate) => candidate.id === laneId);
      return (
        lane !== undefined &&
        !laneDedupeKeys.has(`${lane.dedupeKey ?? lane.id}:retry:${lane.attempt + 1}`)
      );
    }),
    readyStageIds: workflow.stages
      .filter((stage) => isStageReady(workflow, stage))
      .map((stage) => stage.id),
  };
}

function refreshExecutionSnapshot(
  runId: string,
  workflowId: string,
  now: number,
): CoordinatorWorkflowSnapshot {
  const workflow = getWorkflowOrThrow(runId, workflowId);
  return updateCoordinatorWorkflow(runId, workflowId, {
    execution: createExecutionSnapshot(workflow, now),
    now,
  });
}

function getActiveLaneCount(workflow: CoordinatorWorkflowSnapshot): number {
  return workflow.lanes.filter((lane) => !isCoordinatorTerminalWorkflowLaneStatus(lane.status))
    .length;
}

function findRetryPayload(
  workflow: CoordinatorWorkflowSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
): CoordinatorSpawnManyLanePayload {
  const nextAttempt = lane.attempt + 1;
  const basePayload = createStageLanePayloads(workflow, lane.stageId).find(
    (payload) => payload.name === lane.name && payload.role === lane.role,
  );
  return {
    agent: basePayload?.agent ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
    assignment: lane.assignment,
    attempt: nextAttempt,
    dedupeKey: `${lane.dedupeKey ?? lane.id}:retry:${nextAttempt}`,
    name: lane.name,
    ...(lane.role !== undefined ? { role: lane.role } : {}),
  };
}

function getLaneRetryDedupeKey(lane: CoordinatorWorkflowSnapshot['lanes'][number]): string {
  return `${lane.dedupeKey ?? lane.id}:retry:${lane.attempt + 1}`;
}

function getLaneRetryReadyAt(
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  stagePolicy: EffectiveStagePolicy,
): number {
  return (lane.completedAt ?? lane.updatedAt) + stagePolicy.retryBackoffMs;
}

function canRetryLane(
  workflow: CoordinatorWorkflowSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
): boolean {
  if ((lane.status !== 'failed' && lane.status !== 'timed-out') || lane.resultId !== undefined) {
    return false;
  }
  if (workflow.lanes.length >= COORDINATOR_LIMITS.maxWorkflowLanes) {
    return false;
  }

  const stagePolicy = getStageExecutionPolicy(workflow, lane.stageId);
  return lane.attempt <= stagePolicy.retryCount;
}

function hasPendingRetryableLane(
  workflow: CoordinatorWorkflowSnapshot,
  lanes: Array<CoordinatorWorkflowSnapshot['lanes'][number]>,
): boolean {
  return lanes.some(
    (lane) => canRetryLane(workflow, lane) && !hasScheduledRetryLane(workflow, lane),
  );
}

function hasScheduledRetryLane(
  workflow: CoordinatorWorkflowSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
): boolean {
  const retryDedupeKey = getLaneRetryDedupeKey(lane);
  return workflow.lanes.some((candidate) => candidate.dedupeKey === retryDedupeKey);
}

function getWorkflowRetryState(
  workflow: CoordinatorWorkflowSnapshot,
  now: number,
): {
  nextRetryAt?: number;
  pendingLaneIds: string[];
} {
  let nextRetryAt: number | undefined;
  const pendingLaneIds: string[] = [];
  for (const lane of workflow.lanes) {
    if (!canRetryLane(workflow, lane) || hasScheduledRetryLane(workflow, lane)) {
      continue;
    }

    const retryReadyAt = getLaneRetryReadyAt(lane, getStageExecutionPolicy(workflow, lane.stageId));
    pendingLaneIds.push(lane.id);
    if (retryReadyAt <= now) {
      continue;
    }
    nextRetryAt = nextRetryAt === undefined ? retryReadyAt : Math.min(nextRetryAt, retryReadyAt);
  }

  return {
    ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
    pendingLaneIds,
  };
}

async function scheduleLaneRetries(
  options: ReconcileWorkflowOptions,
  workflow: CoordinatorWorkflowSnapshot,
): Promise<WorkflowSpawnedLane[]> {
  const spawned: WorkflowSpawnedLane[] = [];
  const now = getNow(options.now);
  let activeLaneCount = getActiveLaneCount(workflow);
  for (const lane of workflow.lanes) {
    if (!canRetryLane(workflow, lane) || hasScheduledRetryLane(workflow, lane)) {
      continue;
    }

    if (activeLaneCount >= workflow.policy.maxConcurrentLanes) {
      continue;
    }
    if (workflow.lanes.length + spawned.length >= COORDINATOR_LIMITS.maxWorkflowLanes) {
      continue;
    }

    const retryReadyAt = getLaneRetryReadyAt(lane, getStageExecutionPolicy(workflow, lane.stageId));
    if (retryReadyAt > now) {
      continue;
    }

    appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
      kind: 'lane-retry-scheduled',
      laneId: lane.id,
      message: `Retrying lane ${lane.name}, attempt ${lane.attempt + 1}.`,
      stageId: lane.stageId,
    });
    const result = await options.spawnLane(
      workflow,
      lane.stageId,
      findRetryPayload(workflow, lane),
    );
    activeLaneCount += result.error === undefined ? 1 : 0;
    spawned.push(result);
  }

  return spawned;
}

async function spawnReadyStages(
  options: ReconcileWorkflowOptions,
  workflow: CoordinatorWorkflowSnapshot,
): Promise<WorkflowSpawnedLane[]> {
  const spawned: WorkflowSpawnedLane[] = [];
  let activeLaneCount = getActiveLaneCount(workflow);
  for (const stage of workflow.stages) {
    if (!isStageReady(workflow, stage)) {
      continue;
    }

    const lanePayloads = createStageLanePayloads(workflow, stage.id);
    if (
      workflow.lanes.length + spawned.length + lanePayloads.length >
      COORDINATOR_LIMITS.maxWorkflowLanes
    ) {
      updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stage.id, {
        completedAt: Date.now(),
        failure: `Workflow lane limit ${COORDINATOR_LIMITS.maxWorkflowLanes} reached.`,
        status: 'failed',
      });
      updateCoordinatorWorkflow(workflow.runId, workflow.id, {
        completedAt: Date.now(),
        status: 'failed',
      });
      break;
    }
    if (activeLaneCount + lanePayloads.length > workflow.policy.maxConcurrentLanes) {
      continue;
    }

    for (const lanePayload of lanePayloads) {
      const result = await options.spawnLane(workflow, stage.id, lanePayload);
      activeLaneCount += result.error === undefined ? 1 : 0;
      spawned.push(result);
    }
  }

  return spawned;
}

function completeTerminalStages(
  runId: string,
  workflowId: string,
): {
  changed: boolean;
  workflow: CoordinatorWorkflowSnapshot;
} {
  let workflow = getWorkflowOrThrow(runId, workflowId);
  let changed = false;
  for (const stage of workflow.stages) {
    if (
      stage.laneIds.length === 0 ||
      (stage.status !== 'running' && stage.status !== 'waiting-for-results')
    ) {
      continue;
    }

    const stageLanes = getStageLanes(workflow, stage.id);
    if (!stageLanes.every((lane) => isCoordinatorTerminalWorkflowLaneStatus(lane.status))) {
      continue;
    }
    if (hasPendingRetryableLane(workflow, stageLanes)) {
      continue;
    }

    const nextStatus = getCompletedStageStatus(workflow, stage.id);
    updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stage.id, {
      completedAt: Date.now(),
      resultIds: stageLanes.flatMap((lane) => (lane.resultId !== undefined ? [lane.resultId] : [])),
      status: nextStatus,
    });
    workflow = getWorkflowOrThrow(runId, workflowId);
    changed = true;
    if (nextStatus === 'blocked' || nextStatus === 'cancelled' || nextStatus === 'failed') {
      updateCoordinatorWorkflow(workflow.runId, workflow.id, {
        completedAt: Date.now(),
        status: nextStatus,
      });
      workflow = getWorkflowOrThrow(runId, workflowId);
      break;
    }
  }

  return { changed, workflow };
}

function completeWorkflowIfDone(runId: string, workflowId: string): CoordinatorWorkflowSnapshot {
  const workflow = getWorkflowOrThrow(runId, workflowId);
  if (
    workflow.status === 'cancelled' ||
    workflow.status === 'failed' ||
    workflow.status === 'blocked' ||
    workflow.status === 'completed' ||
    workflow.status === 'stale-after-restore'
  ) {
    return workflow;
  }
  if (
    workflow.stages.every(
      (stage) =>
        stage.status === 'completed' ||
        stage.status === 'failed' ||
        stage.status === 'blocked' ||
        stage.status === 'cancelled',
    )
  ) {
    return updateCoordinatorWorkflow(workflow.runId, workflow.id, {
      completedAt: Date.now(),
      status: getCompletedWorkflowStatus(workflow),
    });
  }

  return workflow;
}

async function reconcileCoordinatorWorkflowExecution(
  options: ReconcileWorkflowOptions,
): Promise<StartCoordinatorWorkflowExecutionResult> {
  const spawned: WorkflowSpawnedLane[] = [];
  const now = getNow(options.now);
  let workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  if (workflow.status === 'stale-after-restore' || workflow.status === 'cancelled') {
    return { lanes: spawned, workflow };
  }

  for (let iteration = 0; iteration < COORDINATOR_LIMITS.maxWorkflowLanes + 2; iteration += 1) {
    const retryLanes = await scheduleLaneRetries(options, workflow);
    spawned.push(...retryLanes);
    workflow = getWorkflowOrThrow(options.runId, options.workflowId);
    const terminalResult = completeTerminalStages(options.runId, options.workflowId);
    workflow = terminalResult.workflow;
    const readyLanes = await spawnReadyStages(options, workflow);
    spawned.push(...readyLanes);
    workflow = completeWorkflowIfDone(options.runId, options.workflowId);
    if (!terminalResult.changed && retryLanes.length === 0 && readyLanes.length === 0) {
      break;
    }
  }

  workflow = refreshExecutionSnapshot(options.runId, options.workflowId, now);
  return { lanes: spawned, workflow };
}

export async function startCoordinatorWorkflowExecution(
  options: StartCoordinatorWorkflowExecutionOptions,
): Promise<StartCoordinatorWorkflowExecutionResult> {
  if (options.spec !== undefined && options.template !== 'custom') {
    throw new BadRequestError('spec is only supported with the custom workflow template');
  }

  const sourceSpec =
    options.spec !== undefined
      ? readSpec(options.spec, options)
      : createTemplateWorkflowSpec(options);
  const totalLaneCount = countWorkflowSpecLanes(sourceSpec);
  if (totalLaneCount > COORDINATOR_LIMITS.maxWorkflowLanes) {
    throw new BadRequestError(
      `workflow spec creates ${totalLaneCount} lanes, above limit ${COORDINATOR_LIMITS.maxWorkflowLanes}`,
    );
  }

  const maxStageLaneCount = sourceSpec.steps.reduce(
    (count, step) => Math.max(count, countStepLanes(step)),
    0,
  );
  const policy = mergeWorkflowPolicyPayload(options.policy, maxStageLaneCount);
  const maxConcurrentLanes =
    policy.maxConcurrentLanes ?? COORDINATOR_LIMITS.maxActiveSubtasksPerRun;
  if (maxStageLaneCount > maxConcurrentLanes) {
    throw new BadRequestError('start_workflow exceeds workflow maxConcurrentLanes');
  }

  const now = Date.now();
  const workflow = createCoordinatorWorkflow({
    execution: {
      activeLaneCount: 0,
      lastTickAt: now,
      pendingRetryLaneIds: [],
      readyStageIds: sourceSpec.steps
        .filter((step) => step.dependsOn.length === 0)
        .map((step) => step.id),
    },
    policy,
    runId: options.runId,
    sourceSpec,
    stages: createStageDefinitions(options.template, sourceSpec),
    template: options.template,
    title: options.title ?? options.template.replace(/_/g, ' '),
    verdicts: [],
  });

  return reconcileCoordinatorWorkflowExecution({
    now,
    runId: options.runId,
    spawnLane: options.spawnLane,
    workflowId: workflow.id,
  });
}

export async function advanceCoordinatorWorkflowExecution(
  options: AdvanceCoordinatorWorkflowExecutionOptions,
): Promise<CoordinatorWorkflowSnapshot> {
  const result = await reconcileCoordinatorWorkflowExecution(options);
  return result.workflow;
}

export function normalizeWorkflowFindingsForResult(
  result: Pick<CoordinatorWorkflowResultSnapshot, 'id' | 'laneId' | 'stageId'>,
  findings: CoordinatorWorkflowFindingSnapshot[],
): CoordinatorWorkflowFindingSnapshot[] {
  return findings.map((finding, index) => {
    const normalized: CoordinatorWorkflowFindingSnapshot = {
      ...finding,
      id: finding.id ?? `${result.id}:finding:${index + 1}`,
      sourceResultId: finding.sourceResultId ?? result.id,
    };
    if (result.laneId !== undefined) {
      normalized.sourceLaneId = finding.sourceLaneId ?? result.laneId;
    }
    return normalized;
  });
}

function readVerdictStatus(value: unknown): CoordinatorWorkflowVerdictSnapshot['status'] {
  if (value !== 'confirmed' && value !== 'refuted' && value !== 'needs-more-evidence') {
    throw new BadRequestError('verdict.status must be confirmed, refuted, or needs-more-evidence');
  }

  return value;
}

function extractVerdictsFromResult(
  workflow: CoordinatorWorkflowSnapshot,
  result: CoordinatorWorkflowResultSnapshot,
): CoordinatorWorkflowVerdictSnapshot[] {
  const verdicts = result.metadata?.verdicts;
  if (!Array.isArray(verdicts)) {
    return [];
  }

  const knownFindingIds = new Set(
    workflow.results.flatMap((candidate) =>
      candidate.findings.flatMap((finding) => (finding.id !== undefined ? [finding.id] : [])),
    ),
  );
  return verdicts.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestError('metadata.verdicts entries must be objects');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.findingId !== 'string' || record.findingId.length === 0) {
      throw new BadRequestError('verdict.findingId must be a non-empty string');
    }
    if (!knownFindingIds.has(record.findingId)) {
      throw new BadRequestError('verdict.findingId must reference a workflow finding');
    }
    if (typeof record.reason !== 'string' || record.reason.length === 0) {
      throw new BadRequestError('verdict.reason must be a non-empty string');
    }

    return {
      createdAt: result.createdAt,
      findingId: record.findingId,
      id: `${result.id}:verdict:${index + 1}`,
      reason: record.reason,
      resultId: result.id,
      status: readVerdictStatus(record.status),
      verifierLaneId: result.laneId ?? 'unknown-lane',
    };
  });
}

export function recordWorkflowVerdictsFromResult(
  runId: string,
  workflowId: string,
  result: CoordinatorWorkflowResultSnapshot,
): CoordinatorWorkflowSnapshot {
  const workflow = getWorkflowOrThrow(runId, workflowId);
  const verdicts = extractVerdictsFromResult(workflow, result);
  if (verdicts.length === 0) {
    return workflow;
  }

  appendCoordinatorWorkflowJournal(runId, workflowId, {
    kind: 'verdicts-submitted',
    message: `Recorded ${verdicts.length} verifier verdicts.`,
    resultId: result.id,
    ...(result.laneId !== undefined ? { laneId: result.laneId } : {}),
    ...(result.stageId !== undefined ? { stageId: result.stageId } : {}),
  });
  const latest = getWorkflowOrThrow(runId, workflowId);
  return updateCoordinatorWorkflow(runId, workflowId, {
    verdicts: [...(latest.verdicts ?? []), ...verdicts],
  });
}

export async function tickCoordinatorWorkflowExecution(
  options: TickCoordinatorWorkflowExecutionOptions,
): Promise<CoordinatorWorkflowSnapshot> {
  const now = getNow(options.now);
  let workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  for (const lane of workflow.lanes) {
    if (
      isCoordinatorTerminalWorkflowLaneStatus(lane.status) ||
      lane.timeoutAt === undefined ||
      lane.timeoutAt > now
    ) {
      continue;
    }

    if (lane.taskId !== undefined) {
      cancelCoordinatorPromptsForTask(options.runId, lane.taskId, 'workflow-lane-timed-out');
    }
    updateCoordinatorWorkflowLane(options.runId, options.workflowId, lane.id, {
      completedAt: now,
      failure: `Lane timed out after ${getStageExecutionPolicy(workflow, lane.stageId).timeoutMs} ms.`,
      now,
      status: 'timed-out',
    });
    appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
      at: now,
      kind: 'lane-timed-out',
      laneId: lane.id,
      message: `Lane ${lane.name} timed out.`,
      stageId: lane.stageId,
    });
    workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  }

  const result = await reconcileCoordinatorWorkflowExecution({ ...options, now });
  return result.workflow;
}

export function getCoordinatorWorkflowNextTickAt(
  workflow: CoordinatorWorkflowSnapshot,
  now = Date.now(),
): number | null {
  if (
    workflow.status === 'cancelled' ||
    workflow.status === 'completed' ||
    workflow.status === 'failed' ||
    workflow.status === 'blocked' ||
    workflow.status === 'stale-after-restore'
  ) {
    return null;
  }

  const activeTimeouts: number[] = [];
  for (const lane of workflow.lanes) {
    if (isCoordinatorTerminalWorkflowLaneStatus(lane.status) || lane.timeoutAt === undefined) {
      continue;
    }
    activeTimeouts.push(lane.timeoutAt);
  }
  const retryState = getWorkflowRetryState(workflow, now);
  const activeLaneCount = getActiveLaneCount(workflow);
  const retryTimes: number[] = [];
  if (activeLaneCount < workflow.policy.maxConcurrentLanes) {
    const pendingRetryLaneIds = new Set(retryState.pendingLaneIds);
    for (const lane of workflow.lanes) {
      if (!pendingRetryLaneIds.has(lane.id)) {
        continue;
      }
      retryTimes.push(getLaneRetryReadyAt(lane, getStageExecutionPolicy(workflow, lane.stageId)));
    }
  }
  const tickTimes = [...activeTimeouts, ...retryTimes];
  if (tickTimes.length === 0) {
    return null;
  }

  return Math.min(...tickTimes);
}

export function cancelCoordinatorWorkflowExecution(
  runId: string,
  workflowId: string,
  reason: string,
): CoordinatorWorkflowSnapshot {
  const workflow = getWorkflowOrThrow(runId, workflowId);
  const now = Date.now();
  for (const lane of workflow.lanes) {
    if (isCoordinatorTerminalWorkflowLaneStatus(lane.status)) {
      continue;
    }
    if (lane.taskId !== undefined) {
      cancelCoordinatorPromptsForTask(runId, lane.taskId, reason);
    }
    updateCoordinatorWorkflowLane(runId, workflowId, lane.id, {
      completedAt: now,
      failure: reason,
      now,
      status: 'cancelled',
    });
  }

  appendCoordinatorWorkflowJournal(runId, workflowId, {
    at: now,
    kind: 'workflow-cancelled',
    message: reason,
  });
  const latest = getWorkflowOrThrow(runId, workflowId);
  return updateCoordinatorWorkflow(runId, workflowId, {
    completedAt: now,
    execution: {
      ...createExecutionSnapshot(latest, now),
      cancelledAt: now,
      blockedReason: reason,
    },
    now,
    status: 'cancelled',
  });
}

export function resolveSubmittedWorkflowLane(
  runId: string,
  taskId: string,
  workflowId: string | undefined,
  laneId: string | undefined,
): {
  lane: CoordinatorWorkflowSnapshot['lanes'][number];
  workflow: CoordinatorWorkflowSnapshot;
} {
  const run = getCoordinatorRun(runId);
  if (!run) {
    throw new BadRequestError('Coordinator run is no longer active');
  }
  const workflows = workflowId
    ? run.workflows.filter((workflow) => workflow.id === workflowId)
    : run.workflows;
  const matches: Array<{
    lane: CoordinatorWorkflowSnapshot['lanes'][number];
    workflow: CoordinatorWorkflowSnapshot;
  }> = [];

  for (const workflow of workflows) {
    if (laneId !== undefined) {
      const lane = workflow.lanes.find((candidate) => candidate.id === laneId);
      if (!lane) {
        continue;
      }
      if (lane.taskId !== taskId) {
        throw new BadRequestError('laneId must belong to the calling subtask');
      }
      matches.push({ lane, workflow });
      continue;
    }

    const lane = getLaneByTask(workflow, taskId);
    if (lane) {
      matches.push({ lane, workflow });
    }
  }

  if (matches.length === 0) {
    throw new BadRequestError('submit_result could not resolve a workflow lane for this subtask');
  }
  if (matches.length > 1) {
    throw new BadRequestError('submit_result is ambiguous; provide workflowId and laneId');
  }

  return matches[0] as {
    lane: CoordinatorWorkflowSnapshot['lanes'][number];
    workflow: CoordinatorWorkflowSnapshot;
  };
}
