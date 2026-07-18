export type CleanupStep = readonly [label: string, cleanup: () => unknown | Promise<unknown>];

export type OperationOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { reason: unknown; status: 'rejected' };

export function createLabeledCleanupError(label: string, error: unknown): Error;

export function assertOperationCleanupSucceeded<T>(
  label: string,
  operationOutcome: OperationOutcome<T>,
  cleanupErrors: readonly Error[],
): void;

export function runOperationWithCleanups<T>(
  label: string,
  operation: () => T | Promise<T>,
  cleanupSteps: readonly CleanupStep[],
): Promise<T>;

export function runIndependentCleanups(
  label: string,
  cleanupSteps: readonly CleanupStep[],
): Promise<void>;
