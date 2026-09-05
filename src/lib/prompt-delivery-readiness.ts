import type { AgentSupervisionState } from '../domain/server-state.js';
import {
  TASK_INITIAL_PROMPT_EVIDENCE_MAX_BYTES,
  TASK_INITIAL_PROMPT_QUIESCENCE_MS,
  TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS,
  sha256Hex,
} from '../domain/task-initial-prompt-delivery.js';
import {
  getVisibleTerminalTextForDetection,
  hasPromptAdjacentInteractiveChoiceInVisibleTail,
  looksLikePromptLine,
  looksLikeQuestionInVisibleTail,
  stripAnsi,
} from './prompt-detection.js';

export type PromptDeliveryEvidenceKind =
  | 'startup'
  | 'ready'
  | 'busy'
  | 'awaiting-input'
  | 'delivered'
  | 'absence-proven';

export interface PromptDeliveryReadyCandidate {
  generation: number;
  normalizedFrameFingerprint: string;
  observedAtMs: number;
}

export interface PromptDeliveryPostWriteEvidence {
  activityTransitionObserved: boolean;
  promptPrefix: string;
  returnedToReadySnapshot: boolean;
}

export interface PromptDeliveryEvidenceInput {
  generation: number;
  lastOutputAtMs: number;
  nowMs: number;
  postWrite?: PromptDeliveryPostWriteEvidence;
  previousReadyCandidate?: PromptDeliveryReadyCandidate;
  supervisionState: AgentSupervisionState;
  tail: string;
}

export interface PromptDeliveryEvidenceClassification {
  cappedByteLength: number;
  kind: PromptDeliveryEvidenceKind;
  normalizedFrame: string;
  readyCandidate?: PromptDeliveryReadyCandidate;
}

// eslint-disable-next-line no-control-regex
const CLEAR_OR_HOME_BOUNDARY = /\u001b\[(?:[0-3]?J|H|f|1;1H|1;1f)|\u001bc/gu;
const MCP_STARTUP_PATTERN =
  /\b(?:starting|initializing|loading|connecting)\b[^\r\n]*\bmcp servers?\b|\bmcp servers?\b[^\r\n]*\b(?:starting|initializing|loading|connecting)\b/iu;
const DETECTION_WINDOW_CODE_UNITS = 8_192;

function trailingCodePointWidth(text: string, end: number): { bytes: number; codeUnits: number } {
  const last = text.charCodeAt(end - 1);
  if (last >= 0xdc00 && last <= 0xdfff && end >= 2) {
    const previous = text.charCodeAt(end - 2);
    if (previous >= 0xd800 && previous <= 0xdbff) return { bytes: 4, codeUnits: 2 };
  }
  if (last <= 0x7f) return { bytes: 1, codeUnits: 1 };
  if (last <= 0x7ff) return { bytes: 2, codeUnits: 1 };
  // TextEncoder replaces an unpaired surrogate with U+FFFD, also three bytes.
  return { bytes: 3, codeUnits: 1 };
}

/**
 * Bounds work before normalization. Walk the already-bounded suffix once and
 * account for UTF-8 directly, avoiding a 64 KiB encode/allocation on every
 * readiness observation while preserving TextEncoder's surrogate semantics.
 */
export function capPromptDeliveryEvidence(
  text: string,
  maxBytes = TASK_INITIAL_PROMPT_EVIDENCE_MAX_BYTES,
): { byteLength: number; text: string } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Prompt-delivery evidence byte limit must be a non-negative safe integer');
  }
  if (maxBytes === 0 || text.length === 0) return { byteLength: 0, text: '' };

  const candidate = text.slice(-Math.min(text.length, maxBytes));
  let byteLength = 0;
  let start = candidate.length;
  while (start > 0) {
    const width = trailingCodePointWidth(candidate, start);
    if (byteLength + width.bytes > maxBytes) break;
    byteLength += width.bytes;
    start -= width.codeUnits;
  }
  return { byteLength, text: candidate.slice(start) };
}

function textAfterLastClearOrHome(text: string): { boundaryObserved: boolean; text: string } {
  let boundaryEnd = -1;
  for (const match of text.matchAll(CLEAR_OR_HOME_BOUNDARY)) {
    boundaryEnd = (match.index ?? 0) + match[0].length;
  }
  return boundaryEnd < 0
    ? { boundaryObserved: false, text }
    : { boundaryObserved: true, text: text.slice(boundaryEnd) };
}

