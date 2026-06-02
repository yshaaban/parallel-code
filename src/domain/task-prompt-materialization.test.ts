import { describe, expect, it } from 'vitest';

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  getPromptSubmitDelayMs,
  materializePromptDispatch,
} from './task-prompt-materialization';

describe('task prompt materialization', () => {
  it('submits single-line prompts as one write with enter', () => {
    expect(materializePromptDispatch('hello')).toEqual({
      writes: [{ data: 'hello\r', delayAfterMs: 0 }],
    });
  });

  it('uses bracketed paste before enter for multiline prompts', () => {
    const prompt = 'line 1\nline 2';

    expect(materializePromptDispatch(prompt)).toEqual({
      writes: [
        {
          data: `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`,
          delayAfterMs: getPromptSubmitDelayMs(prompt),
        },
        { data: '\r', delayAfterMs: 0 },
      ],
    });
  });

  it('caps multiline submit delay for very large prompts', () => {
    const longPrompt = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');

    expect(getPromptSubmitDelayMs(longPrompt)).toBe(400);
  });
});
