import type { Terminal } from '@xterm/xterm';

export interface TerminalLinkRange {
  end: { x: number; y: number };
  start: { x: number; y: number };
}

export interface TerminalMarkdownLink {
  range: TerminalLinkRange;
  relativePath: string;
  text: string;
}

export interface TerminalLinkScanLimits {
  maxCells: number;
  maxRows: number;
}

type TerminalBuffer = Pick<Terminal['buffer']['active'], 'getLine' | 'getNullCell' | 'length'>;

interface TextCellInterval {
  columnEnd: number;
  columnStart: number;
  row: number;
  textEnd: number;
  textStart: number;
}

interface MappedLogicalLine {
  intervals: TextCellInterval[];
  text: string;
}

interface ParsedMarkdownCandidate {
  relativePath: string;
  startIndex: number;
  text: string;
}

interface DecodedFileUrlLocation {
  host: string;
  segments: string[];
}

export const DEFAULT_TERMINAL_LINK_SCAN_LIMITS: Readonly<TerminalLinkScanLimits> = Object.freeze({
  maxCells: 4_096,
  maxRows: 128,
});

const TERMINAL_PATH_TOKEN_PATTERN = /[^\s<>()"'`]+/gu;
const TERMINAL_MARKDOWN_TOKEN_PATTERN =
  /^(?:file:\/\/\/?[^\s<>()"'`]+|(?:~?\/|\.{1,2}\/)?[^\s<>()"'`]+\.md(?:[?#][^\s<>()"'`]*)?(?::\d+(?::\d+)?)?)/iu;

function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function hasFileUrlPrefix(filePath: string): boolean {
  return /^file:\/\//iu.test(filePath);
}

function isWindowsDrivePath(filePath: string): boolean {
  return /^[a-zA-Z]:\//u.test(normalizePathSeparators(filePath));
}

function isWindowsDriveSegment(pathSegment: string | undefined): boolean {
  return pathSegment !== undefined && /^[a-zA-Z]:$/u.test(pathSegment);
}

function stripMarkdownLinkSuffix(linkText: string): string {
  const trimmedText = linkText.trim().replace(/^[('"`]+|[)',.;:!?`]+$/gu, '');
  const textWithoutFragment = trimmedText.split('#', 1)[0] ?? '';
  const textWithoutQuery = textWithoutFragment.split('?', 1)[0] ?? '';
  return textWithoutQuery.replace(/:\d+(?::\d+)?$/u, '');
}

function toFileUrlInput(filePath: string): string {
  const normalizedPath = normalizePathSeparators(filePath);
  if (hasFileUrlPrefix(normalizedPath)) {
    return normalizedPath;
  }
  if (isWindowsDrivePath(normalizedPath)) {
    return `file:///${normalizedPath}`;
  }
  return normalizedPath.startsWith('/') ? `file://${normalizedPath}` : normalizedPath;
}

function getDirectoryFileUrl(directoryPath: string): URL | null {
  const normalizedPath = normalizePathSeparators(directoryPath).trim();
  if (normalizedPath.length === 0) {
    return null;
  }
  try {
    return new URL(
      toFileUrlInput(normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`),
    );
  } catch {
    return null;
  }
}

function hasUnsafeEncodedPathStructure(pathInput: string): boolean {
  return pathInput.split('/').some((rawSegment) => {
    if (!rawSegment.includes('%')) {
      return false;
    }

    try {
      const decodedSegment = decodeURIComponent(rawSegment);
      return (
        decodedSegment === '.' ||
        decodedSegment === '..' ||
        decodedSegment.includes('/') ||
        decodedSegment.includes('\\')
      );
    } catch {
      return true;
    }
  });
}

function decodeFileUrlLocation(fileUrl: URL): DecodedFileUrlLocation | null {
  try {
    const segments: string[] = [];
    for (const rawSegment of fileUrl.pathname.split('/')) {
      if (rawSegment.length === 0) {
        continue;
      }

      const decodedSegment = decodeURIComponent(rawSegment);
      if (
        decodedSegment === '.' ||
        decodedSegment === '..' ||
        decodedSegment.includes('/') ||
        decodedSegment.includes('\\')
      ) {
        return null;
      }
      segments.push(decodedSegment);
    }

    return {
      host: decodeURIComponent(fileUrl.host),
      segments,
    };
  } catch {
    return null;
  }
}

function resolveMarkdownRelativePath(worktreePath: string, linkText: string): string | null {
  const worktreeUrl = getDirectoryFileUrl(worktreePath);
  const sanitizedText = stripMarkdownLinkSuffix(linkText);
  if (!worktreeUrl || sanitizedText.length === 0 || sanitizedText.startsWith('~/')) {
    return null;
  }

  const normalizedText = normalizePathSeparators(sanitizedText);
  if (
    !normalizedText.toLowerCase().endsWith('.md') ||
    hasUnsafeEncodedPathStructure(normalizedText)
  ) {
    return null;
  }
  const hasExplicitScheme =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(normalizedText) && !isWindowsDrivePath(normalizedText);
  if (hasExplicitScheme && !hasFileUrlPrefix(normalizedText)) {
    return null;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(
      hasFileUrlPrefix(normalizedText) || isWindowsDrivePath(normalizedText)
        ? toFileUrlInput(normalizedText)
        : normalizedText,
      worktreeUrl,
    );
  } catch {
    return null;
  }
  if (targetUrl.protocol !== 'file:') {
    return null;
  }

  const rootLocation = decodeFileUrlLocation(worktreeUrl);
  const targetLocation = decodeFileUrlLocation(targetUrl);
  if (!rootLocation || !targetLocation) {
    return null;
  }
  const caseInsensitive =
    rootLocation.host.length > 0 ||
    targetLocation.host.length > 0 ||
    isWindowsDriveSegment(rootLocation.segments[0]) ||
    isWindowsDriveSegment(targetLocation.segments[0]);
  const normalizeForComparison = (value: string): string =>
    caseInsensitive ? value.toLowerCase() : value;
  if (normalizeForComparison(rootLocation.host) !== normalizeForComparison(targetLocation.host)) {
    return null;
  }

  const rootSegments = rootLocation.segments.map(normalizeForComparison);
  const targetSegments = targetLocation.segments.map(normalizeForComparison);
  if (
    targetSegments.length <= rootSegments.length ||
    rootSegments.some((segment, index) => targetSegments[index] !== segment)
  ) {
    return null;
  }
  return targetLocation.segments.slice(rootSegments.length).join('/');
}

function parseMarkdownCandidates(text: string, worktreePath: string): ParsedMarkdownCandidate[] {
  const candidates: ParsedMarkdownCandidate[] = [];
  const tokenPattern = new RegExp(TERMINAL_PATH_TOKEN_PATTERN.source, 'gu');
  let token: RegExpExecArray | null;
  while ((token = tokenPattern.exec(text)) !== null) {
    if (!token[0].toLowerCase().includes('.md')) {
      continue;
    }
    const match = TERMINAL_MARKDOWN_TOKEN_PATTERN.exec(token[0]);
    if (!match) {
      continue;
    }
    const displayText = stripMarkdownLinkSuffix(match[0]);
    const relativePath = resolveMarkdownRelativePath(worktreePath, displayText);
    if (displayText.length > 0 && relativePath) {
      const leadingOffset = match[0].indexOf(displayText);
      candidates.push({
        relativePath,
        startIndex: token.index + Math.max(0, leadingOffset),
        text: displayText,
      });
    }
  }
  return candidates;
}

function findLogicalLineBounds(
  buffer: TerminalBuffer,
  requestedIndex: number,
  maxRows: number,
): { end: number; start: number } | null {
  let start = requestedIndex;
  let rows = 1;
  while (buffer.getLine(start)?.isWrapped) {
    if (start === 0 || rows >= maxRows) {
      return null;
    }
    start -= 1;
    rows += 1;
  }

  let end = requestedIndex;
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) {
    if (rows >= maxRows) {
      return null;
    }
    end += 1;
    rows += 1;
  }
  return { end, start };
}

function mapLogicalLine(
  buffer: TerminalBuffer,
  bounds: { end: number; start: number },
  maxCells: number,
): MappedLogicalLine | null {
  let displayCells = 0;
  let logicalText = '';
  const intervals: TextCellInterval[] = [];
  const reusableCell = buffer.getNullCell();

  for (let row = bounds.start; row <= bounds.end; row += 1) {
    const line = buffer.getLine(row);
    if (!line || displayCells + line.length > maxCells) {
      return null;
    }
    displayCells += line.length;

    const rowText = line.translateToString(true);
    let rowTextOffset = 0;
    for (let column = 0; column < line.length && rowTextOffset < rowText.length; column += 1) {
      const cell = line.getCell(column, reusableCell);
      if (!cell) {
        return null;
      }
      const width = cell.getWidth();
      if (width === 0) {
        continue;
      }
      if (width !== 1 && width !== 2) {
        return null;
      }

      const chars = cell.getChars() || ' ';
      if (!rowText.startsWith(chars, rowTextOffset)) {
        return null;
      }
      const textStart = logicalText.length;
      logicalText += chars;
      rowTextOffset += chars.length;
      intervals.push({
        columnEnd: column + width - 1,
        columnStart: column,
        row,
        textEnd: logicalText.length,
        textStart,
      });
    }
    if (rowTextOffset !== rowText.length) {
      return null;
    }
  }
  return { intervals, text: logicalText };
}

function findIntervalAtOffset(
  intervals: readonly TextCellInterval[],
  offset: number,
): TextCellInterval | null {
  return (
    intervals.find((interval) => offset >= interval.textStart && offset < interval.textEnd) ?? null
  );
}

export function computeTerminalMarkdownLinks(
  buffer: TerminalBuffer,
  requestedRow: number,
  worktreePath: string,
  limits: TerminalLinkScanLimits = DEFAULT_TERMINAL_LINK_SCAN_LIMITS,
): readonly TerminalMarkdownLink[] {
  if (
    !Number.isInteger(requestedRow) ||
    requestedRow < 1 ||
    requestedRow > buffer.length ||
    worktreePath.trim().length === 0 ||
    !Number.isSafeInteger(limits.maxCells) ||
    limits.maxCells <= 0 ||
    !Number.isSafeInteger(limits.maxRows) ||
    limits.maxRows <= 0
  ) {
    return [];
  }

  try {
    const bounds = findLogicalLineBounds(buffer, requestedRow - 1, limits.maxRows);
    const mapped = bounds ? mapLogicalLine(buffer, bounds, limits.maxCells) : null;
    if (!mapped) {
      return [];
    }

    return parseMarkdownCandidates(mapped.text, worktreePath).flatMap((candidate) => {
      const start = findIntervalAtOffset(mapped.intervals, candidate.startIndex);
      const end = findIntervalAtOffset(
        mapped.intervals,
        candidate.startIndex + candidate.text.length - 1,
      );
      if (!start || !end || requestedRow < start.row + 1 || requestedRow > end.row + 1) {
        return [];
      }
      return [
        {
          range: {
            end: { x: end.columnEnd + 1, y: end.row + 1 },
            start: { x: start.columnStart + 1, y: start.row + 1 },
          },
          relativePath: candidate.relativePath,
          text: candidate.text,
        },
      ];
    });
  } catch {
    return [];
  }
}
