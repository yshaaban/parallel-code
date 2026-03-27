import { describe, expect, it } from 'vitest';

import { classifyOutputState, getExitPreview } from './agent-supervision-parser.js';

describe('agent supervision parser', () => {
  it('classifies a prompt-like tail as idle at prompt', () => {
    const result = classifyOutputState(
      '\u001b[32mBuild complete\u001b[0m\nready for next input\n❯ ',
    );

    expect(result).toEqual({
      preview: 'ready for next input',
      state: 'idle-at-prompt',
    });
  });

  it('classifies an interactive question as awaiting input', () => {
    const result = classifyOutputState(
      'Choose an option\nUse arrow keys to cycle\nSelect an option',
    );

    expect(result).toEqual({
      preview: 'Select an option',
      state: 'awaiting-input',
    });
  });

  it('does not treat shortcut-only permission footers as awaiting input', () => {
    const result = classifyOutputState(
      'What would you like to work on?\n⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ',
    );

    expect(result).toEqual({
      preview: 'What would you like to work on?',
      state: 'idle-at-prompt',
    });
  });

  it('keeps Hydra selection prompts in awaiting-input even when the operator prompt is visible', () => {
    const result = classifyOutputState(
      'Use arrow keys to cycle\nSelect an option\nhydra[dispatch]>',
    );

    expect(result).toEqual({
      preview: 'Select an option',
      state: 'awaiting-input',
    });
  });

  it('keeps prompt-ready state when redraw-heavy footer updates follow the prompt', () => {
    const footer =
      '\u001b[s\u001b[1;29r\u001b[29;1H\u001b[30;1H\u001b[2K──────────────────────────────────────────────────────────────\u001b[31;1H\u001b[2K ↻ auto  │  0 tasks                                           \u001b[32;1H\u001b[2K● ✦ GEMINI Inact…  │  ● ֎ CODEX Inacti…  │  ● ❋ CLAUDE Inact…\u001b[33;1H\u001b[2K  ↳ awaiting events...\u001b[34;1H\u001b[2K\u001b[u';
    const result = classifyOutputState(
      `hydra>\u001b[8GDescribe a task to dispatch to agents${footer.repeat(8)}`,
    );

    expect(result).toEqual({
      preview: 'hydra>',
      state: 'idle-at-prompt',
    });
  });

  it('ignores terminal query replies when computing active previews', () => {
    const result = classifyOutputState('\u001b[>0q\u001b[c');

    expect(result).toEqual({
      preview: '',
      state: 'active',
    });
  });

  it('returns the last non-empty exit line as the exit preview', () => {
    expect(getExitPreview(['', 'first line', 'last line'])).toBe('last line');
  });
});
