import {
  hasHydraPromptInTail,
  looksLikePromptLine,
  looksLikeQuestionInVisibleTail,
  normalizeForComparison,
  stripAnsi,
} from '../../src/lib/prompt-detection.js';
import {
  getRecentVisibleLines,
  isMeaningfulPreviewLine,
  truncatePreview,
} from '../../src/lib/preview-heuristics.js';

const INTERACTIVE_CHOICE_PATTERN =
  /\bshift\+tab(?:\s+to\s+cycle)?\b|\btab(?:\s+to\s+cycle)?\b|\buse arrow keys\b|\bselect an option\b|\bbypass permissions?\b/i;
const PREVIEW_LIMIT = 140;

function getNormalizedVisibleLines(text: string): string[] {
  return getRecentVisibleLines(text, normalizeForComparison);
}

function getMeaningfulPreviewLine(text: string): string {
  const lines = getNormalizedVisibleLines(text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && isMeaningfulPreviewLine(line)) {
      return line;
    }
  }

  return '';
}

function getLastVisibleLine(text: string): string {
  const lines = getNormalizedVisibleLines(text);
  return lines[lines.length - 1] ?? '';
}

function getQuestionPreview(text: string): string {
  if (INTERACTIVE_CHOICE_PATTERN.test(text)) {
    return 'Select an option';
  }

  const lines = getNormalizedVisibleLines(text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && /[?]$|\[Y\/n\]$|\[y\/N\]$|\(y(?:es)?\/n(?:o)?\)$/i.test(line)) {
      return truncatePreview(line, PREVIEW_LIMIT);
    }
  }

  return truncatePreview(lines[lines.length - 1] ?? 'Waiting for input', PREVIEW_LIMIT);
}

function getPromptPreview(rawTail: string): string {
  const strippedTail = stripAnsi(rawTail);
  const lastVisibleLine = getMeaningfulPreviewLine(strippedTail);
  if (lastVisibleLine) {
    return truncatePreview(lastVisibleLine, PREVIEW_LIMIT);
  }

  if (hasHydraPromptInTail(rawTail)) {
    return 'hydra>';
  }

  return 'Ready for next input';
}

function getActivePreview(rawTail: string): string {
  const preview = getMeaningfulPreviewLine(stripAnsi(rawTail));
  return preview ? truncatePreview(preview, PREVIEW_LIMIT) : '';
}

export function getExitPreview(lastOutput: string[]): string {
  const joined = lastOutput
    .map((line) => normalizeForComparison(line))
    .filter((line) => line.length > 0);
  return truncatePreview(joined[joined.length - 1] ?? '', PREVIEW_LIMIT);
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
