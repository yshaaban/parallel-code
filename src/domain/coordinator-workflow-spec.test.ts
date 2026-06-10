import { describe, expect, it } from 'vitest';

import {
  normalizeCoordinatorWorkflowDynamicActions,
  normalizeCoordinatorWorkflowSpec,
  normalizeCoordinatorWorkflowStepAppend,
  type CoordinatorWorkflowSpecValidationLimits,
} from './coordinator-workflow-spec';

const limits: CoordinatorWorkflowSpecValidationLimits = {
  assignmentTextMaxChars: 16_000,
  maxWorkflowBranchIterations: 8,
  maxWorkflowLanes: 12,
  maxWorkflowMetadataBytes: 16 * 1024,
  maxWorkflowShortTextChars: 512,
  workflowMaxLaneTimeoutMs: 24 * 60 * 60 * 1000,
};

describe('coordinator workflow spec validation', () => {
  it('normalizes a fanout verify synthesize DAG', () => {
    const spec = normalizeCoordinatorWorkflowSpec(
      {
        steps: [
          {
            id: 'find',
            kind: 'fanout',
            lanes: [
              { assignment: 'Find backend issues.', id: 'backend', name: 'Backend' },
              { assignment: 'Find UI issues.', id: 'ui', name: 'UI' },
            ],
          },
          {
            dependsOn: ['find'],
            findingSourceStepId: 'find',
            id: 'verify',
            kind: 'verify',
            verifiers: [{ id: 'skeptic', name: 'Skeptic' }],
          },
          {
            dependsOn: ['verify'],
            id: 'synthesize',
            kind: 'synthesize',
            sourceStepIds: ['find', 'verify'],
          },
        ],
      },
      { limits },
    );

    expect(spec).toMatchObject({
      steps: [
        expect.objectContaining({
          id: 'find',
          lanes: expect.arrayContaining([expect.any(Object)]),
        }),
        expect.objectContaining({
          findingSourceStepId: 'find',
          id: 'verify',
          verifiers: [expect.objectContaining({ id: 'skeptic' })],
        }),
        expect.objectContaining({ dependsOn: ['verify'], id: 'synthesize' }),
      ],
      version: 2,
    });
  });

  it('rejects duplicate step ids', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            { id: 'find', kind: 'worker' },
            { id: 'find', kind: 'worker' },
          ],
        },
        { limits },
      ),
    ).toThrow('duplicate id find');
  });

  it('rejects missing dependencies and dependency cycles', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [{ dependsOn: ['missing'], id: 'find', kind: 'worker' }],
        },
        { limits },
      ),
    ).toThrow('missing step missing');

    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            { dependsOn: ['b'], id: 'a', kind: 'worker' },
            { dependsOn: ['a'], id: 'b', kind: 'worker' },
          ],
        },
        { limits },
      ),
    ).toThrow('dependency cycle');
  });

  it('rejects source references that are outside the dependency ancestry', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            { id: 'scan', kind: 'worker' },
            {
              id: 'decide',
              kind: 'decision',
              sourceStepIds: ['scan'],
            },
          ],
        },
        { limits },
      ),
    ).toThrow('step decide must depend on source step scan');

    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            { id: 'scan', kind: 'worker' },
            {
              id: 'verify',
              kind: 'verify',
              resultSourceStepIds: ['scan'],
              verifiers: [{ id: 'skeptic', name: 'Skeptic' }],
            },
          ],
        },
        { limits },
      ),
    ).toThrow('step verify must depend on result source step scan');
  });

  it('rejects verify steps with impossible minimum verifier thresholds', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            { id: 'scan', kind: 'worker' },
            {
              dependsOn: ['scan'],
              findingSourceStepId: 'scan',
              id: 'verify',
              kind: 'verify',
              minimumVerifierCount: 2,
              policy: {
                joinMode: 'first-success',
              },
              verifiers: [
                { id: 'skeptic', name: 'Skeptic' },
                { id: 'archivist', name: 'Archivist' },
              ],
            },
          ],
        },
        { limits },
      ),
    ).toThrow(
      'step verify.minimumVerifierCount must be 1 when step verify.joinMode is first-success',
    );

    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            { id: 'scan', kind: 'worker' },
            {
              dependsOn: ['scan'],
              findingSourceStepId: 'scan',
              id: 'verify',
              kind: 'verify',
              minimumVerifierCount: 2,
              policy: {
                joinMode: 'quorum',
                quorumCount: 1,
              },
              verifiers: [
                { id: 'skeptic', name: 'Skeptic' },
                { id: 'archivist', name: 'Archivist' },
              ],
            },
          ],
        },
        { limits },
      ),
    ).toThrow('step verify.minimumVerifierCount must be no greater than step verify.quorumCount');
  });

  it('rejects over-cap fanout before execution', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            {
              id: 'find',
              kind: 'fanout',
              lanes: Array.from({ length: limits.maxWorkflowLanes + 1 }, (_, index) => ({
                assignment: `Lane ${index}`,
                id: `lane-${index}`,
                name: `Lane ${index}`,
              })),
            },
          ],
        },
        { limits },
      ),
    ).toThrow(`above limit ${limits.maxWorkflowLanes}`);
  });

  it('counts implicit worker and synthesis lanes toward the workflow cap', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: Array.from({ length: limits.maxWorkflowLanes + 1 }, (_, index) => ({
            dependsOn: index === 0 ? [] : [`step-${index - 1}`],
            id: `step-${index}`,
            kind: index % 2 === 0 ? 'worker' : 'synthesize',
          })),
        },
        { limits },
      ),
    ).toThrow(`above limit ${limits.maxWorkflowLanes}`);
  });

  it('normalizes decision steps with one implicit lane', () => {
    const spec = normalizeCoordinatorWorkflowSpec(
      {
        steps: [
          { id: 'find', kind: 'worker' },
          {
            dependsOn: ['find'],
            id: 'decide',
            includeVerdicts: true,
            kind: 'decision',
            sourceStepIds: ['find'],
          },
        ],
      },
      { limits },
    );

    expect(spec.steps[1]).toMatchObject({
      dependsOn: ['find'],
      id: 'decide',
      kind: 'decision',
      sourceStepIds: ['find'],
    });
  });

  it('normalizes stage join policy for quorum fan-in workflows', () => {
    const spec = normalizeCoordinatorWorkflowSpec(
      {
        steps: [
          {
            id: 'scan',
            kind: 'fanout',
            lanes: [
              { assignment: 'Scan backend.', id: 'backend', name: 'Backend' },
              { assignment: 'Scan UI.', id: 'ui', name: 'UI' },
              { assignment: 'Scan docs.', id: 'docs', name: 'Docs' },
            ],
            policy: {
              joinMode: 'quorum',
              quorumCount: 2,
            },
          },
          {
            dependsOn: ['scan'],
            id: 'synthesize',
            kind: 'synthesize',
            sourceStepIds: ['scan'],
          },
        ],
      },
      { limits },
    );

    expect(spec.steps[0]).toMatchObject({
      id: 'scan',
      policy: {
        joinMode: 'quorum',
        quorumCount: 2,
      },
    });
  });

  it('rejects malformed agents and non-object inputs', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            {
              agent: { command: 123 },
              id: 'worker',
              kind: 'worker',
            },
          ],
        },
        { limits },
      ),
    ).toThrow('steps[0].agent.command must be a string');

    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          inputs: ['not-a-record'],
          steps: [{ id: 'worker', kind: 'worker' }],
        },
        { limits },
      ),
    ).toThrow('spec.inputs must be an object');
  });

  it('rejects unsupported noninteractive startup modes in workflow agents', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            {
              agent: {
                command: 'codex',
                initialAssignmentMode: 'spawn-seeded-noninteractive',
              },
              id: 'worker',
              kind: 'worker',
            },
          ],
        },
        { limits },
      ),
    ).toThrow(
      'steps[0].agent.initialAssignmentMode must be spawn-seeded-interactive or post-ready-prompt',
    );
  });

  it('normalizes appended steps against the whole workflow graph', () => {
    const initial = normalizeCoordinatorWorkflowSpec(
      {
        steps: [{ id: 'scout', kind: 'worker' }],
      },
      { limits },
    );

    const append = normalizeCoordinatorWorkflowStepAppend(
      initial,
      [
        {
          dependsOn: ['scout'],
          id: 'followup',
          kind: 'fanout',
          lanes: [{ assignment: 'Follow up.', id: 'lane-a', name: 'Lane A' }],
        },
      ],
      { limits },
    );

    expect(append.appendedSteps.map((step) => step.id)).toEqual(['followup']);
    expect(append.sourceSpec.steps.map((step) => step.id)).toEqual(['scout', 'followup']);
    expect(initial.steps.map((step) => step.id)).toEqual(['scout']);
  });

  it('rejects appended steps that break existing graph invariants', () => {
    const initial = normalizeCoordinatorWorkflowSpec(
      {
        steps: [{ id: 'scout', kind: 'worker' }],
      },
      { limits },
    );

    expect(() =>
      normalizeCoordinatorWorkflowStepAppend(
        initial,
        [{ dependsOn: ['missing'], id: 'followup', kind: 'worker' }],
        { limits },
      ),
    ).toThrow('missing step missing');

    expect(() =>
      normalizeCoordinatorWorkflowStepAppend(
        initial,
        [{ dependsOn: ['cycle'], id: 'cycle', kind: 'worker' }],
        { limits },
      ),
    ).toThrow('dependency cycle');
  });

  it('rejects duplicate explicit lane dedupe keys across planned workflow lanes', () => {
    expect(() =>
      normalizeCoordinatorWorkflowSpec(
        {
          steps: [
            {
              id: 'find',
              kind: 'fanout',
              lanes: [
                { dedupeKey: 'stable-lane', id: 'backend', name: 'Backend' },
                { dedupeKey: 'stable-lane', id: 'ui', name: 'UI' },
              ],
            },
          ],
        },
        { limits },
      ),
    ).toThrow('workflow spec reuses lane dedupeKey stable-lane');
  });

  it('normalizes structured workflow actions into append steps and terminal actions', () => {
    const actions = normalizeCoordinatorWorkflowDynamicActions(
      [
        {
          id: 'followup',
          kind: 'append_worker',
          name: 'Followup',
        },
      ],
      { limits },
    );

    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'append_worker',
        step: expect.objectContaining({
          id: 'followup',
          kind: 'worker',
          name: 'Followup',
        }),
      }),
    ]);

    expect(() =>
      normalizeCoordinatorWorkflowDynamicActions(
        [
          {
            kind: 'append_worker',
            name: 'Followup',
          },
        ],
        { limits },
      ),
    ).toThrow('workflowActions[0].step.id is required');

    expect(() =>
      normalizeCoordinatorWorkflowDynamicActions(
        [
          { kind: 'append_worker', id: 'followup', name: 'Followup' },
          { kind: 'mark_blocked', reason: 'Need approval' },
        ],
        { limits },
      ),
    ).toThrow('terminal workflowActions cannot be combined with append actions');

    expect(() =>
      normalizeCoordinatorWorkflowDynamicActions(
        [
          { actionId: 'stable-action', id: 'followup', kind: 'append_worker', name: 'Followup' },
          {
            actionId: 'stable-action',
            id: 'summary',
            kind: 'append_synthesize',
            name: 'Summary',
          },
        ],
        { limits },
      ),
    ).toThrow('workflowActions reuse actionId stable-action');
  });

  it('normalizes append_branch_bundle workflow actions', () => {
    const actions = normalizeCoordinatorWorkflowDynamicActions(
      [
        {
          branchKey: 'high-risk-followup',
          bundleId: 'deep-dive',
          kind: 'append_branch_bundle',
          lanes: [
            { assignment: 'Deep dive backend queue handling.', id: 'backend', name: 'Backend' },
            { assignment: 'Deep dive UI blockers.', id: 'ui', name: 'UI' },
          ],
          maxIterations: 2,
          name: 'Deep dive',
          reduce: {
            includeFindings: true,
            name: 'Reduce',
            prompt: 'Summarize the focused follow-up work.',
          },
          verify: {
            joinMode: 'quorum',
            quorumCount: 1,
            verifiers: [
              { id: 'skeptic', name: 'Skeptic' },
              { id: 'archivist', name: 'Archivist' },
            ],
          },
        },
      ],
      { limits },
    );

    expect(actions).toMatchObject([
      {
        branchKey: 'high-risk-followup',
        bundleId: 'deep-dive',
        kind: 'append_branch_bundle',
        lanes: expect.arrayContaining([expect.objectContaining({ id: 'backend' })]),
        maxIterations: 2,
        reduce: expect.objectContaining({ name: 'Reduce' }),
        verify: expect.objectContaining({
          joinMode: 'quorum',
          quorumCount: 1,
          verifiers: expect.arrayContaining([expect.objectContaining({ id: 'skeptic' })]),
        }),
      },
    ]);
  });

  it('rejects append_branch_bundle verifier thresholds that cannot satisfy their join policy', () => {
    expect(() =>
      normalizeCoordinatorWorkflowDynamicActions(
        [
          {
            bundleId: 'deep-dive',
            kind: 'append_branch_bundle',
            lanes: [
              { assignment: 'Deep dive backend queue handling.', id: 'backend', name: 'Backend' },
            ],
            verify: {
              joinMode: 'quorum',
              minimumVerifierCount: 2,
              quorumCount: 1,
              verifiers: [
                { id: 'skeptic', name: 'Skeptic' },
                { id: 'archivist', name: 'Archivist' },
              ],
            },
          },
        ],
        { limits },
      ),
    ).toThrow(
      'workflowActions[0].verify.minimumVerifierCount must be no greater than workflowActions[0].verify.quorumCount',
    );
  });
});
