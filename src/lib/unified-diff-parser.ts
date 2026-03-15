import type { ParsedDiffFileStatus } from '../domain/git-status';

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedFileDiff {
  path: string;
  status: ParsedDiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function extractPath(headerLine: string): string {
  const match = headerLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return match?.[2] ?? '';
}

function parseFileStatus(lines: ReadonlyArray<string>): ParsedFileDiff['status'] {
  for (const line of lines) {
    if (line.startsWith('new file mode')) {
      return 'A';
    }

    if (line.startsWith('deleted file mode')) {
      return 'D';
    }
  }

  return 'M';
}

function parseFileHunks(lines: ReadonlyArray<string>): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      const oldStart = Number.parseInt(hunkMatch[1] ?? '0', 10);
      const newStart = Number.parseInt(hunkMatch[3] ?? '0', 10);
      currentHunk = {
        oldStart,
        oldCount: Number.parseInt(hunkMatch[2] ?? '1', 10),
        newStart,
        newCount: Number.parseInt(hunkMatch[4] ?? '1', 10),
        lines: [],
      };
      hunks.push(currentHunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!currentHunk || line.startsWith('\\ ')) {
      continue;
    }

    const prefix = line[0];
    if (prefix === '+') {
      currentHunk.lines.push({
        type: 'add',
        content: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
      continue;
    }

    if (prefix === '-') {
      currentHunk.lines.push({
        type: 'remove',
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
      continue;
    }

    if (prefix === ' ') {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return hunks;
}

function parseFileBlock(lines: ReadonlyArray<string>): ParsedFileDiff | null {
  if (lines.length === 0) {
    return null;
  }

  const header = lines[0] ?? '';
  const path = extractPath(header);
  if (!path) {
    return null;
  }

  const binary = lines.some((line) => line.includes('Binary files') && line.includes('differ'));
  if (binary) {
    return {
      path,
      status: parseFileStatus(lines),
      binary: true,
      hunks: [],
    };
  }

  return {
    path,
    status: parseFileStatus(lines),
    binary: false,
    hunks: parseFileHunks(lines),
  };
}

export function parseMultiFileUnifiedDiff(rawDiff: string): ParsedFileDiff[] {
  if (!rawDiff.trim()) {
    return [];
  }

  return rawDiff
    .split(/^(?=diff --git )/m)
    .filter((block) => block.trim().length > 0)
    .map((block) => parseFileBlock(block.split('\n')))
    .filter((file): file is ParsedFileDiff => file !== null);
}
