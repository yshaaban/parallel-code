import { isRecord } from '../lib/type-guards.js';

export type SavedStateTasksRecordParseResult =
  | { kind: 'invalid'; reason: 'json' | 'shape' }
  | { kind: 'missing' }
  | { kind: 'valid'; tasks: Record<string, unknown> };

export function parseSavedStateTasksRecord(json: string): SavedStateTasksRecordParseResult {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return { kind: 'invalid', reason: 'shape' };
    }

    if (parsed.tasks === undefined) {
      return { kind: 'missing' };
    }

    return isRecord(parsed.tasks)
      ? { kind: 'valid', tasks: parsed.tasks }
      : { kind: 'invalid', reason: 'shape' };
  } catch {
    return { kind: 'invalid', reason: 'json' };
  }
}
