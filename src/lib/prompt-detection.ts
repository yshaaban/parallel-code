const TRUST_PATTERNS: RegExp[] = [/\btrust\b.*\?/i, /\ballow\b.*\?/i, /trust.*folder/i];

const TRUST_EXCLUSION_KEYWORDS =
  /\b(delet|remov|credential|secret|password|key|token|destro|format|drop)/i;

const PROMPT_PATTERNS: RegExp[] = [
  /➜\s*$/,
  /❯\s*$/,
  /hydra(?:\[[^\]\r\n]+\])?>\s*$/i,
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
];

const CODEX_PROMPT_LINE_PATTERN = /^\s*›(?:\s+\S.*)?$/u;

const HYDRA_READY_TAIL_PATTERN = /(?:^|[\r\n])\s*hydra(?:\[[^\]\r\n]+\])?>\s*(?:[\r\n]|$)/i;

const QUESTION_PATTERN =
  /\[Y\/n\]\s*$|\[y\/N\]\s*$|\(y(?:es)?\/n(?:o)?\)\s*$|\btrust\b.*\?|\bupdate\b.*\?|\bproceed\b.*\?|\boverwrite\b.*\?|\bcontinue\b.*\?|\ballow\b.*\?|Do you want to|Would you like to|Are you sure|trust.*folder/i;
const INTERACTIVE_CHOICE_PROMPT_PATTERN =
  /\bchoose an option\b|\buse arrow keys(?:\s+to\s+cycle)?\b|\bselect an option\b/i;
const SHORTCUT_HINT_PATTERN =
  /\bbypass permissions?\b|\bshift\+tab(?:\s+to\s+cycle)?\b|\btab(?:\s+to\s+cycle)?\b/i;

