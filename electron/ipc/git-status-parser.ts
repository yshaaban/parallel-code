export interface ParsedNumstatFile {
  path: string;
  lines_added: number;
  lines_removed: number;
  status: string;
  committed: boolean;
}

export function normalizeStatusPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const unquoted = trimmed.replace(/^"|"$/g, '');
  const braceMatch = unquoted.match(/^(.*?)\{.*? => (.*?)\}(.*)$/);
  if (braceMatch) {
    return (braceMatch[1] + braceMatch[2] + braceMatch[3]).replace(/\/\//g, '/').replace(/^\//, '');
  }

  const destination =
    trimmed
      .split(/ (?:->|=>) /)
      .pop()
      ?.trim() ?? trimmed;
  return destination.replace(/^"|"$/g, '');
}

export function parseDiffRawNumstat(output: string): {
  statusMap: Map<string, string>;
  numstatMap: Map<string, [number, number]>;
} {
  const statusMap = new Map<string, string>();
  const numstatMap = new Map<string, [number, number]>();

  for (const line of output.split('\n')) {
    if (line.startsWith(':')) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const statusLetter = parts[0].split(/\s+/).pop()?.charAt(0) ?? 'M';
        const rawPath = parts[parts.length - 1];
        const p = normalizeStatusPath(rawPath);
        if (p) statusMap.set(p, statusLetter);
      }
      continue;
    }

    const parts = line.split('\t');
    if (parts.length >= 3) {
      const added = parseInt(parts[0], 10);
      const removed = parseInt(parts[1], 10);
      if (!isNaN(added) && !isNaN(removed)) {
        const rawPath = parts[parts.length - 1];
        const p = normalizeStatusPath(rawPath);
        if (p) numstatMap.set(p, [added, removed]);
      }
    }
  }

  return { statusMap, numstatMap };
}

export function parseConflictPath(line: string): string | null {
  const trimmed = line.trim();

  const mergeConflictIdx = trimmed.indexOf('Merge conflict in ');
  if (mergeConflictIdx !== -1) {
    const p = trimmed.slice(mergeConflictIdx + 'Merge conflict in '.length).trim();
    return p || null;
  }

  if (!trimmed.startsWith('CONFLICT')) return null;

  const parenClose = trimmed.indexOf('): ');
  if (parenClose === -1) return null;
  const afterParen = trimmed.slice(parenClose + 3);

  const markers = [' deleted in ', ' modified in ', ' added in ', ' renamed in ', ' changed in '];
  let cutoff = Infinity;
  for (const marker of markers) {
    const idx = afterParen.indexOf(marker);
    if (idx !== -1 && idx < cutoff) cutoff = idx;
  }

  const candidate = (cutoff === Infinity ? afterParen : afterParen.slice(0, cutoff)).trim();
  return candidate || null;
}

export function parseNumstat(stdout: string, status: string): ParsedNumstatFile[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.split('\t');
      const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const removed = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      const filePath = parts.slice(2).join('\t');
      return {
        path: filePath,
        lines_added: added,
        lines_removed: removed,
        status,
        committed: false,
      };
    });
}
