import { createHash } from 'node:crypto';

import {
  COORDINATOR_LIMITS,
  coordinatorRunAdmitsNewWork,
  countCoordinatorWorkflowRetriesUsed,
  createCoordinatorWorkflowBudgetSnapshot,
  formatCoordinatorWorkflowBudgetExhaustedReason,
  getCommittedWorkflowLaneCount,
  getCoordinatorWorkflowBudgetLimits,
  getCoordinatorWorkflowLaneRetryDedupeKey,
  getCoordinatorWorkflowStageRequiredResultCount,
  hasScheduledCoordinatorWorkflowLaneRetry,
  isCoordinatorTerminalWorkflowLaneStatus,
  isCoordinatorTerminalWorkflowStatus,
  isCoordinatorWorkflowStageDependencySatisfied,
  type CoordinatorSpawnManyLanePayload,
  type CoordinatorSpawnSubtaskPayload,
  type CoordinatorStartWorkflowLanePayload,
  type CoordinatorSubtaskSnapshot,
  type CoordinatorWorkflowBudgetDimension,
  type CoordinatorWorkflowBudgetLimits,
  type CoordinatorWorkflowBudgetUsageSnapshot,
  type CoordinatorWorkflowExpansionActionSnapshot,
  type CoordinatorWorkflowExpansionSnapshot,
  type CoordinatorWorkflowExecutionSnapshot,
  type CoordinatorWorkflowFindingSnapshot,
  type CoordinatorWorkflowPendingApprovalSnapshot,
  type CoordinatorWorkflowPolicyPayload,
  type CoordinatorWorkflowResultSnapshot,
  type CoordinatorWorkflowResultStatus,
  type CoordinatorWorkflowSnapshot,
  type CoordinatorWorkflowStageKind,
  type CoordinatorWorkflowStepAppendSnapshot,
  type CoordinatorWorkflowTemplate,
  type CoordinatorWorkflowVerdictSnapshot,
} from '../../src/domain/coordinator.js';
import {
  COORDINATOR_WORKFLOW_SPEC_VERSION,
  countCoordinatorWorkflowSpecLanes,
  countCoordinatorWorkflowSpecStepLanes,
  normalizeCoordinatorWorkflowDynamicActions,
  normalizeCoordinatorWorkflowSpec,
  normalizeCoordinatorWorkflowStepAppend,
  type CoordinatorWorkflowDynamicActionSnapshot,
  type CoordinatorWorkflowDynamicBranchBundleActionSnapshot,
  type CoordinatorWorkflowSpecLaneSnapshot,
  type CoordinatorWorkflowSpecStepJoinMode,
  type CoordinatorWorkflowSpecSnapshot,
  type CoordinatorWorkflowSpecStepSnapshot,
  type CoordinatorWorkflowSpecValidationLimits,
  type CoordinatorWorkflowStepAppendNormalizationResult,
} from '../../src/domain/coordinator-workflow-spec.js';
import { BadRequestError } from '../ipc/errors.js';
import {
  addCoordinatorWorkflowPendingApproval,
  appendCoordinatorWorkflowSteps,
  appendCoordinatorWorkflowJournal,
  cancelCoordinatorPromptsForTask,
  cancelCoordinatorWorkflowPendingApprovals,
  createCoordinatorWorkflow,
  getCoordinatorOwnedLaneWorkflowCandidates,
  getCoordinatorRunStatus,
  getCoordinatorWorkflow,
  resolveCoordinatorWorkflowPendingApproval,
  type CoordinatorOwnedLaneWorkflowProjection,
  type CoordinatorWorkflowSchedulingProjection,
  updateCoordinatorWorkflow,
  updateCoordinatorWorkflowLane,
  updateCoordinatorWorkflowStage,
} from './runtime.js';
import { withCoordinatorWorkflowLaneConcurrency } from './workflow-policy.js';

export const DEFAULT_WORKFLOW_AGENT_COMMAND = 'codex';
export { DEFAULT_WORKFLOW_CONCURRENCY } from './workflow-policy.js';

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

export interface AppendCoordinatorWorkflowStepsExecutionOptions {
  appendId: string;
  reason?: string;
  runId: string;
  sourceLaneId?: string;
  sourceTaskId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  steps: unknown[];
  workflowId: string;
}

export interface AppendCoordinatorWorkflowStepsExecutionResult {
  append: CoordinatorWorkflowStepAppendSnapshot;
  lanes: WorkflowSpawnedLane[];
  workflow: CoordinatorWorkflowSnapshot;
}

export interface AdvanceCoordinatorWorkflowExecutionOptions {
  laneId: string;
  result?: CoordinatorWorkflowResultSnapshot;
  runId: string;
  sourceTaskId?: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowActions?: CoordinatorWorkflowDynamicActionSnapshot[];
  workflowId: string;
}

