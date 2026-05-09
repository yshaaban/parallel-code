import { unwrap } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { loadPresets, loadHistory, arenaStore } from './store';
import type { ArenaPreset, ArenaMatch } from './types';
import { isFiniteNumber, isRecord } from '../lib/type-guards';

type ArenaPresetCompetitor = ArenaPreset['competitors'][number];
type ArenaMatchCompetitor = ArenaMatch['competitors'][number];

const ARENA_DATA_FILES = {
  history: 'arena-history.json',
  presets: 'arena-presets.json',
} as const;

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function parsePresetCompetitor(value: unknown): ArenaPresetCompetitor | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.command !== 'string') {
    return null;
  }

  return {
    command: value.command,
    name: value.name,
  };
}

function parseArenaPreset(value: unknown): ArenaPreset | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.competitors)
  ) {
    return null;
  }

  return {
    competitors: value.competitors
      .map(parsePresetCompetitor)
      .filter((competitor): competitor is ArenaPresetCompetitor => competitor !== null),
    id: value.id,
    name: value.name,
  };
}

function parseMatchCompetitor(value: unknown): ArenaMatchCompetitor | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.command !== 'string') {
    return null;
  }

  return {
    branchName: nullableString(value.branchName),
    command: value.command,
    exitCode: nullableNumber(value.exitCode),
    merged: value.merged === true,
    name: value.name,
    rating: nullableNumber(value.rating),
    terminalOutput: nullableString(value.terminalOutput),
    timeMs: nullableNumber(value.timeMs),
    worktreePath: nullableString(value.worktreePath),
  };
}

function parseArenaMatch(value: unknown): ArenaMatch | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.date !== 'string' ||
    typeof value.prompt !== 'string' ||
    !Array.isArray(value.competitors)
  ) {
    return null;
  }

  return {
    competitors: value.competitors
      .map(parseMatchCompetitor)
      .filter((competitor): competitor is ArenaMatchCompetitor => competitor !== null),
    cwd: nullableString(value.cwd),
    date: value.date,
    id: value.id,
    prompt: value.prompt,
  };
}

function parseArenaDataArray<TValue>(
  json: string,
  parseEntry: (value: unknown) => TValue | null,
): TValue[] | null {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    return null;
  }

  return parsed.map(parseEntry).filter((value): value is TValue => value !== null);
}

function parseArenaPresets(json: string): ArenaPreset[] | null {
  return parseArenaDataArray(json, parseArenaPreset);
}

function parseArenaHistory(json: string): ArenaMatch[] | null {
  return parseArenaDataArray(json, parseArenaMatch);
}

async function loadArenaData<TValue>(
  filename: string,
  parse: (json: string) => TValue[] | null,
  apply: (values: TValue[]) => void,
  label: string,
): Promise<void> {
  const json = await invoke(IPC.LoadArenaData, {
    filename,
  }).catch(() => null);
  if (!json) {
    return;
  }

  try {
    const values = parse(json);
    if (values) {
      apply(values);
    }
  } catch {
    console.warn(`Failed to parse arena ${label}`);
  }
}

async function saveArenaData(filename: string, json: string, label: string): Promise<void> {
  await invoke(IPC.SaveArenaData, {
    filename,
    json,
  }).catch((error) => console.warn(`Failed to save arena ${label}:`, error));
}

export async function loadArenaPresets(): Promise<void> {
  await loadArenaData(ARENA_DATA_FILES.presets, parseArenaPresets, loadPresets, 'presets');
}

export async function saveArenaPresets(): Promise<void> {
  await saveArenaData(
    ARENA_DATA_FILES.presets,
    JSON.stringify(unwrap(arenaStore.presets)),
    'presets',
  );
}

export async function loadArenaHistory(): Promise<void> {
  await loadArenaData(ARENA_DATA_FILES.history, parseArenaHistory, loadHistory, 'history');
}

export async function saveArenaHistory(): Promise<void> {
  await saveArenaData(
    ARENA_DATA_FILES.history,
    JSON.stringify(unwrap(arenaStore.history)),
    'history',
  );
}
