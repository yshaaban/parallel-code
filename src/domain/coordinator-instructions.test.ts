import { describe, expect, it } from 'vitest';
import {
  buildCoordinatorInitialPrompt,
  buildCoordinatorSubtaskAssignment,
} from './coordinator-instructions';

describe('coordinator instructions', () => {
  it('preserves the user task while injecting the provided tool command', () => {
    const prompt = buildCoordinatorInitialPrompt('Investigate latency', {
      toolCommand: 'parallel-code-coordinator',
    });

    expect(prompt).toContain('You are the coordinator for this Parallel Code task.');
    expect(prompt).toContain(
      "Run coordinator tools with parallel-code-coordinator <tool-name> '<payload-json>'.",
    );
    expect(prompt).toContain(
      'Use close_task to explicitly clean up and discard subtasks when they are no longer needed.',
    );
    expect(prompt).toContain('Use start_workflow for backend-owned map-reduce');
    expect(prompt).toContain('Use append_workflow_steps only to append validated follow-up steps');
    expect(prompt).toContain(
      'Use decision workflow stages when one lane should choose the next append-only steps',
    );
    expect(prompt).toContain(
      'Use send_prompt only for follow-up instructions. Codex subtasks usually start with the assignment already seeded at spawn.',
    );
    expect(prompt).toContain('User task:\nInvestigate latency');
  });

  it('falls back to the environment tool command when no direct helper is provided', () => {
    const prompt = buildCoordinatorSubtaskAssignment('Build the parser');

    expect(prompt).toContain(
      "Run coordinator tools with $PARALLEL_CODE_COORDINATOR_TOOL <tool-name> '<payload-json>'.",
    );
    expect(prompt).toContain('call submit_result with summary, findings, evidence');
    expect(prompt).toContain('call append_workflow_steps with a stable appendId');
    expect(prompt).toContain('metadata.workflowActions on submit_result');
    expect(prompt).toContain('Assignment:\nBuild the parser');
  });
});
