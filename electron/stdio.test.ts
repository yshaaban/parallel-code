import { describe, expect, it, vi } from 'vitest';

import { handleStdioPipeError, installStdioEpipeGuard } from './stdio.js';

function createStream(): {
  listeners: Array<(error: NodeJS.ErrnoException) => void>;
  on: (event: 'error', listener: (error: NodeJS.ErrnoException) => void) => void;
} {
  const listeners: Array<(error: NodeJS.ErrnoException) => void> = [];
  return {
    listeners,
    on: vi.fn((event: 'error', listener: (error: NodeJS.ErrnoException) => void) => {
      if (event === 'error') {
        listeners.push(listener);
      }
    }),
  };
}

describe('stdio EPIPE guard', () => {
  it('swallows EPIPE stream errors', () => {
    const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });

    expect(() => handleStdioPipeError(error)).not.toThrow();
  });

  it('rethrows non-EPIPE stream errors', () => {
    const error = Object.assign(new Error('write failed'), { code: 'EINVAL' });

    expect(() => handleStdioPipeError(error)).toThrow(error);
  });

  it('registers the guard on stdout and stderr', () => {
    const stdout = createStream();
    const stderr = createStream();

    installStdioEpipeGuard({ stderr, stdout });

    expect(stdout.on).toHaveBeenCalledWith('error', handleStdioPipeError);
    expect(stderr.on).toHaveBeenCalledWith('error', handleStdioPipeError);
    expect(stdout.listeners).toEqual([handleStdioPipeError]);
    expect(stderr.listeners).toEqual([handleStdioPipeError]);
  });
});
