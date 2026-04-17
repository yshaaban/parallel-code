import { IPC } from '../../electron/ipc/channels';
import type { TaskStepEntry, TaskStepsSnapshot } from '../domain/task-steps';
import { invoke } from '../lib/ipc';
import { clearPrefillPrompt, setPrefillPrompt } from '../store/tasks';
import { setTaskFocusedPanel } from '../store/focus';
import { store } from '../store/state';
import { setTaskStepsSnapshot } from '../store/task-steps';

export const TASK_STEPS_INSTRUCTION =
  'IMPORTANT: Maintain .claude/steps.json throughout this task. ' +
  'Append a new entry whenever the task meaningfully changes phase, reaches a blocker, delegates work, or becomes ready for review. ' +
  'Use this exact array-of-objects shape: ' +
  '[{"summary":"short outcome","status":"implementing","next":"what happens next","detail":"optional one-sentence context","files_touched":["relative/path.ts"],"agent_id":"optional-sub-agent-label","timestamp":"host-stamped"}]. ' +
  'Valid status values are starting, investigating, implementing, testing, awaiting_review, and done. ' +
  'Keep summary outcome-oriented, keep next actionable, and only include files_touched for files you actually modified. ' +
  'When delegated work is involved, use the same short agent_id consistently across that agent’s entries. ' +
  'When you need user review or a decision, append an awaiting_review entry, set next to the exact action you need, and pause.';

function shouldInjectTaskStepsInstruction(taskId: string): boolean {
  const task = store.tasks[taskId];
  return task?.stepsTracking === true && task.lastPrompt.trim().length === 0;
}

export function buildTaskStepsPrompt(text: string): string {
  return `${text}\n\n---\n${TASK_STEPS_INSTRUCTION}`;
}

export function prepareTaskPromptText(taskId: string, text: string): string {
  if (!shouldInjectTaskStepsInstruction(taskId)) {
    return text;
  }

  return buildTaskStepsPrompt(text);
}

export async function fetchTaskStepsSnapshotForTask(
  taskId: string,
): Promise<TaskStepsSnapshot | null> {
  const snapshot = await invoke(IPC.GetTaskStepsSnapshot, { taskId });
  if (snapshot) {
    setTaskStepsSnapshot(snapshot);
  }
  return snapshot;
}

export function prefillTaskStepNextAction(taskId: string, text: string): void {
  const normalized = text.trim();
  if (normalized.length === 0) {
    clearPrefillPrompt(taskId);
    return;
  }

  setPrefillPrompt(taskId, normalized);
  setTaskFocusedPanel(taskId, 'prompt');
}

export function jumpToTaskStepTarget(taskId: string, _step: TaskStepEntry): void {
  const task = store.tasks[taskId];
  if (!task) {
    return;
  }

  if (task.agentIds.length > 0) {
    setTaskFocusedPanel(taskId, 'ai-terminal');
    return;
  }

  if (task.shellAgentIds.length > 0) {
    setTaskFocusedPanel(taskId, 'shell:0');
    return;
  }

  setTaskFocusedPanel(taskId, 'prompt');
}
