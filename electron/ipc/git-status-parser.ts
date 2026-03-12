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
    const before = braceMatch[1] ?? '';
    const after = braceMatch[2] ?? '';
    const suffix = braceMatch[3] ?? '';
    return (before + after + suffix).replace(/\/\//g, '/').replace(/^\//, '');
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
        const rawHeader = parts[0];
        const rawPath = parts[parts.length - 1];
        if (!rawHeader || !rawPath) continue;

        const statusLetter = rawHeader.split(/\s+/).pop()?.charAt(0) ?? 'M';
        const p = normalizeStatusPath(rawPath);
        if (p) statusMap.set(p, statusLetter);
      }
      continue;
    }

    const parts = line.split('\t');
    if (parts.length >= 3) {
      const rawAdded = parts[0];
      const rawRemoved = parts[1];
      const rawPath = parts[parts.length - 1];
      if (!rawAdded || !rawRemoved || !rawPath) continue;

      const added = parseInt(rawAdded, 10);
      const removed = parseInt(rawRemoved, 10);
      if (!isNaN(added) && !isNaN(removed)) {
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
  const files: ParsedNumstatFile[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;

    const parts = line.split('\t');
    const rawAdded = parts[0];
    const rawRemoved = parts[1];
    if (!rawAdded || !rawRemoved || parts.length < 3) {
      continue;
    }

    const added = rawAdded === '-' ? 0 : parseInt(rawAdded, 10);
    const removed = rawRemoved === '-' ? 0 : parseInt(rawRemoved, 10);
    files.push({
      path: parts.slice(2).join('\t'),
      lines_added: added,
      lines_removed: removed,
      status,
      committed: false,
    });
  }

  return files;
}
