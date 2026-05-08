import type { ChangedFile } from '../ipc/types';

export interface ChangedFileDisplayEntry {
  disambig: string;
  fullPath: string;
  name: string;
}

interface ParsedChangedFileDisplayEntry {
  dir: string;
  dirSegments: string[];
  fullPath: string;
  name: string;
}

interface ChangedFileNameGroupDisplayStats {
  entries: ParsedChangedFileDisplayEntry[];
  suffixCountsByDepth: Map<number, Map<string, number>>;
}

function normalizeDisplayPath(filePath: string): string {
  return filePath.replace(/\/+$/, '');
}

function splitDisplayPath(filePath: string): { dir: string; name: string } {
  const normalizedPath = normalizeDisplayPath(filePath);
  if (normalizedPath === '') {
    return { dir: '', name: filePath };
  }

  const separatorIndex = normalizedPath.lastIndexOf('/');
  if (separatorIndex === -1) {
    return { dir: '', name: normalizedPath };
  }

  return {
    dir: normalizedPath.slice(0, separatorIndex),
    name: normalizedPath.slice(separatorIndex + 1),
  };
}

function parseChangedFileDisplayEntry(filePath: string): ParsedChangedFileDisplayEntry {
  const { dir, name } = splitDisplayPath(filePath);
  return {
    dir,
    dirSegments: dir ? dir.split('/') : [],
    fullPath: filePath,
    name,
  };
}

function getDirectorySuffix(file: ParsedChangedFileDisplayEntry, depth: number): string {
  if (file.dirSegments.length === 0) {
    return '';
  }

  return file.dirSegments.slice(Math.max(0, file.dirSegments.length - depth)).join('/');
}

function getUniqueDisplayFilesByPath(
  files: ReadonlyArray<ParsedChangedFileDisplayEntry>,
): ParsedChangedFileDisplayEntry[] {
  const uniqueFilesByPath = new Map<string, ParsedChangedFileDisplayEntry>();

  for (const file of files) {
    if (!uniqueFilesByPath.has(file.fullPath)) {
      uniqueFilesByPath.set(file.fullPath, file);
    }
  }

  return Array.from(uniqueFilesByPath.values());
}

function getSuffixCountsByDepth(
  files: ReadonlyArray<ParsedChangedFileDisplayEntry>,
): Map<number, Map<string, number>> {
  const uniqueFiles = getUniqueDisplayFilesByPath(files);
  const maxDepth = uniqueFiles.reduce((depth, file) => Math.max(depth, file.dirSegments.length), 0);
  const suffixCountsByDepth = new Map<number, Map<string, number>>();

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const suffixCounts = new Map<string, number>();
    for (const file of uniqueFiles) {
      const suffix = getDirectorySuffix(file, depth);
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
    }
    suffixCountsByDepth.set(depth, suffixCounts);
  }

  return suffixCountsByDepth;
}

function getChangedFileNameGroupDisplayStats(
  nameGroups: ReadonlyMap<string, ParsedChangedFileDisplayEntry[]>,
): Map<string, ChangedFileNameGroupDisplayStats> {
  const statsByName = new Map<string, ChangedFileNameGroupDisplayStats>();

  for (const [name, entries] of nameGroups) {
    statsByName.set(name, {
      entries,
      suffixCountsByDepth: getSuffixCountsByDepth(entries),
    });
  }

  return statsByName;
}

function getChangedFileDisplayDisambiguation(
  file: ParsedChangedFileDisplayEntry,
  groupStats: ChangedFileNameGroupDisplayStats | undefined,
): string {
  if (!groupStats || groupStats.entries.length <= 1 || !file.dir) {
    return '';
  }

  for (let depth = 1; depth <= file.dirSegments.length; depth += 1) {
    const suffix = getDirectorySuffix(file, depth);
    const suffixCounts = groupStats.suffixCountsByDepth.get(depth);
    if ((suffixCounts?.get(suffix) ?? 0) <= 1) {
      return `${suffix}/`;
    }
  }

  return `${file.dir}/`;
}

export function isDiffableChangedFilePath(filePath: string): boolean {
  const trimmedPath = filePath.trim();
  return trimmedPath !== '' && !trimmedPath.endsWith('/');
}

export function getChangedFileDisplayEntries(
  files: ReadonlyArray<Pick<ChangedFile, 'path'>>,
): ChangedFileDisplayEntry[] {
  const nameGroups = new Map<string, ParsedChangedFileDisplayEntry[]>();
  const parsedFiles = files.map((file) => {
    const parsedFile = parseChangedFileDisplayEntry(file.path);
    const group = nameGroups.get(parsedFile.name);
    if (group) {
      group.push(parsedFile);
    } else {
      nameGroups.set(parsedFile.name, [parsedFile]);
    }
    return parsedFile;
  });
  const groupStatsByName = getChangedFileNameGroupDisplayStats(nameGroups);

  return parsedFiles.map((file) => {
    const groupStats = groupStatsByName.get(file.name);
    const disambig = getChangedFileDisplayDisambiguation(file, groupStats);
    return { name: file.name, disambig, fullPath: file.fullPath };
  });
}
