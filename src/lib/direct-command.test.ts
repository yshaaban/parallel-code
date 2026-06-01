import { describe, expect, it } from 'vitest';
import { parseDirectCommandLine } from './direct-command';

describe('parseDirectCommandLine', () => {
  it('splits a direct command with quoted arguments', () => {
    expect(parseDirectCommandLine('codex --model "gpt-5.5 xhigh"')).toEqual({
      invocation: {
        args: ['--model', 'gpt-5.5 xhigh'],
        command: 'codex',
      },
      ok: true,
    });
  });

  it('captures leading environment assignments', () => {
    expect(parseDirectCommandLine('FOO=1 BAR=two codex')).toEqual({
      invocation: {
        args: [],
        command: 'codex',
        env: { BAR: 'two', FOO: '1' },
      },
      ok: true,
    });
  });

  it('supports env-prefixed commands', () => {
    expect(parseDirectCommandLine('env FOO=1 codex --full-auto')).toEqual({
      invocation: {
        args: ['--full-auto'],
        command: 'codex',
        env: { FOO: '1' },
      },
      ok: true,
    });
  });

  it('keeps backslashes literal inside single-quoted arguments', () => {
    expect(parseDirectCommandLine("codex 'C:\\Users\\Name'")).toEqual({
      invocation: {
        args: ['C:\\Users\\Name'],
        command: 'codex',
      },
      ok: true,
    });
  });

  it('rejects unterminated quotes', () => {
    expect(parseDirectCommandLine('codex "unfinished')).toEqual({
      error: {
        message: 'Command has an unterminated quote or escape.',
        reason: 'unterminated',
      },
      ok: false,
    });
  });
});
