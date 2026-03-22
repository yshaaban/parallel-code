import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const changedFilesListSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/ChangedFilesList.tsx'),
  'utf8',
);
const closeTaskDialogSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/CloseTaskDialog.tsx'),
  'utf8',
);
const mergeDialogSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/MergeDialog.tsx'),
  'utf8',
);

describe('task dialog architecture guardrails', () => {
  it('keeps destructive dialog git status behind the shared task-git-status owner', () => {
    expect(closeTaskDialogSource).toContain('getTaskGitStatus');
    expect(closeTaskDialogSource).toContain('refreshTaskGitStatusForTask');
    expect(closeTaskDialogSource).not.toContain('IPC.GetWorktreeStatus');
    expect(mergeDialogSource).toContain('getTaskGitStatus');
    expect(mergeDialogSource).toContain('refreshTaskGitStatusForTask');
    expect(mergeDialogSource).not.toContain('IPC.GetWorktreeStatus');
  });

  it('keeps changed-files mode explicit and task-bound merge lists on the task snapshot path', () => {
    expect(changedFilesListSource).toContain("kind: 'task'");
    expect(changedFilesListSource).toContain("kind: 'worktree'");
    expect(mergeDialogSource).toContain('kind="task"');
    expect(mergeDialogSource).toContain('taskId={props.task.id}');
  });
});
