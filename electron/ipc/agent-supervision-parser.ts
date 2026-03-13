import {
  hasHydraPromptInTail,
  looksLikePromptLine,
  looksLikeQuestionInVisibleTail,
  normalizeForComparison,
  stripAnsi,
} from '../../src/lib/prompt-detection.js';

const PREVIEW_LIMIT = 140;
const INTERACTIVE_CHOICE_PATTERN =
  /\bshift\+tab(?:\s+to\s+cycle)?\b|\btab(?:\s+to\s+cycle)?\b|\buse arrow keys\b|\bselect an option\b|\bbypass permissions?\b/i;

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, PREVIEW_LIMIT - 1)}…`;
}

function getRecentVisibleLines(text: string): string[] {
  return text
    .slice(-500)
    .split(/\r?\n/)
    .map((line) => normalizeForComparison(line))
    .filter((line) => line.length > 0);
}

function isMeaningfulPreviewLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (INTERACTIVE_CHOICE_PATTERN.test(trimmed)) {
    return true;
  }

  const visibleChars = Array.from(trimmed).filter((character) => !/\s/u.test(character)).length;
  if (visibleChars === 0) {
    return false;
  }

  const wordChars = (trimmed.match(/[A-Za-z0-9]/g) ?? []).length;
  if (wordChars === 0 && /^[^\p{L}\p{N}]+$/u.test(trimmed)) {
    return false;
  }

  return wordChars / visibleChars >= 0.25 || /[A-Za-z]{3,}/.test(trimmed);
}

function getMeaningfulPreviewLine(text: string): string {
  const lines = getRecentVisibleLines(text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && isMeaningfulPreviewLine(line)) {
      return line;
    }
  }

  return '';
}

function getLastVisibleLine(text: string): string {
  const lines = getRecentVisibleLines(text);
  return lines[lines.length - 1] ?? '';
}

function getQuestionPreview(text: string): string {
  if (INTERACTIVE_CHOICE_PATTERN.test(text)) {
    return 'Select an option';
  }

  const lines = getRecentVisibleLines(text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && /[?]$|\[Y\/n\]$|\[y\/N\]$|\(y(?:es)?\/n(?:o)?\)$/i.test(line)) {
      return truncatePreview(line);
    }
  }

  return truncatePreview(lines[lines.length - 1] ?? 'Waiting for input');
}

function getPromptPreview(rawTail: string): string {
  const strippedTail = stripAnsi(rawTail);
  const lastVisibleLine = getMeaningfulPreviewLine(strippedTail);
  if (lastVisibleLine) {
    return truncatePreview(lastVisibleLine);
  }

  if (hasHydraPromptInTail(rawTail)) {
    return 'hydra>';
  }

  return 'Ready for next input';
}

function getActivePreview(rawTail: string): string {
  const preview = getMeaningfulPreviewLine(stripAnsi(rawTail));
  return preview ? truncatePreview(preview) : '';
}

export function getExitPreview(lastOutput: string[]): string {
  const joined = lastOutput
    .map((line) => normalizeForComparison(line))
    .filter((line) => line.length > 0);
  return truncatePreview(joined[joined.length - 1] ?? '');
}

export function classifyOutputState(rawTail: string): {
  preview: string;
  state: 'active' | 'awaiting-input' | 'idle-at-prompt';
} {
  const strippedTail = stripAnsi(rawTail);
  const lastVisibleLine = getLastVisibleLine(strippedTail);

  if (looksLikeQuestionInVisibleTail(strippedTail)) {
    return {
      preview: getQuestionPreview(strippedTail),
      state: 'awaiting-input',
    };
  }

  if (looksLikePromptLine(lastVisibleLine) || hasHydraPromptInTail(rawTail)) {
    return {
      preview: getPromptPreview(rawTail),
      state: 'idle-at-prompt',
    };
  }

  return {
    preview: getActivePreview(rawTail),
    state: 'active',
  };
}
