export type TaskCreationWriterEpoch = 'pre-managed-v1' | 'managed-initial-shell-v1';

export interface TaskCreationProvenance {
  creationWriterEpoch: TaskCreationWriterEpoch;
}

export type TaskInitialShellOwnership =
  | { kind: 'not-applicable-agent'; migrationSchemaVersion: 1 }
  | { kind: 'legacy-unmanaged-terminal'; migrationSchemaVersion: 1 }
  | {
      expectedGeneration: number;
      kind: 'managed-terminal-v1';
      launchOperationId: string;
      sessionId: string;
    };

export type TaskCreationOperationLink =
  | { kind: 'pre-operation-journal'; migrationSchemaVersion: 1 }
  | {
      creationOperationId: string;
      kind: 'creation-v1';
      launchOperationId: string;
    };

export function isTaskCreationProvenance(value: unknown): value is TaskCreationProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const epoch = (value as { creationWriterEpoch?: unknown }).creationWriterEpoch;
  return epoch === 'pre-managed-v1' || epoch === 'managed-initial-shell-v1';
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !value.includes('\u0000')
  );
}

export function isTaskInitialShellOwnership(value: unknown): value is TaskInitialShellOwnership {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'not-applicable-agent' || candidate.kind === 'legacy-unmanaged-terminal') {
    return (
      hasExactKeys(candidate, ['kind', 'migrationSchemaVersion']) &&
      candidate.migrationSchemaVersion === 1
    );
  }
  return (
    candidate.kind === 'managed-terminal-v1' &&
    hasExactKeys(candidate, ['expectedGeneration', 'kind', 'launchOperationId', 'sessionId']) &&
    Number.isSafeInteger(candidate.expectedGeneration) &&
    (candidate.expectedGeneration as number) >= 0 &&
    isIdentifier(candidate.launchOperationId) &&
    isIdentifier(candidate.sessionId)
  );
}

export function isTaskCreationOperationLink(value: unknown): value is TaskCreationOperationLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'pre-operation-journal') {
    return (
      hasExactKeys(candidate, ['kind', 'migrationSchemaVersion']) &&
      candidate.migrationSchemaVersion === 1
    );
  }
  return (
    candidate.kind === 'creation-v1' &&
    hasExactKeys(candidate, ['creationOperationId', 'kind', 'launchOperationId']) &&
    isIdentifier(candidate.creationOperationId) &&
    isIdentifier(candidate.launchOperationId)
  );
}
