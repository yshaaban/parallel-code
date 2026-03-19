export interface PreviewLineHeuristicOptions {
  keywordPattern?: RegExp;
  minimumWordRatio?: number;
}

export function truncatePreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

export function getRecentVisibleLines(
  text: string,
  normalizeLine: (line: string) => string,
): string[] {
  return text
    .slice(-500)
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((line) => line.length > 0);
}

export function isMeaningfulPreviewLine(
  line: string,
  options: PreviewLineHeuristicOptions = {},
): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (options.keywordPattern?.test(trimmed)) {
    return true;
  }

  const visibleCharacters = Array.from(trimmed).filter(
    (character) => !/\s/u.test(character),
  ).length;
  if (visibleCharacters === 0) {
    return false;
  }

  const wordCharacters = (trimmed.match(/[A-Za-z0-9]/g) ?? []).length;
  if (wordCharacters === 0) {
    return false;
  }

  const minimumWordRatio = options.minimumWordRatio ?? 0.25;
  return wordCharacters / visibleCharacters >= minimumWordRatio || /[A-Za-z]{3,}/.test(trimmed);
}