function normalizeCarriageReturnRedraws(text: string): string {
  return text
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}

function createClassification(
  kind: PromptDeliveryEvidenceKind,
  cappedByteLength: number,
  normalizedFrame: string,
  readyCandidate?: PromptDeliveryReadyCandidate,
): PromptDeliveryEvidenceClassification {
  return {
    cappedByteLength,
    kind,
    normalizedFrame,
    ...(readyCandidate ? { readyCandidate } : {}),
  };
}

function hasNormalizedPromptEcho(frame: string, promptPrefix: string): boolean {
  const normalizedPrefix = normalizeVisibleFrame(stripAnsi(promptPrefix)).slice(0, 80);
  return normalizedPrefix.length > 0 && normalizeVisibleFrame(frame).includes(normalizedPrefix);
}

function normalizeVisibleFrame(frame: string): string {
  return (
    frame
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
  );
}

function hasQuestionInVisibleFrame(frame: string): boolean {
  const relevantTail = frame.slice(-8_192);
  return (
    hasPromptAdjacentInteractiveChoiceInVisibleTail(relevantTail) ||
    looksLikeQuestionInVisibleTail(relevantTail)
  );
}

function hasReadyPromptInVisibleFrame(frame: string): boolean {
  const lines = frame.slice(-8_192).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && looksLikePromptLine(line)) return true;
  }
  return false;
}

export function classifyPromptDeliveryEvidence(
  input: PromptDeliveryEvidenceInput,
): PromptDeliveryEvidenceClassification {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('Prompt-delivery generation must be a non-negative safe integer');
  }
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.lastOutputAtMs)) {
    throw new Error('Prompt-delivery evidence timestamps must be finite');
  }

  const capped = capPromptDeliveryEvidence(input.tail);
  // A flood can fill the bounded evidence buffer. Classification remains
  // conservative over the newest frame-sized window instead of repeatedly
  // normalizing all 64 KiB; authoritative activity is supplied separately.
  const detectionTail = capped.text.slice(-DETECTION_WINDOW_CODE_UNITS);
  const currentFrame = textAfterLastClearOrHome(detectionTail);
  const redrawNormalized = normalizeCarriageReturnRedraws(currentFrame.text);
  const visibleFrame = getVisibleTerminalTextForDetection(redrawNormalized);
  const normalizedFrame = normalizeVisibleFrame(visibleFrame);

  if (input.supervisionState === 'awaiting-input' || hasQuestionInVisibleFrame(visibleFrame)) {
    return createClassification('awaiting-input', capped.byteLength, normalizedFrame);
  }

  if (input.postWrite) {
    if (
      input.postWrite.activityTransitionObserved ||
      hasNormalizedPromptEcho(visibleFrame, input.postWrite.promptPrefix)
    ) {
      return createClassification('delivered', capped.byteLength, normalizedFrame);
    }
  }

  const blankAfterRedraw = currentFrame.boundaryObserved && normalizedFrame.length === 0;
  const startupMessageVisible = MCP_STARTUP_PATTERN.test(visibleFrame.slice(-8_192));
  const promptVisible = !blankAfterRedraw && hasReadyPromptInVisibleFrame(visibleFrame);
  const supervisionReady = input.supervisionState === 'idle-at-prompt';
  if (!promptVisible || !supervisionReady) {
    return createClassification(
      startupMessageVisible || normalizedFrame.length === 0 || blankAfterRedraw
        ? 'startup'
        : 'busy',
      capped.byteLength,
      normalizedFrame,
    );
  }

  const candidate: PromptDeliveryReadyCandidate = {
    generation: input.generation,
    normalizedFrameFingerprint: sha256Hex(normalizedFrame),
    observedAtMs: input.nowMs,
  };
  const previous = input.previousReadyCandidate;
  const stable =
    previous !== undefined &&
    previous.generation === input.generation &&
    previous.normalizedFrameFingerprint === candidate.normalizedFrameFingerprint &&
    input.nowMs - previous.observedAtMs >= TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS;
  const quiescent = input.nowMs - input.lastOutputAtMs >= TASK_INITIAL_PROMPT_QUIESCENCE_MS;
  if (!stable || !quiescent) {
    return createClassification('startup', capped.byteLength, normalizedFrame, candidate);
  }

  if (input.postWrite?.returnedToReadySnapshot) {
    return createClassification('absence-proven', capped.byteLength, normalizedFrame, candidate);
  }
  return createClassification('ready', capped.byteLength, normalizedFrame, candidate);
}
