import { describe, expect, it } from 'vitest';

import {
  cleanCopiedTerminalText,
  reflowWrappedParagraphs,
  stripTrailingWhitespacePerLine,
} from './copy-text';

describe('terminal copy text cleanup', () => {
  it('strips trailing whitespace from each line without changing leading whitespace', () => {
    expect(stripTrailingWhitespacePerLine('  one  \n\ttwo\t\nthree')).toBe('  one\n\ttwo\nthree');
  });

  it('reflows wrapped prose while preserving the first line indent', () => {
    const input = [
      "  Let me know if you'd like to commit this or want a   ",
      '  different change instead.',
    ].join('\n');

    expect(reflowWrappedParagraphs(input)).toBe(
      "  Let me know if you'd like to commit this or want a different change instead.",
    );
  });

  it('leaves short intentional line breaks intact', () => {
    const input = ['  first short line', '  second short line', '  third short line'].join('\n');

    expect(reflowWrappedParagraphs(input)).toBe(input);
  });

  it('preserves long intentional line breaks without terminal padding', () => {
    const input = [
      'const firstCommand = "this is intentionally long enough to look like wrapping";',
      'const secondCommand = "but it is a separate line and must stay separate";',
    ].join('\n');

    expect(reflowWrappedParagraphs(input)).toBe(input);
  });

  it('keeps blank lines as paragraph separators', () => {
    const input = [
      'A long paragraph line that should join with the next line.   ',
      'continued tail.',
      '',
      'short line',
    ].join('\n');

    expect(reflowWrappedParagraphs(input)).toBe(
      [
        'A long paragraph line that should join with the next line. continued tail.',
        '',
        'short line',
      ].join('\n'),
    );
  });

  it('normalizes line endings, strips padding, and reflows copied terminal text', () => {
    const input =
      "  Let me know if you'd like to commit this or want a   \r\n" +
      '  different change instead.                          \r' +
      '\r\n  Tail.   ';

    expect(cleanCopiedTerminalText(input)).toBe(
      "  Let me know if you'd like to commit this or want a different change instead.\n\n  Tail.",
    );
  });
});
