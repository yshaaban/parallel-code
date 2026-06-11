import { isRecord } from '../../src/lib/type-guards.js';
import {
  parsePersistedTaskLookupStateFromRoot,
  type ParsedPersistedTaskLookupState,
} from './persisted-task-lookup-state.js';

// Single-parse seam for persisted saved-state JSON. Boot, save/load handlers,
// and reconnect/cold-bootstrap consumers share one parsed document instead of
// re-parsing the same JSON string per consumer.

export interface SavedStateDocument {
  json: string;
  root: Record<string, unknown> | null;
  taskLookup: ParsedPersistedTaskLookupState;
}

export function createSavedStateDocument(json: string): SavedStateDocument {
  let root: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (isRecord(parsed)) {
      root = parsed;
    }
  } catch {
    root = null;
  }

  return {
    json,
    root,
    taskLookup: parsePersistedTaskLookupStateFromRoot(root),
  };
}

export function toSavedStateDocument(value: string | SavedStateDocument): SavedStateDocument {
  if (typeof value === 'string') {
    return createSavedStateDocument(value);
  }

  return value;
}
