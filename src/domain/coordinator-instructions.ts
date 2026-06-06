export interface CoordinatorInstructionOptions {
  toolCommand?: string;
}

function trimUserText(text: string | undefined): string {
  return text?.trim() ?? '';
}

function getToolInvocationText(options: CoordinatorInstructionOptions = {}): string {
  if (options.toolCommand) {
    return `Run coordinator tools with ${options.toolCommand} <tool-name> '<payload-json>'.`;
  }

  return "Run coordinator tools with $PARALLEL_CODE_COORDINATOR_TOOL <tool-name> '<payload-json>'.";
}

export function buildCoordinatorInitialPrompt(
  userPrompt: string | undefined,
  options: CoordinatorInstructionOptions = {},
): string {
  const taskText = trimUserText(userPrompt);
  const lines = [
    'You are the coordinator for this Parallel Code task.',
    '',
    getToolInvocationText(options),
    '',
    'Use spawn_subtask to create focused Codex or terminal subtasks.',
    'Use start_workflow for backend-owned map-reduce, adversarial review, or custom DAG workflows.',
    'Use append_workflow_steps only to append validated follow-up steps to an existing source-spec-backed workflow.',
    'Use decision workflow stages when one lane should choose the next append-only steps instead of hard-coding the whole plan up front.',
    'Use close_task to explicitly clean up and discard subtasks when they are no longer needed.',
    'Use list_tasks, get_task_status, wait_for_idle, get_task_output, and get_task_diff to inspect work before asking for changes.',
    'Use send_prompt only for follow-up instructions. Codex subtasks usually start with the assignment already seeded at spawn.',
    'Do not send overlapping prompt writes to the same subtask.',
    'Ask subtasks to call signal_done when their work is ready, and land_self when they should merge themselves.',
    'Keep destructive cleanup explicit. Do not merge or close work until the result and verification are clear.',
  ];

  if (taskText.length > 0) {
    lines.push('', 'User task:', taskText);
  }

  return lines.join('\n');
}

export function buildCoordinatorSubtaskAssignment(
  assignment: string,
  options: CoordinatorInstructionOptions = {},
): string {
  return [
    'You are a subtask agent spawned by a Parallel Code coordinator.',
    '',
    getToolInvocationText(options),
    '',
    'Work only on the assignment below unless the coordinator sends a follow-up prompt.',
    'If this assignment belongs to a workflow, call submit_result with summary, findings, evidence, commandsRun, risks, status, and confidence when finished.',
    'If your workflow lane needs more stages, call append_workflow_steps with a stable appendId and append-only steps before submitting your result.',
    'If this is a decision lane, prefer metadata.workflowActions on submit_result for append_worker, append_fanout, append_verify, append_synthesize, mark_blocked, or stop_workflow.',
    'When the work is ready for review, call signal_done with a concise result summary.',
    'If the coordinator asks you to land your work, call land_self with a summary and verification list.',
    'If you are blocked, report the blocker clearly instead of guessing.',
    '',
    'Assignment:',
    assignment.trim(),
  ].join('\n');
}
