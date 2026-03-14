/** Check if diff output indicates a binary file. */
export function isBinaryDiff(raw: string): boolean {
  return (raw.includes('Binary files') && raw.includes('differ')) || raw.includes('GIT binary patch');
}

// --- Structured diff parsing ---

export interface ParsedDiffLine {
  key: string;
  kind: 'add' | 'delete' | 'context';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface ParsedDiffHunk {
  key: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/** Parse a unified diff string into structured hunks with line metadata. */
export function parseUnifiedDiff(diffText: string): ParsedDiffHunk[] {
  if (!diffText) return [];

  const rawLines = diffText.split('\n');
  const hunks: ParsedDiffHunk[] = [];
  let currentHunk: ParsedDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let lineIdx = 0;

  for (const [rawIndex, raw] of rawLines.entries()) {
    const hunkMatch = raw.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      const oldStartRaw = hunkMatch[1];
      const newStartRaw = hunkMatch[3];
      if (oldStartRaw === undefined || newStartRaw === undefined) {
        continue;
      }

      const oldStart = parseInt(oldStartRaw, 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(newStartRaw, 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      currentHunk = {
        key: `hunk-${hunks.length}`,
        header: raw,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      hunks.push(currentHunk);
      oldLine = oldStart;
      newLine = newStart;
      lineIdx = 0;
      continue;
    }

    if (!currentHunk) continue;

    if (raw.startsWith('+')) {
      currentHunk.lines.push({
        key: `${currentHunk.key}-L${lineIdx}`,
        kind: 'add',
        text: raw.slice(1),
        newLineNumber: newLine,
      });
      newLine++;
      lineIdx++;
    } else if (raw.startsWith('-')) {
      currentHunk.lines.push({
        key: `${currentHunk.key}-L${lineIdx}`,
        kind: 'delete',
        text: raw.slice(1),
        oldLineNumber: oldLine,
      });
      oldLine++;
      lineIdx++;
    } else if (raw.startsWith(' ') || raw === '') {
      // Only treat empty string as context if we're inside a hunk and it's not the trailing newline
      if (raw === '' && rawIndex === rawLines.length - 1) continue;
      currentHunk.lines.push({
        key: `${currentHunk.key}-L${lineIdx}`,
        kind: 'context',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine++;
      newLine++;
      lineIdx++;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — skip
      continue;
    } else if (
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('---') ||
      raw.startsWith('+++')
    ) {
      // File header lines — skip
      continue;
    }
  }

  return hunks;
}
