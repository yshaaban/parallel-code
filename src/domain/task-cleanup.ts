export type DeleteTaskCleanupWarningKind = 'containers' | 'worktree';

export interface DeleteTaskCleanupWarning {
  kind: DeleteTaskCleanupWarningKind;
  message: string;
}

export interface DeleteTaskResult {
  cleanupWarnings: DeleteTaskCleanupWarning[];
}
