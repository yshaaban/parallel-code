export type LineType = "add" | "remove" | "context";

export interface DiffLine {
  type: LineType;
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** Parse unified diff text into structured hunks. */
export function parseDiff(raw: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = raw.split("\n");
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (hunkMatch) {
      current = { header: line, lines: [] };
      hunks.push(current);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      continue;
    }

    // Skip diff metadata lines (---, +++, diff, index, etc.)
    if (!current) continue;

    if (line.startsWith("+")) {
      current.lines.push({
        type: "add",
        content: line.slice(1),
        oldLineNo: null,
        newLineNo: newLine++,
      });
    } else if (line.startsWith("-")) {
      current.lines.push({
        type: "remove",
        content: line.slice(1),
        oldLineNo: oldLine++,
        newLineNo: null,
      });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — skip
      continue;
    } else {
      // Context line (starts with space or is empty within a hunk)
      current.lines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLineNo: oldLine++,
        newLineNo: newLine++,
      });
    }
  }

  return hunks;
}

/** Check if diff output indicates a binary file. */
export function isBinaryDiff(raw: string): boolean {
  return raw.includes("Binary files") && raw.includes("differ");
}
