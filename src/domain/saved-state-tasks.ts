import { isRecord } from '../lib/type-guards.js';

export type SavedStateTasksRecordParseResult =
  | { kind: 'invalid'; reason: 'json' | 'shape' }
  | { kind: 'missing' }
  | { kind: 'valid'; tasks: Record<string, unknown> };

export function parseSavedStateTasksRecordFromRoot(
  root: Record<string, unknown> | null,
): SavedStateTasksRecordParseResult {
  if (!root) {
    return { kind: 'invalid', reason: 'json' };
  }

  if (root.tasks === undefined) {
    return { kind: 'missing' };
  }

  return isRecord(root.tasks)
    ? { kind: 'valid', tasks: root.tasks }
    : { kind: 'invalid', reason: 'shape' };
}

export function parseSavedStateTasksRecord(json: string): SavedStateTasksRecordParseResult {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return { kind: 'invalid', reason: 'shape' };
    }

    return parseSavedStateTasksRecordFromRoot(parsed);
  } catch {
    return { kind: 'invalid', reason: 'json' };
  }
}
