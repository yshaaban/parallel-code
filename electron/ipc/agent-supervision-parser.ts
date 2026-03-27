import {
  getVisibleTerminalTextForDetection,
  hasPromptAdjacentInteractiveChoiceInVisibleTail,
  hasHydraPromptInTail,
  isNonBlockingShortcutHintLine,
  looksLikePromptLine,
  looksLikeQuestionInVisibleTail,
  normalizeForComparison,
} from '../../src/lib/prompt-detection.js';
import {
  getRecentVisibleLines,
  isMeaningfulPreviewLine,
  truncatePreview,
} from '../../src/lib/preview-heuristics.js';

const INTERACTIVE_CHOICE_PREVIEW_PATTERN =
  /\bchoose an option\b|\buse arrow keys(?:\s+to\s+cycle)?\b|\bselect an option\b/i;
const HYDRA_PROMPT_LINE_PATTERN = /hydra(?:\[[^\]\r\n]+\])?>/i;
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

function getLastPromptLineIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    if (looksLikePromptLine(line) || HYDRA_PROMPT_LINE_PATTERN.test(line)) {
      return index;
    }
  }

  return -1;
}

function getQuestionPreview(text: string): string {
  if (INTERACTIVE_CHOICE_PREVIEW_PATTERN.test(text)) {
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
  const visibleTail = getVisibleTerminalTextForDetection(rawTail);
  const lines = getNormalizedVisibleLines(visibleTail);
  const promptLineIndex = getLastPromptLineIndex(lines);
  if (promptLineIndex >= 0) {
    for (let index = promptLineIndex; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }

      if (isNonBlockingShortcutHintLine(line)) {
        continue;
      }

      if (HYDRA_PROMPT_LINE_PATTERN.test(line)) {
        return truncatePreview(
          line.match(HYDRA_PROMPT_LINE_PATTERN)?.[0] ?? 'hydra>',
          PREVIEW_LIMIT,
        );
      }

      if (isMeaningfulPreviewLine(line)) {
        return truncatePreview(line, PREVIEW_LIMIT);
      }
    }
  }

  if (hasHydraPromptInTail(rawTail)) {
    return 'hydra>';
  }

  return 'Ready for next input';
}

function getActivePreview(rawTail: string): string {
  const preview = getMeaningfulPreviewLine(getVisibleTerminalTextForDetection(rawTail));
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
  const visibleTail = getVisibleTerminalTextForDetection(rawTail);
  const lastVisibleLine = getLastVisibleLine(visibleTail);

  if (
    looksLikeQuestionInVisibleTail(visibleTail) ||
    hasPromptAdjacentInteractiveChoiceInVisibleTail(visibleTail)
  ) {
    return {
      preview: getQuestionPreview(visibleTail),
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