// The final alternative also strips ESC= / ESC> (DECKPAM/DECKPNM keypad modes,
// emitted by zsh's zle at every prompt) so they cannot leave literal '='/'>'
// residue as the last visible detection line.
const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[=>@-_]`,
  'g',
);
const TERMINAL_REDRAW_BOUNDARY_PATTERN = new RegExp(
  String.raw`\u001b(?:\[[0-?]*[ -/]*[ABCDGHJKSTdfmrsu]|[78])`,
  'g',
);
const DETECTION_TAIL_MAX = 65_536;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

export function getVisibleTerminalTextForDetection(text: string): string {
  return (
    stripAnsi(text.replace(TERMINAL_REDRAW_BOUNDARY_PATTERN, '\n'))
      .replace(/\r/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

export function looksLikePromptLine(line: string): boolean {
  const stripped = stripAnsi(line).trimEnd();
  if (stripped.length === 0) return false;
  return (
    PROMPT_PATTERNS.some((pattern) => pattern.test(stripped)) ||
    looksLikeCodexPromptLine(stripped) ||
    isCommonShellPromptLine(stripped)
  );
}

export function looksLikeCodexPromptLine(line: string): boolean {
  const stripped = stripAnsi(line).trimEnd();
  if (!CODEX_PROMPT_LINE_PATTERN.test(stripped)) {
    return false;
  }

  const promptText = stripped.replace(/^\s*›\s*/u, '');
  if (promptText.length === 0) {
    return true;
  }

  return !QUESTION_PATTERN.test(promptText);
}

export function isNonBlockingShortcutHintLine(line: string): boolean {
  return SHORTCUT_HINT_PATTERN.test(stripAnsi(line).trimEnd());
}

export function hasHydraPromptInTail(tail: string): boolean {
  if (tail.length === 0) return false;
  const visibleTail = getVisibleTerminalTextForDetection(tail).slice(-DETECTION_TAIL_MAX);
  return HYDRA_READY_TAIL_PATTERN.test(visibleTail);
}

function getRecentVisibleLinesFromTail(tail: string): string[] {
  return getRecentVisibleLines(getVisibleTerminalTextForDetection(tail));
}

export function hasReadyPromptInTail(tail: string): boolean {
  if (tail.length === 0) return false;
  const lines = getRecentVisibleLinesFromTail(tail);
  return lines.some((line) => looksLikePromptLine(line));
}

export function hasCodexPromptInTail(tail: string): boolean {
  if (tail.length === 0) return false;
  const lines = getRecentVisibleLinesFromTail(tail);
  return lines.some((line) => looksLikeCodexPromptLine(line));
}

export function hasShellPromptReadyInTail(tail: string): boolean {
  if (tail.length === 0) return false;
  const lines = getRecentVisibleLinesFromTail(tail);
  if (hasSplitArrowPromptInRecentLines(lines)) {
    return true;
  }

  const lastLine = lines[lines.length - 1]?.trimEnd() ?? '';
  if (lastLine.length === 0) {
    return false;
  }

  return !lineLooksLikeQuestion(lastLine) && looksLikeShellPromptLine(lastLine);
}

export function chunkContainsAgentPrompt(stripped: string): boolean {
  if (stripped.length === 0) return false;
  return hasReadyPromptInTail(stripped);
}

export function normalizeForComparison(text: string): string {
  return (
    stripAnsi(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function getRecentVisibleLines(visibleTail: string): string[] {
  return visibleTail
    .slice(-DETECTION_TAIL_MAX)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function lineLooksLikeQuestion(line: string): boolean {
  const trimmed = line.trimEnd();
  return (
    trimmed.length > 0 &&
    (QUESTION_PATTERN.test(trimmed) || INTERACTIVE_CHOICE_PROMPT_PATTERN.test(trimmed))
  );
}

function getLastMatchingLineIndex(
  lines: readonly string[],
  matcher: (line: string) => boolean,
): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && matcher(line)) {
      return index;
    }
  }

  return -1;
}

function isCommonShellPromptLine(line: string): boolean {
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) {
    return false;
  }

  return (
    /^\s*[$#]\s*$/u.test(trimmed) ||
    /^\s*%\s*$/u.test(trimmed) ||
    /^\s*➜(?:\s+\S+)+\s*$/u.test(trimmed) ||
    /^\s*[\w.@~:/-]+[$#]\s*$/u.test(trimmed) ||
    /^\s*[\w./~:-]+\s%\s*$/u.test(trimmed)
  );
}

function looksLikeShellPromptLine(line: string): boolean {
  const stripped = stripAnsi(line).trimEnd();
  if (stripped.length === 0) {
    return false;
  }

  return (
    PROMPT_PATTERNS.some((pattern) => pattern.test(stripped)) || isCommonShellPromptLine(stripped)
  );
}

function hasSplitArrowPromptInRecentLines(lines: readonly string[]): boolean {
  const lastLine = lines[lines.length - 1]?.trimEnd() ?? '';
  const previousLine = lines[lines.length - 2]?.trimEnd() ?? '';
  if (!/^\s*➜\s*$/u.test(previousLine)) {
    return false;
  }

  if (lineLooksLikeQuestion(lastLine)) {
    return false;
  }

  return looksLikePromptPathSegment(lastLine);
}

function looksLikePromptPathSegment(line: string): boolean {
  const trimmed = stripAnsi(line).trimEnd();
  if (trimmed.length === 0) {
    return false;
  }

  return /^(?:~|[\w./:@+-]+)(?:\s+git:\([^)]+\))?(?:\s+[✗*])?$/u.test(trimmed);
}

function isBarePromptLine(line: string): boolean {
  return /^\s*(?:[➜❯›]|hydra(?:\[[^\]\r\n]+\])?>)\s*$/i.test(line.trimEnd());
}

export function looksLikeQuestionInVisibleTail(visibleTail: string): boolean {
  const lines = getRecentVisibleLines(visibleTail);
  if (lines.length === 0) return false;

  const lastQuestionIndex = getLastMatchingLineIndex(lines, lineLooksLikeQuestion);
  if (lastQuestionIndex < 0) {
    return false;
  }

  // A real prompt observed after stale question prose is newer evidence. This
  // scans the bounded visible tail rather than only the final few lines, so a
  // carriage-return redraw or deep status footer cannot latch question state.
  // Prompt-adjacent selection dialogs are recovered by the dedicated choice
  // check below and therefore remain conservative blockers.
  const lastPromptIndex = getLastMatchingLineIndex(lines, looksLikePromptLine);
  if (lastPromptIndex > lastQuestionIndex) {
    return false;
  }

  const lastLine = lines[lines.length - 1];
  if (!lastLine) return false;

  if (isBarePromptLine(lastLine)) {
    return false;
  }

  return true;
}

export function hasPromptAdjacentInteractiveChoiceInVisibleTail(visibleTail: string): boolean {
  const lines = getRecentVisibleLines(visibleTail);
  if (lines.length === 0) {
    return false;
  }

  const lastPromptIndex = getLastMatchingLineIndex(lines, isBarePromptLine);
  const index = lastPromptIndex >= 0 ? lastPromptIndex - 1 : lines.length - 1;

  if (index < 0) {
    return false;
  }

  const terminalLine = lines[index];
  if (!terminalLine) {
    return false;
  }

  return INTERACTIVE_CHOICE_PROMPT_PATTERN.test(terminalLine.trimEnd());
}

export function looksLikeQuestion(tail: string): boolean {
  const visibleTail = getVisibleTerminalTextForDetection(tail);
  if (hasPromptAdjacentInteractiveChoiceInVisibleTail(visibleTail)) {
    return true;
  }

  return looksLikeQuestionInVisibleTail(visibleTail);
}

export function looksLikeTrustDialogInVisibleTail(visibleTail: string): boolean {
  const lines = getRecentVisibleLines(visibleTail);
  return lines.some((line) => {
    const trimmed = line.trimEnd();
    return TRUST_PATTERNS.some((pattern) => pattern.test(trimmed));
  });
}

export function hasTrustExclusionKeywords(visibleTail: string): boolean {
  return TRUST_EXCLUSION_KEYWORDS.test(visibleTail.slice(-500));
}

export function isTrustQuestionAutoHandled(tail: string, autoTrustEnabled: boolean): boolean {
  const visible = getVisibleTerminalTextForDetection(tail);
  if (!autoTrustEnabled) return false;
  if (!looksLikeTrustDialogInVisibleTail(visible)) return false;
  if (hasTrustExclusionKeywords(visible)) return false;

  const lines = getRecentVisibleLines(visible);
  return !lines.some((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
    if (TRUST_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
    return lineLooksLikeQuestion(trimmed);
  });
}

export function clearsQuestionState(text: string): boolean {
  const visible = getVisibleTerminalTextForDetection(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim();
  if (visible.length === 0) return false;
  if (looksLikeQuestion(visible)) return false;

  const lines = visible.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  return !looksLikePromptLine(lines[lines.length - 1] ?? '');
}
