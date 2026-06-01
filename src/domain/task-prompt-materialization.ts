export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

const PROMPT_SUBMIT_DELAY_BASE_MS = 25;
const PROMPT_SUBMIT_DELAY_PER_EXTRA_LINE_MS = 8;
const PROMPT_SUBMIT_DELAY_MAX_MS = 400;

export interface MaterializedPromptWrite {
  data: string;
  delayAfterMs: number;
}

export interface MaterializedPromptDispatch {
  writes: MaterializedPromptWrite[];
}

function getPromptLineCount(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  return text.split('\n').length;
}

export function getPromptSubmitDelayMs(text: string): number {
  const extraLines = Math.max(0, getPromptLineCount(text) - 1);
  return Math.min(
    PROMPT_SUBMIT_DELAY_MAX_MS,
    PROMPT_SUBMIT_DELAY_BASE_MS + extraLines * PROMPT_SUBMIT_DELAY_PER_EXTRA_LINE_MS,
  );
}

export function toBracketedPastePayload(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

export function shouldUseBracketedPaste(text: string): boolean {
  return text.includes('\n');
}

export function materializePromptDispatch(text: string): MaterializedPromptDispatch {
  if (!shouldUseBracketedPaste(text)) {
    return {
      writes: [{ data: `${text}\r`, delayAfterMs: 0 }],
    };
  }

  return {
    writes: [
      { data: toBracketedPastePayload(text), delayAfterMs: getPromptSubmitDelayMs(text) },
      { data: '\r', delayAfterMs: 0 },
    ],
  };
}