export interface TickCoordinatorWorkflowExecutionOptions {
  now?: number;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

export type RespawnCoordinatorWorkflowLane = (
  workflow: CoordinatorWorkflowSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
) => Promise<WorkflowSpawnedLane>;

export interface ResumeCoordinatorWorkflowExecutionOptions {
  now?: number;
  respawnLane: RespawnCoordinatorWorkflowLane;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

export interface ResumeCoordinatorWorkflowExecutionResult {
  failed: Array<{ laneId: string; reason: string; taskId?: string }>;
  respawned: string[];
  workflow: CoordinatorWorkflowSnapshot;
}

export interface RecordPendingWorkflowApprovalOptions {
  actions: CoordinatorWorkflowDynamicActionSnapshot[];
  laneId: string;
  now?: number;
  resultId: string;
  runId: string;
  stageId: string;
  workflowId: string;
}

export interface ApproveCoordinatorWorkflowActionsOptions {
  approvalId: string;
  now?: number;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

export interface DenyCoordinatorWorkflowActionsOptions {
  approvalId: string;
  now?: number;
  reason?: string;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

export interface RetryCoordinatorWorkflowLaneFromOperatorOptions {
  laneId: string;
  now?: number;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

export interface CoordinatorWorkflowApprovalResolutionResult {
  approval: CoordinatorWorkflowPendingApprovalSnapshot;
  workflow: CoordinatorWorkflowSnapshot;
}

interface ResolveOwnedWorkflowLaneOptions {
  actionName: string;
  requireActiveLane?: boolean;
}

type CoordinatorWorkflowDecisionReadSnapshot = Pick<
  CoordinatorWorkflowSnapshot,
  | 'appendPolicy'
  | 'execution'
  | 'expansions'
  | 'id'
  | 'lanes'
  | 'policy'
  | 'runId'
  | 'sourceSpec'
  | 'stages'
  | 'status'
  | 'stepAppends'
>;

interface ReconcileWorkflowOptions {
  now?: number;
  runId: string;
  spawnLane: SpawnCoordinatorWorkflowLane;
  workflowId: string;
}

interface EffectiveStagePolicy {
  joinMode: CoordinatorWorkflowSpecStepJoinMode;
  quorumCount?: number;
  resultRequired: boolean;
  retryBackoffMs: number;
  retryCount: number;
  timeoutMs: number;
}

interface DecisionAppendActionPlan {
  actionId: string;
  kind: Extract<
    CoordinatorWorkflowDynamicActionSnapshot['kind'],
    | 'append_branch_bundle'
    | 'append_fanout'
    | 'append_synthesize'
    | 'append_verify'
    | 'append_worker'
  >;
  branchKey?: string;
  bundleId?: string;
  iteration?: number;
  steps: CoordinatorWorkflowSpecStepSnapshot[];
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

function getSpecNormalizationLimits(): CoordinatorWorkflowSpecValidationLimits {
  return {
    assignmentTextMaxChars: COORDINATOR_LIMITS.assignmentTextMaxChars,
    maxWorkflowBranchIterations: COORDINATOR_LIMITS.maxWorkflowBranchIterations,
    maxWorkflowLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
    maxWorkflowMetadataBytes: COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
    maxWorkflowShortTextChars: COORDINATOR_LIMITS.maxWorkflowShortTextChars,
    workflowMaxLaneTimeoutMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
  };
}

function readSpec(
  value: unknown,
  options: Pick<StartCoordinatorWorkflowExecutionOptions, 'agent' | 'policy'>,
): CoordinatorWorkflowSpecSnapshot {
  try {
    return normalizeCoordinatorWorkflowSpec(value, {
      ...(options.agent !== undefined ? { fallbackAgent: options.agent } : {}),
      limits: getSpecNormalizationLimits(),
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
    case 'decision':
      return 'decision';
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

function createStageDefinition(
  template: CoordinatorWorkflowTemplate,
  step: CoordinatorWorkflowSpecStepSnapshot,
): {
  dependsOn?: string[];
  id: string;
  kind: CoordinatorWorkflowStageKind;
  name: string;
} {
  return {
    dependsOn: step.dependsOn,
    id: step.id,
    kind: createWorkflowStageKind(template, step),
    name: step.name,
  };
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
  return spec.steps.map((step) => createStageDefinition(template, step));
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
    case 'repo_review':
      return [
        {
          assignment: `Review backend runtime and coordinator execution risks for: ${payload.problem}`,
          name: 'Backend',
          role: 'map',
        },
        {
          assignment: `Review coordinator UI, operator clarity, and interaction risks for: ${payload.problem}`,
          name: 'UI',
          role: 'map',
        },
        {
          assignment: `Review tests, proving gaps, and validation risks for: ${payload.problem}`,
          name: 'Validation',
          role: 'map',
        },
        {
          assignment: `Review docs, ownership, and architecture alignment for: ${payload.problem}`,
          name: 'Docs',
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
    case 'repo_review':
      return {
        steps: [
          {
            dependsOn: [],
            id: 'scan',
            kind: 'fanout',
            lanes,
            name: 'Scan',
            policy: {
              joinMode: 'quorum',
              quorumCount: 2,
            },
            resultSourceStepIds: [],
            sourceStepIds: [],
            verifiers: [],
          },
          {
            dependsOn: ['scan'],
            findingSourceStepId: 'scan',
            id: 'verify',
            kind: 'verify',
            lanes: [],
            name: 'Verify',
            policy: {
              joinMode: 'quorum',
              quorumCount: 2,
            },
            resultSourceStepIds: ['scan'],
            sourceStepIds: ['scan'],
            verifiers: [
              {
                id: 'skeptic',
                name: 'Skeptic',
                role: 'verifier',
              },
              {
                id: 'archivist',
                name: 'Archivist',
                role: 'verifier',
              },
            ],
          },
          {
            dependsOn: ['verify'],
            id: 'decide',
            includeFindings: true,
            includeVerdicts: true,
            kind: 'decision',
            lanes: [],
            name: 'Decide',
            prompt:
              'Decide whether the repo review needs narrower follow-up work. Append only focused next steps or stop when the review is complete.',
            resultSourceStepIds: ['scan', 'verify'],
            sourceStepIds: ['scan', 'verify'],
            verifiers: [],
          },
          {
            dependsOn: ['decide'],
            id: 'synthesize',
            includeFindings: true,
            includeVerdicts: true,
            kind: 'synthesize',
            lanes: [],
            name: 'Synthesize',
            resultSourceStepIds: ['scan', 'verify', 'decide'],
            sourceStepIds: ['scan', 'verify', 'decide'],
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
  workflow: CoordinatorWorkflowSchedulingProjection,
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
  workflow: CoordinatorWorkflowSchedulingProjection,
  stageId: string,
): EffectiveStagePolicy {
  const stepPolicy = getStep(workflow, stageId)?.policy;
  return {
    joinMode: stepPolicy?.joinMode ?? 'all',
    ...(stepPolicy?.quorumCount !== undefined ? { quorumCount: stepPolicy.quorumCount } : {}),
    resultRequired: stepPolicy?.resultRequired ?? workflow.policy.resultRequired,
    retryBackoffMs: stepPolicy?.retryBackoffMs ?? workflow.policy.retryBackoffMs,
    retryCount: stepPolicy?.retryCount ?? workflow.policy.retryCount,
    timeoutMs: stepPolicy?.timeoutMs ?? workflow.policy.timeoutMs,
  };
}

function getLaneByTask(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'lanes'>,
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

function createDecisionAssignment(
  workflow: CoordinatorWorkflowSnapshot,
  step: CoordinatorWorkflowSpecStepSnapshot,
): string {
  const sourceStageIds = getDecisionAssignmentSourceStageIds(step);
  return trimWorkflowAssignment(
    [
      `Workflow: ${workflow.title}`,
      `Role: ${step.role ?? step.name}`,
      step.prompt ??
        'Decide whether the workflow needs more work. Append only the next useful steps, block when user input is required, or stop when the workflow can end cleanly now.',
      '',
      summarizeWorkflowResults(workflow, sourceStageIds),
      '',
      step.includeVerdicts === true ? summarizeWorkflowVerdicts(workflow) : '',
      '',
      'If follow-up is needed, call submit_result with metadata.workflowActions using append_worker, append_fanout, append_verify, append_synthesize, or append_branch_bundle.',
      'Use mark_blocked only when progress needs user input. Use stop_workflow only when this lane is the only active work left and the workflow should end now.',
    ]
      .filter((part) => part.length > 0)
      .join('\n'),
  );
}

function getDecisionAssignmentSourceStageIds(step: CoordinatorWorkflowSpecStepSnapshot): string[] {
  if (step.sourceStepIds.length > 0) {
    return step.sourceStepIds;
  }
  if (step.resultSourceStepIds.length > 0) {
    return step.resultSourceStepIds;
  }

  return step.dependsOn;
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
    case 'decision':
      return [
        {
          agent: step.lanes[0]?.agent ?? step.agent ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
          assignment: createDecisionAssignment(workflow, step),
          dedupeKey: getWorkerStepLaneDedupeKey(workflow.id, step),
          name: step.lanes[0]?.name ?? step.name,
          role: step.lanes[0]?.role ?? step.role ?? 'decision',
        },
      ];
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
  return step === undefined ? 0 : countCoordinatorWorkflowSpecStepLanes(step);
}

function hashWorkflowAppendPayload(steps: unknown[]): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(steps);
  } catch {
    throw new BadRequestError('append workflow steps must be JSON-serializable');
  }
  if (serialized === undefined) {
    throw new BadRequestError('append workflow steps must be JSON-serializable');
  }

  return createHash('sha256').update(serialized).digest('hex');
}

function getWorkerStepLaneDedupeKey(
  workflowId: string,
  step: CoordinatorWorkflowSpecStepSnapshot,
): string {
  const lane = step.lanes[0];
  const name = lane?.name ?? step.name;
  return lane?.dedupeKey ?? `${workflowId}:${step.id}:${name}`;
}

function getStepLaneDedupeKeys(
  workflowId: string,
  step: CoordinatorWorkflowSpecStepSnapshot,
): string[] {
  switch (step.kind) {
    case 'decision':
      return [getWorkerStepLaneDedupeKey(workflowId, step)];
    case 'fanout':
      return step.lanes.map((lane) => lane.dedupeKey ?? `${workflowId}:${step.id}:${lane.id}`);
    case 'synthesize':
      return [`${workflowId}:${step.id}:${step.kind}`];
    case 'verify':
      return step.verifiers.map(
        (verifier) => verifier.dedupeKey ?? `${workflowId}:${step.id}:${verifier.id}`,
      );
    case 'worker':
      return [getWorkerStepLaneDedupeKey(workflowId, step)];
  }
}

function assertAppendedLaneDedupeKeys(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'id' | 'lanes' | 'sourceSpec'>,
  appendedSteps: CoordinatorWorkflowSpecStepSnapshot[],
): void {
  const reservedKeys = new Set(
    workflow.lanes.flatMap((lane) => (lane.dedupeKey !== undefined ? [lane.dedupeKey] : [])),
  );
  for (const step of workflow.sourceSpec?.steps ?? []) {
    for (const dedupeKey of getStepLaneDedupeKeys(workflow.id, step)) {
      reservedKeys.add(dedupeKey);
    }
  }

  const appendedKeys = new Set<string>();
  for (const step of appendedSteps) {
    for (const dedupeKey of getStepLaneDedupeKeys(workflow.id, step)) {
      if (reservedKeys.has(dedupeKey) || appendedKeys.has(dedupeKey)) {
        throw new BadRequestError(`append workflow steps reuse lane dedupeKey ${dedupeKey}`);
      }
      appendedKeys.add(dedupeKey);
    }
  }
}

function withDefaultDecisionDependency(
  step: CoordinatorWorkflowSpecStepSnapshot,
  stageId: string,
): CoordinatorWorkflowSpecStepSnapshot {
  if (step.dependsOn.length > 0) {
    return step;
  }

  return {
    ...step,
    dependsOn: [stageId],
  };
}

function getWorkflowDecisionActionId(
  action: CoordinatorWorkflowDynamicActionSnapshot,
  resultId: string,
  index: number,
): string {
  return action.actionId ?? `${resultId}:action:${index + 1}`;
}

function isWorkflowBranchBundleAction(
  action: CoordinatorWorkflowDynamicActionSnapshot,
): action is CoordinatorWorkflowDynamicBranchBundleActionSnapshot {
  return action.kind === 'append_branch_bundle';
}

function isWorkflowAppendAction(
  action: CoordinatorWorkflowDynamicActionSnapshot,
): action is Extract<CoordinatorWorkflowDynamicActionSnapshot, { step: unknown }> {
  return 'step' in action;
}

function isWorkflowTerminalAction(
  action: CoordinatorWorkflowDynamicActionSnapshot | undefined,
): action is Extract<
  CoordinatorWorkflowDynamicActionSnapshot,
  { kind: 'mark_blocked' | 'stop_workflow' }
> {
  return action?.kind === 'mark_blocked' || action?.kind === 'stop_workflow';
}

function humanizeBundleName(bundleId: string): string {
  return bundleId
    .split(/[-_]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getWorkflowBranchIterationCount(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'expansions'>,
  branchKey: string,
): number {
  return (workflow.expansions ?? [])
    .flatMap((expansion) => expansion.actions)
    .filter((action) => action.branchKey === branchKey && action.iteration !== undefined).length;
}

function createBranchBundleSteps(
  action: CoordinatorWorkflowDynamicBranchBundleActionSnapshot,
): CoordinatorWorkflowSpecStepSnapshot[] {
  const bundleName = action.name ?? humanizeBundleName(action.bundleId);
  const fanoutStepId = `${action.bundleId}-fanout`;
  const steps: CoordinatorWorkflowSpecStepSnapshot[] = [
    {
      dependsOn: action.dependsOn ?? [],
      id: fanoutStepId,
      kind: 'fanout',
      lanes: action.lanes,
      name: bundleName,
      resultSourceStepIds: [],
      sourceStepIds: [],
      verifiers: [],
    },
  ];

  let previousStepId = fanoutStepId;
  if (action.verify !== undefined) {
    const verifyStepId = action.verify.id ?? `${action.bundleId}-verify`;
    steps.push({
      ...(action.verify.agent !== undefined ? { agent: action.verify.agent } : {}),
      dependsOn: [previousStepId],
      findingSourceStepId: fanoutStepId,
      id: verifyStepId,
      ...(action.verify.includeEvidence !== undefined
        ? { includeEvidence: action.verify.includeEvidence }
        : {}),
      ...(action.verify.includeFindings !== undefined
        ? { includeFindings: action.verify.includeFindings }
        : {}),
      kind: 'verify',
      lanes: [],
      ...(action.verify.minimumVerifierCount !== undefined
        ? { minimumVerifierCount: action.verify.minimumVerifierCount }
        : {}),
      name: action.verify.name ?? `${bundleName} Verify`,
      policy: {
        ...(action.verify.joinMode !== undefined ? { joinMode: action.verify.joinMode } : {}),
        ...(action.verify.quorumCount !== undefined
          ? { quorumCount: action.verify.quorumCount }
          : {}),
      },
      resultSourceStepIds: [fanoutStepId],
      sourceStepIds: [fanoutStepId],
      verifiers: action.verify.verifiers,
    });
    previousStepId = verifyStepId;
  }

  if (action.reduce !== undefined) {
    steps.push({
      ...(action.reduce.agent !== undefined ? { agent: action.reduce.agent } : {}),
      dependsOn: [previousStepId],
      id: action.reduce.id ?? `${action.bundleId}-reduce`,
      ...(action.reduce.includeFindings !== undefined
        ? { includeFindings: action.reduce.includeFindings }
        : { includeFindings: true }),
      ...(action.reduce.includeVerdicts !== undefined
        ? { includeVerdicts: action.reduce.includeVerdicts }
        : action.verify !== undefined
          ? { includeVerdicts: true }
          : {}),
      kind: 'synthesize',
      lanes: [],
      name: action.reduce.name ?? `${bundleName} Reduce`,
      ...(action.reduce.prompt !== undefined ? { prompt: action.reduce.prompt } : {}),
      resultSourceStepIds:
        action.verify !== undefined ? [fanoutStepId, previousStepId] : [fanoutStepId],
      ...(action.reduce.role !== undefined ? { role: action.reduce.role } : { role: 'reduce' }),
      sourceStepIds: action.verify !== undefined ? [fanoutStepId, previousStepId] : [fanoutStepId],
      verifiers: [],
    });
  }

  return steps;
}

function getDecisionAppendActionPlans(
  actions: CoordinatorWorkflowDynamicActionSnapshot[],
  workflow: CoordinatorWorkflowDecisionReadSnapshot,
  resultId: string,
  stageId: string,
): DecisionAppendActionPlan[] {
  const plans: DecisionAppendActionPlan[] = [];
  for (const [index, action] of actions.entries()) {
    if (isWorkflowBranchBundleAction(action)) {
      const branchKey = action.branchKey ?? action.bundleId;
      const maxIterations = action.maxIterations ?? workflow.policy.maxIterationsPerBranch;
      const nextIteration = getWorkflowBranchIterationCount(workflow, branchKey) + 1;
      if (nextIteration > maxIterations) {
        throw new BadRequestError(
          `workflowActions branch ${branchKey} exceeds iteration limit ${maxIterations}`,
        );
      }
      plans.push({
        actionId: getWorkflowDecisionActionId(action, resultId, index),
        branchKey,
        bundleId: action.bundleId,
        iteration: nextIteration,
        kind: action.kind,
        steps: createBranchBundleSteps({
          ...action,
          dependsOn: action.dependsOn?.length ? action.dependsOn : [stageId],
        }),
      });
      continue;
    }
    if (!isWorkflowAppendAction(action)) {
      continue;
    }

    plans.push({
      actionId: getWorkflowDecisionActionId(action, resultId, index),
      kind: action.kind,
      steps: [withDefaultDecisionDependency(action.step, stageId)],
    });
  }

  return plans;
}

function createDecisionAppendReason(laneName: string, stepId: string): string {
  return `Decision lane ${laneName} appended ${stepId}.`;
}

function createDecisionAppendBatchReason(laneName: string, stepIds: string[]): string {
  const noun = stepIds.length === 1 ? 'step' : 'steps';
  return `Decision lane ${laneName} appended ${stepIds.length} workflow ${noun}: ${stepIds.join(', ')}.`;
}

function validateDecisionAppendActionPlans(
  workflow: CoordinatorWorkflowDecisionReadSnapshot,
  plans: DecisionAppendActionPlan[],
): void {
  if (plans.length === 0) {
    return;
  }
  if (workflow.sourceSpec === undefined) {
    throw new BadRequestError('decision workflowActions require a sourceSpec-backed workflow');
  }
  // The whole decision-action batch is applied as one append, so approve-time re-validation must
  // reject here while the approval is still pending instead of resolving it and then failing
  // inside the apply path.
  assertWorkflowStepAppendCapacity(workflow, 'workflowActions');

  const seenActionIds = new Set<string>();
  for (const plan of plans) {
    if (seenActionIds.has(plan.actionId)) {
      throw new BadRequestError(`workflowActions reuse actionId ${plan.actionId}`);
    }
    seenActionIds.add(plan.actionId);
  }

  const plannedSteps = plans.flatMap((plan) => plan.steps);

  let normalizedAppend: CoordinatorWorkflowStepAppendNormalizationResult;
  try {
    normalizedAppend = normalizeCoordinatorWorkflowStepAppend(workflow.sourceSpec, plannedSteps, {
      limits: getSpecNormalizationLimits(),
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new BadRequestError(error.message);
    }

    throw new BadRequestError('Invalid decision workflowActions');
  }
  const appendedSteps = normalizedAppend.appendedSteps;

  assertWorkflowWithinDeadline(workflow, Date.now());
  assertWorkflowBudgetAdmits(workflow, {
    addedLanes: countCoordinatorWorkflowSpecLanes(appendedSteps),
    addedSteps: appendedSteps.length,
    label: 'workflowActions',
  });

  const maxAppendedStageLaneCount = appendedSteps.reduce(
    (count, step) => Math.max(count, countStepLanes(step)),
    0,
  );
  if (maxAppendedStageLaneCount > workflow.policy.maxConcurrentLanes) {
    throw new BadRequestError('workflowActions exceed workflow maxConcurrentLanes');
  }

  assertAppendedLaneDedupeKeys(workflow, appendedSteps);
}

export function readWorkflowDecisionActions(
  workflow: CoordinatorWorkflowDecisionReadSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  metadata: Record<string, unknown> | undefined,
): CoordinatorWorkflowDynamicActionSnapshot[] {
  const rawActions = metadata?.workflowActions;
  if (rawActions === undefined) {
    return [];
  }

  const step = getStep(workflow, lane.stageId);
  if (step?.kind !== 'decision') {
    throw new BadRequestError('metadata.workflowActions are only supported for decision steps');
  }

  let actions: CoordinatorWorkflowDynamicActionSnapshot[];
  try {
    actions = normalizeCoordinatorWorkflowDynamicActions(rawActions, {
      limits: getSpecNormalizationLimits(),
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new BadRequestError(error.message);
    }
    throw new BadRequestError('Invalid metadata.workflowActions');
  }

  if (actions.length > workflow.appendPolicy.maxActionsPerDecision) {
    throw new BadRequestError(
      `metadata.workflowActions exceeds limit ${workflow.appendPolicy.maxActionsPerDecision}`,
    );
  }

  const appendActionCount = actions.filter(
    (action) => isWorkflowAppendAction(action) || isWorkflowBranchBundleAction(action),
  ).length;
  if (
    (workflow.stepAppends?.length ?? 0) + appendActionCount >
    workflow.appendPolicy.maxStepAppends
  ) {
    throw new BadRequestError(
      `metadata.workflowActions would exceed append limit ${workflow.appendPolicy.maxStepAppends}`,
    );
  }

  return actions;
}

export function getWorkflowResultStatusForActions(
  actions: CoordinatorWorkflowDynamicActionSnapshot[],
  requestedStatus: CoordinatorWorkflowResultSnapshot['status'] | undefined,
): CoordinatorWorkflowResultSnapshot['status'] {
  if (actions.length === 0) {
    return requestedStatus ?? 'completed';
  }

  const terminalAction = actions[actions.length - 1];
  if (terminalAction?.kind === 'mark_blocked') {
    if (
      requestedStatus !== undefined &&
      requestedStatus !== 'blocked' &&
      requestedStatus !== 'needs-followup'
    ) {
      throw new BadRequestError('mark_blocked requires result status blocked or needs-followup');
    }
    return requestedStatus ?? 'blocked';
  }
  if (terminalAction?.kind === 'stop_workflow') {
    if (requestedStatus !== undefined && requestedStatus !== 'completed') {
      throw new BadRequestError('stop_workflow requires result status completed');
    }
    return 'completed';
  }
  if (requestedStatus !== undefined && requestedStatus !== 'completed') {
    throw new BadRequestError('append workflowActions require result status completed');
  }

  return 'completed';
}

export function validateWorkflowDecisionActionsForResult(
  workflow: CoordinatorWorkflowDecisionReadSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  resultId: string,
  actions: CoordinatorWorkflowDynamicActionSnapshot[],
): void {
  if (actions.length === 0) {
    return;
  }

  const appendPlans = getDecisionAppendActionPlans(actions, workflow, resultId, lane.stageId);
  validateDecisionAppendActionPlans(workflow, appendPlans);

  const terminalAction = actions[actions.length - 1];
  if (isWorkflowTerminalAction(terminalAction)) {
    assertTerminalDecisionActionQuiescent(workflow, lane.id, terminalAction.kind);
  }
}

function recordWorkflowExpansion(
  runId: string,
  workflowId: string,
  expansion: CoordinatorWorkflowExpansionSnapshot,
  now: number,
): CoordinatorWorkflowSnapshot {
  const workflow = getWorkflowOrThrow(runId, workflowId);
  return updateCoordinatorWorkflow(runId, workflowId, {
    expansions: [...(workflow.expansions ?? []), expansion],
    now,
  });
}

function assertTerminalDecisionActionQuiescent(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'lanes'>,
  laneId: string,
  actionKind: 'mark_blocked' | 'stop_workflow',
): void {
  const hasOtherActiveLanes = workflow.lanes.some(
    (candidate) =>
      candidate.id !== laneId && !isCoordinatorTerminalWorkflowLaneStatus(candidate.status),
  );
  if (hasOtherActiveLanes) {
    throw new BadRequestError(`${actionKind} requires the calling lane to be the only active lane`);
  }
}

function skipWorkflowPendingStages(
  runId: string,
  workflowId: string,
  reason: string,
  now: number,
): CoordinatorWorkflowSnapshot {
  let workflow = getWorkflowOrThrow(runId, workflowId);
  for (const stage of workflow.stages) {
    if (stage.status !== 'pending') {
      continue;
    }

    updateCoordinatorWorkflowStage(runId, workflowId, stage.id, {
      completedAt: now,
      failure: reason,
      now,
      status: 'skipped',
    });
    workflow = getWorkflowOrThrow(runId, workflowId);
  }

  return workflow;
}

interface CloseOutCoordinatorWorkflowWorkOptions {
  blockedReason: string;
  exhaustedBudgetDimension?: CoordinatorWorkflowBudgetDimension;
  journalKind: string;
  journalMessage: string;
  laneFailure: string;
  now: number;
}

function closeOutCoordinatorWorkflowWork(
  runId: string,
  workflowId: string,
  options: CloseOutCoordinatorWorkflowWorkOptions,
): CoordinatorWorkflowSnapshot {
  cancelCoordinatorWorkflowPendingApprovals(runId, workflowId, {
    now: options.now,
    reason: options.laneFailure,
  });
  const workflow = getWorkflowOrThrow(runId, workflowId);
  for (const lane of workflow.lanes) {
    if (isCoordinatorTerminalWorkflowLaneStatus(lane.status)) {
      continue;
    }
    if (lane.taskId !== undefined) {
      cancelCoordinatorPromptsForTask(runId, lane.taskId, options.journalKind);
    }
    updateCoordinatorWorkflowLane(runId, workflowId, lane.id, {
      completedAt: options.now,
      failure: options.laneFailure,
      now: options.now,
      status: 'cancelled',
    });
  }

  skipWorkflowPendingStages(runId, workflowId, options.laneFailure, options.now);
  appendCoordinatorWorkflowJournal(runId, workflowId, {
    at: options.now,
    kind: options.journalKind,
    message: options.journalMessage,
  });
  const latest = getWorkflowOrThrow(runId, workflowId);
  const execution: CoordinatorWorkflowExecutionSnapshot = {
    ...createExecutionSnapshot(latest, options.now),
    blockedReason: options.blockedReason,
    pendingRetryLaneIds: [],
    readyStageIds: [],
  };
  if (options.exhaustedBudgetDimension !== undefined && execution.budget !== undefined) {
    execution.budget = { ...execution.budget, exhausted: options.exhaustedBudgetDimension };
  }

  return updateCoordinatorWorkflow(runId, workflowId, {
    completedAt: options.now,
    execution,
    now: options.now,
    status: 'blocked',
  });
}

export function tripCoordinatorWorkflowBudget(
  runId: string,
  workflowId: string,
  dimension: CoordinatorWorkflowBudgetDimension,
  usage: CoordinatorWorkflowBudgetUsageSnapshot,
  now: number,
): CoordinatorWorkflowSnapshot {
  const blockedReason = formatCoordinatorWorkflowBudgetExhaustedReason(dimension, usage);
  return closeOutCoordinatorWorkflowWork(runId, workflowId, {
    blockedReason,
    exhaustedBudgetDimension: dimension,
    journalKind: 'workflow-budget-exhausted',
    journalMessage: `Budget exhausted: ${dimension} (${usage.used}/${usage.limit}). Cancelled active lanes and skipped pending stages.`,
    laneFailure: blockedReason,
    now,
  });
}

export function isWorkflowPastDeadline(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'execution'>,
  now: number,
): boolean {
  return workflow.execution?.deadlineAt !== undefined && workflow.execution.deadlineAt <= now;
}

function getWorkflowWallClockExhaustedUsage(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'policy'>,
): CoordinatorWorkflowBudgetUsageSnapshot {
  const limits = getCoordinatorWorkflowBudgetLimits(workflow.policy);
  return { limit: limits.maxWallClockMs, used: limits.maxWallClockMs };
}

/**
 * One wall-clock admission authority for mutation seams. With `tripUnlessCompleted`, a workflow
 * that already finished its work before the deadline is rejected without tripping so the terminal
 * completion is never rewritten to blocked.
 */
export function assertWorkflowWithinDeadline(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'execution' | 'id' | 'policy' | 'runId' | 'status'>,
  now: number,
  options: { tripUnlessCompleted?: boolean } = {},
): void {
  if (!isWorkflowPastDeadline(workflow, now)) {
    return;
  }

  const usage = getWorkflowWallClockExhaustedUsage(workflow);
  if (options.tripUnlessCompleted === true && workflow.status !== 'completed') {
    tripCoordinatorWorkflowBudget(workflow.runId, workflow.id, 'wall-clock', usage, now);
  }
  throw new BadRequestError(formatCoordinatorWorkflowBudgetExhaustedReason('wall-clock', usage));
}

function assertWorkflowStepAppendCapacity(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'appendPolicy' | 'stepAppends'>,
  label: string,
): void {
  if ((workflow.stepAppends?.length ?? 0) >= workflow.appendPolicy.maxStepAppends) {
    throw new BadRequestError(
      `${label} would exceed append limit ${workflow.appendPolicy.maxStepAppends}`,
    );
  }
}

export function assertWorkflowBudgetAdmits(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'lanes' | 'policy' | 'sourceSpec' | 'stages'>,
  options: { addedLanes: number; addedSteps?: number; label: string },
): void {
  const limits = getCoordinatorWorkflowBudgetLimits(workflow.policy);
  if (
    options.addedSteps !== undefined &&
    (workflow.sourceSpec?.steps.length ?? 0) + options.addedSteps > limits.maxTotalSteps
  ) {
    throw new BadRequestError(
      `${options.label} would exceed workflow step budget ${limits.maxTotalSteps}`,
    );
  }
  if (getCommittedWorkflowLaneCount(workflow) + options.addedLanes > limits.maxTotalLanes) {
    throw new BadRequestError(
      `${options.label} would exceed workflow lane limit ${limits.maxTotalLanes}`,
    );
  }
}

function blockWorkflowFromDecisionAction(
  runId: string,
  workflowId: string,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  reason: string,
  now: number,
): CoordinatorWorkflowSnapshot {
  updateCoordinatorWorkflowStage(runId, workflowId, lane.stageId, {
    completedAt: now,
    failure: reason,
    now,
    resultIds: getStageLanes(getWorkflowOrThrow(runId, workflowId), lane.stageId).flatMap(
      (candidate) => (candidate.resultId !== undefined ? [candidate.resultId] : []),
    ),
    status: 'blocked',
  });
  let workflow = skipWorkflowPendingStages(runId, workflowId, reason, now);
  appendCoordinatorWorkflowJournal(runId, workflowId, {
    at: now,
    kind: 'workflow-blocked',
    laneId: lane.id,
    message: reason,
    stageId: lane.stageId,
  });
  workflow = getWorkflowOrThrow(runId, workflowId);
  return updateCoordinatorWorkflow(runId, workflowId, {
    completedAt: now,
    execution: {
      ...createExecutionSnapshot(workflow, now),
      blockedReason: reason,
      pendingRetryLaneIds: [],
      readyStageIds: [],
    },
    now,
    status: 'blocked',
  });
}

function stopWorkflowFromDecisionAction(
  runId: string,
  workflowId: string,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  reason: string,
  now: number,
): CoordinatorWorkflowSnapshot {
  completeTerminalStages(runId, workflowId);
  let workflow = skipWorkflowPendingStages(runId, workflowId, reason, now);
  appendCoordinatorWorkflowJournal(runId, workflowId, {
    at: now,
    kind: 'workflow-stopped',
    laneId: lane.id,
    message: reason,
    stageId: lane.stageId,
  });
  workflow = getWorkflowOrThrow(runId, workflowId);
  return updateCoordinatorWorkflow(runId, workflowId, {
    completedAt: now,
    execution: {
      ...createExecutionSnapshot(workflow, now),
      completionReason: reason,
      pendingRetryLaneIds: [],
      readyStageIds: [],
    },
    now,
    status: 'completed',
  });
}

async function applyDecisionWorkflowActions(
  actions: CoordinatorWorkflowDynamicActionSnapshot[],
  options: {
    lane: CoordinatorWorkflowSnapshot['lanes'][number];
    result: CoordinatorWorkflowResultSnapshot;
    runId: string;
    sourceTaskId: string;
    spawnLane: SpawnCoordinatorWorkflowLane;
    workflowId: string;
  },
): Promise<CoordinatorWorkflowSnapshot> {
  if (actions.length === 0) {
    return getWorkflowOrThrow(options.runId, options.workflowId);
  }

  let workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  const now = options.result.createdAt;
  const appendPlans = getDecisionAppendActionPlans(
    actions,
    workflow,
    options.result.id,
    options.lane.stageId,
  );
  const expansionActions: CoordinatorWorkflowExpansionActionSnapshot[] = [];
  if (appendPlans.length > 0) {
    const appendedSteps = appendPlans.flatMap((plan) => plan.steps);
    const appendResult = await appendCoordinatorWorkflowExecutionSteps({
      appendId: `${options.result.id}:workflow-actions`,
      reason: createDecisionAppendBatchReason(
        options.lane.name,
        appendedSteps.map((step) => step.id),
      ),
      runId: options.runId,
      sourceLaneId: options.lane.id,
      sourceTaskId: options.sourceTaskId,
      spawnLane: options.spawnLane,
      steps: appendedSteps,
      workflowId: options.workflowId,
    });
    workflow = appendResult.workflow;
    for (const plan of appendPlans) {
      const stepIds = plan.steps.map((step) => step.id);
      expansionActions.push({
        actionId: plan.actionId,
        ...(plan.branchKey !== undefined ? { branchKey: plan.branchKey } : {}),
        ...(plan.bundleId !== undefined ? { bundleId: plan.bundleId } : {}),
        ...(plan.iteration !== undefined ? { iteration: plan.iteration } : {}),
        kind: plan.kind,
        reason:
          stepIds.length === 1
            ? createDecisionAppendReason(options.lane.name, stepIds[0] ?? 'step')
            : createDecisionAppendBatchReason(options.lane.name, stepIds),
        stepIds,
      });
    }
  } else {
    const terminalAction = actions[actions.length - 1];
    if (!isWorkflowTerminalAction(terminalAction)) {
      return workflow;
    }

    assertTerminalDecisionActionQuiescent(workflow, options.lane.id, terminalAction.kind);
    if (terminalAction.kind === 'mark_blocked') {
      workflow = blockWorkflowFromDecisionAction(
        options.runId,
        options.workflowId,
        options.lane,
        terminalAction.reason,
        now,
      );
    } else {
      workflow = stopWorkflowFromDecisionAction(
        options.runId,
        options.workflowId,
        options.lane,
        terminalAction.reason,
        now,
      );
    }
    expansionActions.push({
      actionId: getWorkflowDecisionActionId(terminalAction, options.result.id, actions.length - 1),
      kind: terminalAction.kind,
      reason: terminalAction.reason,
    });
  }

  workflow = recordWorkflowExpansion(
    options.runId,
    options.workflowId,
    {
      actions: expansionActions,
      createdAt: now,
      id: `${options.result.id}:expansion`,
      sourceLaneId: options.lane.id,
      sourceResultId: options.result.id,
      sourceTaskId: options.sourceTaskId,
    },
    now,
  );
  return workflow;
}

export function getWorkflowLaneStatusForResultStatus(
  status: CoordinatorWorkflowResultStatus,
): CoordinatorWorkflowSnapshot['lanes'][number]['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'blocked':
    case 'needs-followup':
      return 'blocked';
    case 'failed':
      return 'failed';
  }
}

export function hasPendingWorkflowApprovalForLane(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'pendingApprovals'>,
  laneId: string,
): boolean {
  return (workflow.pendingApprovals ?? []).some(
    (approval) => approval.laneId === laneId && approval.status === 'pending',
  );
}

function isSupersededResumeReplacedLane(
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
): boolean {
  return lane.status === 'cancelled' && lane.supersededByLaneId !== undefined;
}

function getCompletedStageStatus(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): CoordinatorWorkflowSnapshot['stages'][number]['status'] {
  const stage = getStage(workflow, stageId);
  const step = getStep(workflow, stageId);
  const lanes = getStageLanes(workflow, stageId);
  const stagePolicy = getStageExecutionPolicy(workflow, stageId);
  const dependencySatisfied = isCoordinatorWorkflowStageDependencySatisfied(workflow, stage, step);
  const hasCancelledLane = lanes.some(
    (lane) => lane.status === 'cancelled' && !isSupersededResumeReplacedLane(lane),
  );
  const hasHardFailure = lanes.some(
    (lane) =>
      lane.status === 'failed' ||
      lane.status === 'timed-out' ||
      lane.status === 'stale-after-restore',
  );
  const hasBlockedLane = lanes.some(
    (lane) =>
      lane.status === 'blocked' ||
      (lane.status === 'cancelled' && !isSupersededResumeReplacedLane(lane)),
  );
  const resultCount = lanes.filter((lane) => lane.resultId !== undefined).length;
  const requiredResultCount = getCoordinatorWorkflowStageRequiredResultCount(step);
  if (dependencySatisfied) {
    return 'completed';
  }
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

function isStageDependencySatisfied(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): boolean {
  return isCoordinatorWorkflowStageDependencySatisfied(
    workflow,
    getStage(workflow, stageId),
    getStep(workflow, stageId),
  );
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
    return isStageDependencySatisfied(workflow, dependencyId);
  });
}

function createExecutionSnapshot(
  workflow: CoordinatorWorkflowSnapshot,
  now: number,
): CoordinatorWorkflowExecutionSnapshot {
  const activeLaneCount = workflow.lanes.filter(
    (lane) => !isCoordinatorTerminalWorkflowLaneStatus(lane.status),
  ).length;
  const completedStageCount = workflow.stages.filter(
    (stage) => stage.status === 'completed',
  ).length;
  const laneDedupeKeys = new Set(
    workflow.lanes.flatMap((lane) => (lane.dedupeKey !== undefined ? [lane.dedupeKey] : [])),
  );
  const failedLane = workflow.lanes.find(
    (lane) => lane.failure !== undefined && isCoordinatorTerminalWorkflowLaneStatus(lane.status),
  );
  const failedLaneCount = workflow.lanes.filter((lane) => lane.status === 'failed').length;
  const retryState = getWorkflowRetryState(workflow, now);
  const skippedStageCount = workflow.stages.filter((stage) => stage.status === 'skipped').length;
  const timedOutLaneCount = workflow.lanes.filter((lane) => lane.status === 'timed-out').length;
  return {
    activeLaneCount,
    ...(workflow.execution?.blockedReason !== undefined
      ? { blockedReason: workflow.execution.blockedReason }
      : {}),
    budget: createCoordinatorWorkflowBudgetSnapshot(workflow),
    completedStageCount,
    ...(workflow.execution?.completionReason !== undefined
      ? { completionReason: workflow.execution.completionReason }
      : {}),
    ...(workflow.execution?.deadlineAt !== undefined
      ? { deadlineAt: workflow.execution.deadlineAt }
      : {}),
    expansionCount: workflow.expansions?.length ?? 0,
    failedLaneCount,
    ...(failedLane?.failure !== undefined ? { failureSummary: failedLane.failure } : {}),
    lastTickAt: now,
    ...(retryState.nextRetryAt !== undefined ? { nextRetryAt: retryState.nextRetryAt } : {}),
    pendingRetryLaneIds: retryState.pendingLaneIds.filter((laneId) => {
      const lane = workflow.lanes.find((candidate) => candidate.id === laneId);
      return (
        lane !== undefined && !laneDedupeKeys.has(getCoordinatorWorkflowLaneRetryDedupeKey(lane))
      );
    }),
    retryableLaneCount: retryState.pendingLaneIds.length,
    readyStageIds: workflow.stages
      .filter((stage) => isStageReady(workflow, stage))
      .map((stage) => stage.id),
    skippedStageCount,
    timedOutLaneCount,
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

function getActiveLaneCount(workflow: CoordinatorWorkflowSchedulingProjection): number {
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
    dedupeKey: getCoordinatorWorkflowLaneRetryDedupeKey(lane),
    name: lane.name,
    ...(lane.role !== undefined ? { role: lane.role } : {}),
  };
}

function getLaneRetryReadyAt(
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  stagePolicy: EffectiveStagePolicy,
): number {
  return (lane.completedAt ?? lane.updatedAt) + stagePolicy.retryBackoffMs;
}

function isLaneRetryEligible(
  workflow: CoordinatorWorkflowSchedulingProjection,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
): boolean {
  if ((lane.status !== 'failed' && lane.status !== 'timed-out') || lane.resultId !== undefined) {
    return false;
  }

  const stagePolicy = getStageExecutionPolicy(workflow, lane.stageId);
  return lane.attempt <= stagePolicy.retryCount;
}

interface WorkflowRetryBudgetContext {
  committedLaneCount: number;
  limits: CoordinatorWorkflowBudgetLimits;
  retriesUsed: number;
}

function createWorkflowRetryBudgetContext(
  workflow: CoordinatorWorkflowSchedulingProjection,
): WorkflowRetryBudgetContext {
  return {
    committedLaneCount: getCommittedWorkflowLaneCount(workflow),
    limits: getCoordinatorWorkflowBudgetLimits(workflow.policy),
    retriesUsed: countCoordinatorWorkflowRetriesUsed(workflow),
  };
}

function canRetryLane(
  workflow: CoordinatorWorkflowSchedulingProjection,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  context: WorkflowRetryBudgetContext,
): boolean {
  if (!isLaneRetryEligible(workflow, lane)) {
    return false;
  }
  if (context.committedLaneCount >= context.limits.maxTotalLanes) {
    return false;
  }

  return context.retriesUsed < context.limits.maxTotalRetries;
}

function hasPendingRetryableLane(
  workflow: CoordinatorWorkflowSnapshot,
  lanes: Array<CoordinatorWorkflowSnapshot['lanes'][number]>,
): boolean {
  const context = createWorkflowRetryBudgetContext(workflow);
  return lanes.some(
    (lane) => canRetryLane(workflow, lane, context) && !hasScheduledRetryLane(workflow, lane),
  );
}

function hasScheduledRetryLane(
  workflow: CoordinatorWorkflowSchedulingProjection,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
): boolean {
  return hasScheduledCoordinatorWorkflowLaneRetry(workflow, lane);
}

function getWorkflowRetryState(
  workflow: CoordinatorWorkflowSchedulingProjection,
  now: number,
): {
  nextRetryAt?: number;
  pendingLaneIds: string[];
} {
  let nextRetryAt: number | undefined;
  const pendingLaneIds: string[] = [];
  const context = createWorkflowRetryBudgetContext(workflow);
  for (const lane of workflow.lanes) {
    if (!canRetryLane(workflow, lane, context) || hasScheduledRetryLane(workflow, lane)) {
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

function journalWorkflowRetryBudgetExhausted(
  workflow: CoordinatorWorkflowSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  usage: CoordinatorWorkflowBudgetUsageSnapshot,
  now: number,
): void {
  appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
    at: now,
    kind: 'workflow-budget-exhausted',
    laneId: lane.id,
    message: `Budget exhausted: retries (${usage.used}/${usage.limit}). Retry for lane ${lane.name} was not admitted.`,
    stageId: lane.stageId,
  });
  // The once-marker dedupes this journal entry across reconciles without re-reading the journal.
  const latest = getWorkflowOrThrow(workflow.runId, workflow.id);
  const execution = latest.execution ?? createExecutionSnapshot(latest, now);
  updateCoordinatorWorkflow(workflow.runId, workflow.id, {
    execution: {
      ...execution,
      budget: {
        ...(execution.budget ?? createCoordinatorWorkflowBudgetSnapshot(latest)),
        retriesExhaustedAt: now,
      },
    },
    now,
  });
}

async function scheduleLaneRetries(
  options: ReconcileWorkflowOptions,
  workflow: CoordinatorWorkflowSnapshot,
): Promise<WorkflowSpawnedLane[]> {
  const spawned: WorkflowSpawnedLane[] = [];
  const now = getNow(options.now);
  const limits = getCoordinatorWorkflowBudgetLimits(workflow.policy);
  let activeLaneCount = getActiveLaneCount(workflow);
  let committedLaneCount = getCommittedWorkflowLaneCount(workflow);
  let retriesUsed = countCoordinatorWorkflowRetriesUsed(workflow);
  let retryBudgetExhaustedJournaled = workflow.execution?.budget?.retriesExhaustedAt !== undefined;
  for (const lane of workflow.lanes) {
    if (!isLaneRetryEligible(workflow, lane) || hasScheduledRetryLane(workflow, lane)) {
      continue;
    }

    if (activeLaneCount >= workflow.policy.maxConcurrentLanes) {
      continue;
    }
    if (committedLaneCount >= limits.maxTotalLanes) {
      continue;
    }

    const retryReadyAt = getLaneRetryReadyAt(lane, getStageExecutionPolicy(workflow, lane.stageId));
    if (retryReadyAt > now) {
      continue;
    }
    if (retriesUsed >= limits.maxTotalRetries) {
      if (!retryBudgetExhaustedJournaled) {
        journalWorkflowRetryBudgetExhausted(
          workflow,
          lane,
          { limit: limits.maxTotalRetries, used: retriesUsed },
          now,
        );
        retryBudgetExhaustedJournaled = true;
      }
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
    committedLaneCount += 1;
    retriesUsed += 1;
    spawned.push(result);
  }

  return spawned;
}

async function spawnReadyStages(
  options: ReconcileWorkflowOptions,
  workflow: CoordinatorWorkflowSnapshot,
): Promise<WorkflowSpawnedLane[]> {
  const spawned: WorkflowSpawnedLane[] = [];
  for (const stage of workflow.stages) {
    const latestWorkflow = getWorkflowOrThrow(options.runId, options.workflowId);
    const latestStage = latestWorkflow.stages.find((candidate) => candidate.id === stage.id);
    if (!latestStage || !isStageReady(latestWorkflow, latestStage)) {
      continue;
    }

    const lanePayloads = createStageLanePayloads(latestWorkflow, latestStage.id);
    const limits = getCoordinatorWorkflowBudgetLimits(latestWorkflow.policy);
    const committedLaneCountExcludingStage =
      getCommittedWorkflowLaneCount(latestWorkflow) -
      countStepLanes(getStep(latestWorkflow, latestStage.id));
    if (committedLaneCountExcludingStage + lanePayloads.length > limits.maxTotalLanes) {
      tripCoordinatorWorkflowBudget(
        latestWorkflow.runId,
        latestWorkflow.id,
        'lanes',
        {
          limit: limits.maxTotalLanes,
          used: committedLaneCountExcludingStage + lanePayloads.length,
        },
        getNow(options.now),
      );
      break;
    }
    let activeLaneCount = getActiveLaneCount(latestWorkflow);
    if (activeLaneCount + lanePayloads.length > latestWorkflow.policy.maxConcurrentLanes) {
      continue;
    }

    for (const lanePayload of lanePayloads) {
      const currentWorkflow = getWorkflowOrThrow(options.runId, options.workflowId);
      const currentStage = currentWorkflow.stages.find(
        (candidate) => candidate.id === latestStage.id,
      );
      if (
        !currentStage ||
        (currentStage.laneIds.length === 0 && !isStageReady(currentWorkflow, currentStage))
      ) {
        break;
      }

      const result = await options.spawnLane(currentWorkflow, currentStage.id, lanePayload);
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
  if (isCoordinatorTerminalWorkflowStatus(workflow.status)) {
    return workflow;
  }
  if (
    workflow.stages.every(
      (stage) =>
        stage.status === 'completed' ||
        stage.status === 'skipped' ||
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
  // Blocked workflows are terminal (budget trips and decision blocks). Reconciling one again
  // would let completeTerminalStages reinterpret the tripped stage's cancelled lanes and rewrite
  // the typed blocked close-out, so it must stay a no-op.
  if (
    workflow.status === 'stale-after-restore' ||
    workflow.status === 'cancelled' ||
    workflow.status === 'blocked'
  ) {
    return { lanes: spawned, workflow };
  }

  // A paused run stops admitting new work: no retry spawns and no ready-stage spawns, while
  // in-flight lanes still settle through completeTerminalStages/completeWorkflowIfDone.
  const runPaused = !coordinatorRunAdmitsNewWork(getCoordinatorRunStatus(options.runId));
  for (let iteration = 0; iteration < COORDINATOR_LIMITS.maxWorkflowLanes + 2; iteration += 1) {
    const retryLanes = runPaused ? [] : await scheduleLaneRetries(options, workflow);
    spawned.push(...retryLanes);
    workflow = getWorkflowOrThrow(options.runId, options.workflowId);
    const terminalResult = completeTerminalStages(options.runId, options.workflowId);
    workflow = terminalResult.workflow;
    const readyLanes = runPaused ? [] : await spawnReadyStages(options, workflow);
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
  const budgetLimits = getCoordinatorWorkflowBudgetLimits(options.policy);
  if (sourceSpec.steps.length > budgetLimits.maxTotalSteps) {
    throw new BadRequestError(
      `workflow spec creates ${sourceSpec.steps.length} steps, above limit ${budgetLimits.maxTotalSteps}`,
    );
  }
  const totalLaneCount = countCoordinatorWorkflowSpecLanes(sourceSpec.steps);
  if (totalLaneCount > budgetLimits.maxTotalLanes) {
    throw new BadRequestError(
      `workflow spec creates ${totalLaneCount} lanes, above limit ${budgetLimits.maxTotalLanes}`,
    );
  }

  const maxStageLaneCount = sourceSpec.steps.reduce(
    (count, step) => Math.max(count, countStepLanes(step)),
    0,
  );
  const policy = withCoordinatorWorkflowLaneConcurrency(options.policy, maxStageLaneCount);
  const maxConcurrentLanes =
    policy.maxConcurrentLanes ?? COORDINATOR_LIMITS.maxActiveSubtasksPerRun;
  if (maxStageLaneCount > maxConcurrentLanes) {
    throw new BadRequestError('start_workflow exceeds workflow maxConcurrentLanes');
  }

  const now = Date.now();
  const workflow = createCoordinatorWorkflow({
    execution: {
      activeLaneCount: 0,
      deadlineAt: now + budgetLimits.maxWallClockMs,
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

export async function appendCoordinatorWorkflowExecutionSteps(
  options: AppendCoordinatorWorkflowStepsExecutionOptions,
): Promise<AppendCoordinatorWorkflowStepsExecutionResult> {
  const workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  const payloadHash = hashWorkflowAppendPayload(options.steps);
  const existingAppend = workflow.stepAppends?.find(
    (append) => append.appendId === options.appendId,
  );
  if (existingAppend !== undefined) {
    if (existingAppend.payloadHash !== payloadHash) {
      throw new BadRequestError('appendId was already used with different workflow steps');
    }

    return {
      append: existingAppend,
      lanes: [],
      workflow,
    };
  }

  if (
    workflow.status === 'blocked' ||
    workflow.status === 'cancelled' ||
    workflow.status === 'failed' ||
    workflow.status === 'stale-after-restore'
  ) {
    throw new BadRequestError(`Coordinator workflow is ${workflow.status}`);
  }
  if (workflow.sourceSpec === undefined) {
    throw new BadRequestError('append_workflow_steps requires a sourceSpec-backed workflow');
  }
  assertWorkflowStepAppendCapacity(workflow, 'append_workflow_steps');

  let normalizedAppend: CoordinatorWorkflowStepAppendNormalizationResult;
  try {
    normalizedAppend = normalizeCoordinatorWorkflowStepAppend(workflow.sourceSpec, options.steps, {
      limits: getSpecNormalizationLimits(),
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new BadRequestError(error.message);
    }

    throw new BadRequestError('Invalid workflow append steps');
  }
  const appendedSteps = normalizedAppend.appendedSteps;

  assertWorkflowWithinDeadline(workflow, Date.now(), { tripUnlessCompleted: true });
  assertWorkflowBudgetAdmits(workflow, {
    addedLanes: countCoordinatorWorkflowSpecLanes(appendedSteps),
    addedSteps: appendedSteps.length,
    label: 'append_workflow_steps',
  });

  const maxAppendedStageLaneCount = appendedSteps.reduce(
    (count, step) => Math.max(count, countStepLanes(step)),
    0,
  );
  if (maxAppendedStageLaneCount > workflow.policy.maxConcurrentLanes) {
    throw new BadRequestError('append_workflow_steps exceeds workflow maxConcurrentLanes');
  }
  assertAppendedLaneDedupeKeys(workflow, appendedSteps);

  const now = Date.now();
  const append: CoordinatorWorkflowStepAppendSnapshot = {
    appendId: options.appendId,
    createdAt: now,
    payloadHash,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.sourceLaneId !== undefined ? { sourceLaneId: options.sourceLaneId } : {}),
    sourceTaskId: options.sourceTaskId,
    stepIds: appendedSteps.map((step) => step.id),
  };
  appendCoordinatorWorkflowSteps({
    append,
    now,
    runId: options.runId,
    sourceSpec: normalizedAppend.sourceSpec,
    stages: appendedSteps.map((step) => createStageDefinition(workflow.template, step)),
    workflowId: options.workflowId,
  });
  const result = await reconcileCoordinatorWorkflowExecution({
    now,
    runId: options.runId,
    spawnLane: options.spawnLane,
    workflowId: options.workflowId,
  });

  return {
    append,
    lanes: result.lanes,
    workflow: result.workflow,
  };
}

export async function advanceCoordinatorWorkflowExecution(
  options: AdvanceCoordinatorWorkflowExecutionOptions,
): Promise<CoordinatorWorkflowSnapshot> {
  if (
    options.result !== undefined &&
    options.sourceTaskId !== undefined &&
    options.workflowActions !== undefined &&
    options.workflowActions.length > 0
  ) {
    const workflow = await applyDecisionWorkflowActions(options.workflowActions, {
      lane: resolveOwnedWorkflowLane(
        options.runId,
        options.sourceTaskId,
        options.workflowId,
        options.laneId,
        {
          actionName: 'advanceCoordinatorWorkflowExecution',
        },
      ).lane,
      result: options.result,
      runId: options.runId,
      sourceTaskId: options.sourceTaskId,
      spawnLane: options.spawnLane,
      workflowId: options.workflowId,
    });
    if (isCoordinatorTerminalWorkflowStatus(workflow.status)) {
      return workflow;
    }
  }

  const result = await reconcileCoordinatorWorkflowExecution(options);
  return result.workflow;
}

export function recordPendingWorkflowApproval(
  options: RecordPendingWorkflowApprovalOptions,
): CoordinatorWorkflowPendingApprovalSnapshot {
  const now = getNow(options.now);
  const workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  const lane = workflow.lanes.find((candidate) => candidate.id === options.laneId);
  if (!lane) {
    throw new BadRequestError('Coordinator workflow lane not found');
  }

  const approval = addCoordinatorWorkflowPendingApproval({
    actions: options.actions,
    id: `${options.resultId}:approval`,
    laneId: options.laneId,
    now,
    resultId: options.resultId,
    runId: options.runId,
    stageId: options.stageId,
    workflowId: options.workflowId,
  });
  // The decision lane stays open without a resultId while the approval is pending, so stage
  // completion and every join mode keep dependents blocked. Its timeout is cleared because the
  // lane now waits on the operator, not on an agent.
  updateCoordinatorWorkflowLane(options.runId, options.workflowId, options.laneId, {
    now,
    timeoutAt: undefined,
  });
  appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
    at: now,
    kind: 'decision-approval-requested',
    laneId: options.laneId,
    message: `Decision lane ${lane.name} requested approval for ${options.actions.length} workflow action(s).`,
    resultId: options.resultId,
    stageId: options.stageId,
  });
  refreshExecutionSnapshot(options.runId, options.workflowId, now);
  return approval;
}

function requireWorkflowApprovalContext(
  runId: string,
  workflowId: string,
  approvalId: string,
): {
  approval: CoordinatorWorkflowPendingApprovalSnapshot;
  lane: CoordinatorWorkflowSnapshot['lanes'][number];
  result: CoordinatorWorkflowResultSnapshot;
  workflow: CoordinatorWorkflowSnapshot;
} {
  const workflow = getWorkflowOrThrow(runId, workflowId);
  const approval = (workflow.pendingApprovals ?? []).find(
    (candidate) => candidate.id === approvalId,
  );
  if (!approval) {
    throw new BadRequestError('Coordinator workflow approval not found');
  }
  const lane = workflow.lanes.find((candidate) => candidate.id === approval.laneId);
  if (!lane) {
    throw new BadRequestError('Coordinator workflow lane not found');
  }
  const result = workflow.results.find((candidate) => candidate.id === approval.resultId);
  if (!result) {
    throw new BadRequestError('Coordinator workflow result not found');
  }

  return { approval, lane, result, workflow };
}

function assertWorkflowAcceptsOperatorMutation(workflow: CoordinatorWorkflowSnapshot): void {
  if (workflow.status !== 'running' && workflow.status !== 'waiting-for-results') {
    throw new BadRequestError(`Coordinator workflow is ${workflow.status}`);
  }
}

export async function approveCoordinatorWorkflowActions(
  options: ApproveCoordinatorWorkflowActionsOptions,
): Promise<CoordinatorWorkflowApprovalResolutionResult> {
  const now = getNow(options.now);
  const { approval, lane, result, workflow } = requireWorkflowApprovalContext(
    options.runId,
    options.workflowId,
    options.approvalId,
  );
  if (approval.status === 'approved') {
    return { approval, workflow };
  }
  if (approval.status !== 'pending') {
    throw new BadRequestError(`Coordinator workflow approval is ${approval.status}`);
  }
  assertWorkflowAcceptsOperatorMutation(workflow);
  // Budgets and caps may have changed since the approval was requested, so the stored actions are
  // re-validated against the current graph before any state changes. A failed re-validation
  // leaves the approval pending; deny stays the operator escape hatch.
  validateWorkflowDecisionActionsForResult(workflow, lane, approval.resultId, approval.actions);

  updateCoordinatorWorkflowLane(options.runId, options.workflowId, lane.id, {
    completedAt: now,
    now,
    resultId: result.id,
    status: getWorkflowLaneStatusForResultStatus(result.status),
  });
  const resolved = resolveCoordinatorWorkflowPendingApproval(
    options.runId,
    options.workflowId,
    approval.id,
    'approved',
    { now },
  );
  appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
    at: now,
    kind: 'decision-approval-approved',
    laneId: lane.id,
    message: `Approved ${approval.actions.length} workflow action(s) from lane ${lane.name}.`,
    resultId: result.id,
    stageId: lane.stageId,
  });
  const applied = await applyDecisionWorkflowActions(approval.actions, {
    lane,
    result,
    runId: options.runId,
    sourceTaskId: result.taskId,
    spawnLane: options.spawnLane,
    workflowId: options.workflowId,
  });
  if (isCoordinatorTerminalWorkflowStatus(applied.status)) {
    return { approval: resolved, workflow: applied };
  }

  const reconciled = await reconcileCoordinatorWorkflowExecution({
    now,
    runId: options.runId,
    spawnLane: options.spawnLane,
    workflowId: options.workflowId,
  });
  return { approval: resolved, workflow: reconciled.workflow };
}

export async function denyCoordinatorWorkflowActions(
  options: DenyCoordinatorWorkflowActionsOptions,
): Promise<CoordinatorWorkflowApprovalResolutionResult> {
  const now = getNow(options.now);
  const { approval, lane, result, workflow } = requireWorkflowApprovalContext(
    options.runId,
    options.workflowId,
    options.approvalId,
  );
  if (approval.status === 'denied') {
    return { approval, workflow };
  }
  if (approval.status !== 'pending') {
    throw new BadRequestError(`Coordinator workflow approval is ${approval.status}`);
  }
  assertWorkflowAcceptsOperatorMutation(workflow);

  updateCoordinatorWorkflowLane(options.runId, options.workflowId, lane.id, {
    completedAt: now,
    now,
    resultId: result.id,
    status: getWorkflowLaneStatusForResultStatus(result.status),
  });
  const resolved = resolveCoordinatorWorkflowPendingApproval(
    options.runId,
    options.workflowId,
    approval.id,
    'denied',
    { now, ...(options.reason !== undefined ? { reason: options.reason } : {}) },
  );
  appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
    at: now,
    kind: 'decision-approval-denied',
    laneId: lane.id,
    message:
      options.reason !== undefined
        ? `Denied workflow action(s) from lane ${lane.name}: ${options.reason}`
        : `Denied workflow action(s) from lane ${lane.name}.`,
    resultId: result.id,
    stageId: lane.stageId,
  });
  const reconciled = await reconcileCoordinatorWorkflowExecution({
    now,
    runId: options.runId,
    spawnLane: options.spawnLane,
    workflowId: options.workflowId,
  });
  return { approval: resolved, workflow: reconciled.workflow };
}

export async function retryCoordinatorWorkflowLaneFromOperator(
  options: RetryCoordinatorWorkflowLaneFromOperatorOptions,
): Promise<{ lane: WorkflowSpawnedLane; workflow: CoordinatorWorkflowSnapshot }> {
  const now = getNow(options.now);
  const workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  assertWorkflowAcceptsOperatorMutation(workflow);
  const lane = workflow.lanes.find((candidate) => candidate.id === options.laneId);
  if (!lane) {
    throw new BadRequestError('Coordinator workflow lane not found');
  }
  if ((lane.status !== 'failed' && lane.status !== 'timed-out') || lane.resultId !== undefined) {
    throw new BadRequestError(
      'retry_lane requires a failed or timed-out lane without a terminal result',
    );
  }
  if (hasScheduledRetryLane(workflow, lane)) {
    throw new BadRequestError('Lane retry was already scheduled');
  }
  // Manual retry is exempt from the auto-retry budget and per-stage retryCount, but it stays
  // inside the same effective lane caps as every other admission site.
  const limits = getCoordinatorWorkflowBudgetLimits(workflow.policy);
  const committedLaneCount = getCommittedWorkflowLaneCount(workflow);
  if (committedLaneCount >= limits.maxTotalLanes) {
    throw new BadRequestError(
      formatCoordinatorWorkflowBudgetExhaustedReason('lanes', {
        limit: limits.maxTotalLanes,
        used: committedLaneCount,
      }),
    );
  }
  if (getActiveLaneCount(workflow) >= workflow.policy.maxConcurrentLanes) {
    throw new BadRequestError('Workflow maxConcurrentLanes reached.');
  }

  appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
    at: now,
    kind: 'lane-manual-retry',
    laneId: lane.id,
    message: `Operator retried lane ${lane.name}, attempt ${lane.attempt + 1}.`,
    stageId: lane.stageId,
  });
  const spawned = await options.spawnLane(workflow, lane.stageId, {
    ...findRetryPayload(workflow, lane),
    spawnedBy: 'operator',
  });
  const reconciled = await reconcileCoordinatorWorkflowExecution({
    now,
    runId: options.runId,
    spawnLane: options.spawnLane,
    workflowId: options.workflowId,
  });
  return { lane: spawned, workflow: reconciled.workflow };
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

function refreshWorkflowExecutionClocksOnResume(
  workflow: CoordinatorWorkflowSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
  now: number,
): { timeoutAt: number } {
  return { timeoutAt: now + getStageExecutionPolicy(workflow, lane.stageId).timeoutMs };
}

function refreshWorkflowExecutionDeadlineOnResume(
  workflow: CoordinatorWorkflowSnapshot,
  now: number,
): number {
  const deadlineAt = workflow.execution?.deadlineAt;
  if (deadlineAt === undefined) {
    return now + getCoordinatorWorkflowBudgetLimits(workflow.policy).maxWallClockMs;
  }

  return deadlineAt + Math.max(0, now - workflow.updatedAt);
}

function getLaneResumeReplacementDedupeKey(
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
): string {
  return `${lane.dedupeKey ?? lane.id}:resume:${lane.attempt + 1}`;
}

function findResumeReplacementPayload(
  workflow: CoordinatorWorkflowSnapshot,
  lane: CoordinatorWorkflowSnapshot['lanes'][number],
): CoordinatorSpawnManyLanePayload {
  const basePayload = createStageLanePayloads(workflow, lane.stageId).find(
    (payload) => payload.name === lane.name && payload.role === lane.role,
  );
  return {
    agent: basePayload?.agent ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
    assignment: lane.assignment,
    attempt: lane.attempt + 1,
    dedupeKey: getLaneResumeReplacementDedupeKey(lane),
    name: lane.name,
    ...(lane.role !== undefined ? { role: lane.role } : {}),
    spawnedBy: 'resume',
  };
}

export async function resumeCoordinatorWorkflowExecution(
  options: ResumeCoordinatorWorkflowExecutionOptions,
): Promise<ResumeCoordinatorWorkflowExecutionResult> {
  const now = getNow(options.now);
  let workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  if (workflow.status !== 'stale-after-restore') {
    throw new BadRequestError(`Coordinator workflow is ${workflow.status}`);
  }

  updateCoordinatorWorkflow(options.runId, options.workflowId, {
    ...(workflow.execution !== undefined
      ? {
          execution: {
            ...workflow.execution,
            deadlineAt: refreshWorkflowExecutionDeadlineOnResume(workflow, now),
          },
        }
      : {}),
    now,
    status: 'running',
  });
  appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
    at: now,
    kind: 'workflow-resumed',
    message: 'Resumed workflow after server restart.',
  });

  const failed: ResumeCoordinatorWorkflowExecutionResult['failed'] = [];
  const respawned: string[] = [];
  const replacementLanes: Array<CoordinatorWorkflowSnapshot['lanes'][number]> = [];
  const recordLaneRespawnFailure = (
    lane: CoordinatorWorkflowSnapshot['lanes'][number],
    reason: string,
  ): void => {
    updateCoordinatorWorkflowLane(options.runId, options.workflowId, lane.id, {
      completedAt: now,
      failure: reason,
      now,
      status: 'failed',
    });
    appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
      at: now,
      kind: 'lane-respawn-failed',
      laneId: lane.id,
      message: reason,
      stageId: lane.stageId,
    });
  };
  workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  for (const lane of workflow.lanes) {
    if (lane.status !== 'stale-after-restore') {
      continue;
    }

    if (lane.resultId !== undefined) {
      updateCoordinatorWorkflowLane(options.runId, options.workflowId, lane.id, {
        ...(lane.completedAt === undefined ? { completedAt: now } : {}),
        failure: undefined,
        now,
        status: 'completed',
      });
      continue;
    }
    const restoreCancelledApproval = (workflow.pendingApprovals ?? []).find(
      (approval) =>
        approval.laneId === lane.id &&
        workflow.results.some((candidate) => candidate.id === approval.resultId),
    );
    if (restoreCancelledApproval !== undefined) {
      // The decision lane already submitted its gated result before the restart; its pending
      // approval was cancelled by restore. Resume must never replay the gated actions as a
      // cached fact or silently discard them, so the lane re-enters its awaiting state with a
      // re-recorded pending approval for the operator to resolve.
      const approvalCountForResult = (workflow.pendingApprovals ?? []).filter(
        (candidate) => candidate.resultId === restoreCancelledApproval.resultId,
      ).length;
      addCoordinatorWorkflowPendingApproval({
        actions: restoreCancelledApproval.actions,
        id: `${restoreCancelledApproval.resultId}:approval:${approvalCountForResult + 1}`,
        laneId: lane.id,
        now,
        resultId: restoreCancelledApproval.resultId,
        runId: options.runId,
        stageId: lane.stageId,
        workflowId: options.workflowId,
      });
      updateCoordinatorWorkflowLane(options.runId, options.workflowId, lane.id, {
        failure: undefined,
        now,
        status: 'waiting-for-result',
        timeoutAt: undefined,
      });
      appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
        at: now,
        kind: 'decision-approval-requested',
        laneId: lane.id,
        message: `Re-recorded pending approval for lane ${lane.name} after restore.`,
        resultId: restoreCancelledApproval.resultId,
        stageId: lane.stageId,
      });
      continue;
    }
    if (lane.taskId !== undefined) {
      try {
        const currentWorkflow = getWorkflowOrThrow(options.runId, options.workflowId);
        const spawnedLane = await options.respawnLane(currentWorkflow, lane);
        if (spawnedLane.error !== undefined) {
          throw new Error(spawnedLane.error);
        }
        updateCoordinatorWorkflowLane(options.runId, options.workflowId, lane.id, {
          failure: undefined,
          now,
          status: 'waiting-for-result',
          ...refreshWorkflowExecutionClocksOnResume(currentWorkflow, lane, now),
        });
        appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
          at: now,
          kind: 'lane-respawned',
          laneId: lane.id,
          message: `Respawned lane ${lane.name} after server restart.`,
          stageId: lane.stageId,
        });
        respawned.push(lane.taskId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordLaneRespawnFailure(lane, reason);
        failed.push({ laneId: lane.id, reason, taskId: lane.taskId });
      }
      continue;
    }

    replacementLanes.push(lane);
  }

  workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  for (const stage of workflow.stages) {
    if (stage.status !== 'stale-after-restore') {
      continue;
    }

    updateCoordinatorWorkflowStage(options.runId, options.workflowId, stage.id, {
      failure: undefined,
      now,
      status: stage.laneIds.length === 0 ? 'pending' : 'waiting-for-results',
    });
  }

  for (const lane of replacementLanes) {
    const currentWorkflow = getWorkflowOrThrow(options.runId, options.workflowId);
    const limits = getCoordinatorWorkflowBudgetLimits(currentWorkflow.policy);
    if (getCommittedWorkflowLaneCount(currentWorkflow) >= limits.maxTotalLanes) {
      const reason = `Workflow lane limit ${limits.maxTotalLanes} reached.`;
      recordLaneRespawnFailure(lane, reason);
      failed.push({ laneId: lane.id, reason });
      continue;
    }
    if (getActiveLaneCount(currentWorkflow) >= currentWorkflow.policy.maxConcurrentLanes) {
      const reason = 'Workflow maxConcurrentLanes reached.';
      recordLaneRespawnFailure(lane, reason);
      failed.push({ laneId: lane.id, reason });
      continue;
    }

    const replacement = await options.spawnLane(
      currentWorkflow,
      lane.stageId,
      findResumeReplacementPayload(currentWorkflow, lane),
    );
    if (replacement.error !== undefined) {
      recordLaneRespawnFailure(lane, replacement.error);
      failed.push({
        laneId: replacement.laneId,
        reason: replacement.error,
        ...(replacement.subtask !== undefined ? { taskId: replacement.subtask.taskId } : {}),
      });
      continue;
    }

    updateCoordinatorWorkflowLane(options.runId, options.workflowId, lane.id, {
      completedAt: now,
      failure: 'Lane was never spawned before the server restarted.',
      now,
      status: 'cancelled',
      supersededByLaneId: replacement.laneId,
    });
    appendCoordinatorWorkflowJournal(options.runId, options.workflowId, {
      at: now,
      kind: 'lane-cancelled',
      laneId: lane.id,
      message: `Cancelled never-spawned lane ${lane.name} during resume.`,
      stageId: lane.stageId,
    });
    if (replacement.subtask !== undefined) {
      respawned.push(replacement.subtask.taskId);
    }
  }

  const reconciled = await reconcileCoordinatorWorkflowExecution({
    now,
    runId: options.runId,
    spawnLane: options.spawnLane,
    workflowId: options.workflowId,
  });

  return {
    failed,
    respawned,
    workflow: reconciled.workflow,
  };
}

export async function tickCoordinatorWorkflowExecution(
  options: TickCoordinatorWorkflowExecutionOptions,
): Promise<CoordinatorWorkflowSnapshot> {
  const now = getNow(options.now);
  let workflow = getWorkflowOrThrow(options.runId, options.workflowId);
  if (
    !isCoordinatorTerminalWorkflowStatus(workflow.status) &&
    isWorkflowPastDeadline(workflow, now)
  ) {
    return tripCoordinatorWorkflowBudget(
      options.runId,
      options.workflowId,
      'wall-clock',
      getWorkflowWallClockExhaustedUsage(workflow),
      now,
    );
  }

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
  workflow: CoordinatorWorkflowSchedulingProjection,
  now = Date.now(),
): number | null {
  if (isCoordinatorTerminalWorkflowStatus(workflow.status)) {
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
  // Retry admission is deferred while the run is paused, so retry wake-ups are skipped; lane
  // timeout and wall-clock deadline ticks stay alive by design.
  const runPaused = !coordinatorRunAdmitsNewWork(getCoordinatorRunStatus(workflow.runId));
  if (!runPaused && activeLaneCount < workflow.policy.maxConcurrentLanes) {
    const pendingRetryLaneIds = new Set(retryState.pendingLaneIds);
    for (const lane of workflow.lanes) {
      if (!pendingRetryLaneIds.has(lane.id)) {
        continue;
      }
      retryTimes.push(getLaneRetryReadyAt(lane, getStageExecutionPolicy(workflow, lane.stageId)));
    }
  }
  const tickTimes = [...activeTimeouts, ...retryTimes];
  if (workflow.execution?.deadlineAt !== undefined) {
    tickTimes.push(workflow.execution.deadlineAt);
  }
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
  const now = Date.now();
  cancelCoordinatorWorkflowPendingApprovals(runId, workflowId, { now, reason });
  const workflow = getWorkflowOrThrow(runId, workflowId);
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

export function resolveOwnedWorkflowLane(
  runId: string,
  taskId: string,
  workflowId: string | undefined,
  laneId: string | undefined,
  options: ResolveOwnedWorkflowLaneOptions,
): {
  lane: CoordinatorWorkflowSnapshot['lanes'][number];
  workflow: CoordinatorOwnedLaneWorkflowProjection;
} {
  const workflows = getCoordinatorOwnedLaneWorkflowCandidates(runId, workflowId);
  if (workflows === null) {
    throw new BadRequestError('Coordinator run is no longer active');
  }
  let match:
    | {
        lane: CoordinatorWorkflowSnapshot['lanes'][number];
        workflow: CoordinatorOwnedLaneWorkflowProjection;
      }
    | undefined;

  for (const workflow of workflows) {
    let lane: CoordinatorWorkflowSnapshot['lanes'][number] | undefined;
    if (laneId !== undefined) {
      lane = workflow.lanes.find((candidate) => candidate.id === laneId);
      if (!lane) {
        continue;
      }
      if (lane.taskId !== taskId) {
        throw new BadRequestError('laneId must belong to the calling subtask');
      }
    } else {
      lane = getLaneByTask(workflow, taskId);
      if (!lane) {
        continue;
      }
    }

    if (match !== undefined) {
      throw new BadRequestError(
        `${options.actionName} is ambiguous; provide workflowId and laneId`,
      );
    }
    match = { lane, workflow };
  }

  if (match === undefined) {
    throw new BadRequestError(
      `${options.actionName} could not resolve a workflow lane for this subtask`,
    );
  }
  if (
    options.requireActiveLane === true &&
    (match.lane.resultId !== undefined ||
      isCoordinatorTerminalWorkflowLaneStatus(match.lane.status))
  ) {
    throw new BadRequestError(
      `${options.actionName} requires an active workflow lane without a terminal result`,
    );
  }

  return match;
}
