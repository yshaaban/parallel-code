const TRUST_PATTERNS: RegExp[] = [/\btrust\b.*\?/i, /\ballow\b.*\?/i, /trust.*folder/i];

const TRUST_EXCLUSION_KEYWORDS =
  /\b(delet|remov|credential|secret|password|key|token|destro|format|drop)/i;

const PROMPT_PATTERNS: RegExp[] = [
  /❯\s*$/,
  /hydra(?:\[[^\]\r\n]+\])?>\s*$/i,
  /(?:^|\s)\$\s*$/,
  /(?:^|\s)%\s*$/,
  /(?:^|\s)#\s*$/,
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
];

const AGENT_READY_TAIL_PATTERNS: RegExp[] = [/❯/, /›/];
const HYDRA_READY_TAIL_PATTERN = /(?:^|[\r\n])\s*hydra(?:\[[^\]\r\n]+\])?>\s*(?:[\r\n]|$)/i;

const QUESTION_PATTERN =
  /\[Y\/n\]\s*$|\[y\/N\]\s*$|\(y(?:es)?\/n(?:o)?\)\s*$|\btrust\b.*\?|\bupdate\b.*\?|\bproceed\b.*\?|\boverwrite\b.*\?|\bcontinue\b.*\?|\ballow\b.*\?|Do you want to|Would you like to|Are you sure|trust.*folder/i;

export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
    '',
  );
}

export function looksLikePromptLine(line: string): boolean {
  const stripped = stripAnsi(line).trimEnd();
  if (stripped.length === 0) return false;
  return PROMPT_PATTERNS.some((pattern) => pattern.test(stripped));
}

export function hasHydraPromptInTail(tail: string): boolean {
  if (tail.length === 0) return false;
  const stripped = stripAnsi(tail).slice(-300);
  return HYDRA_READY_TAIL_PATTERN.test(stripped);
}

export function hasReadyPromptInTail(tail: string): boolean {
  if (tail.length === 0) return false;
  const stripped = stripAnsi(tail);
  const recentTail = stripped.slice(-200);
  if (AGENT_READY_TAIL_PATTERNS.some((pattern) => pattern.test(recentTail))) {
    return true;
  }
  return HYDRA_READY_TAIL_PATTERN.test(recentTail.slice(-300));
}

export function chunkContainsAgentPrompt(stripped: string): boolean {
  if (stripped.length === 0) return false;
  const recentTail = stripped.slice(-200);
  if (AGENT_READY_TAIL_PATTERNS.some((pattern) => pattern.test(recentTail))) {
    return true;
  }
  return HYDRA_READY_TAIL_PATTERN.test(recentTail.slice(-300));
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
    .slice(-500)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function lineLooksLikeQuestion(line: string): boolean {
  const trimmed = line.trimEnd();
  return trimmed.length > 0 && QUESTION_PATTERN.test(trimmed);
}

export function looksLikeQuestionInVisibleTail(visibleTail: string): boolean {
  const lines = getRecentVisibleLines(visibleTail);
  if (lines.length === 0) return false;

  const lastLine = lines[lines.length - 1].trimEnd();
  if (/^\s*(?:[❯›]|hydra(?:\[[^\]\r\n]+\])?>)\s*$/i.test(lastLine)) {
    return false;
  }

  return lines.some(lineLooksLikeQuestion);
}

export function looksLikeQuestion(tail: string): boolean {
  return looksLikeQuestionInVisibleTail(stripAnsi(tail));
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
  const visible = stripAnsi(tail);
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
  const visible = stripAnsi(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim();
  if (visible.length === 0) return false;
  if (looksLikeQuestion(visible)) return false;

  const lines = visible.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  return !looksLikePromptLine(lines[lines.length - 1] ?? '');
}
