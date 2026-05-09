import { describe, expect, it, vi } from 'vitest';

import {
  assertRequiredOption,
  buildRemoteBootstrapUrl,
  parseArgs,
  readPageBodyText,
  waitForRemoteShell,
  waitForRemoteWebSocket,
} from '../../scripts/smoke-remote-bootstrap.mjs';

interface MockPage {
  locator: (selector: string) => {
    innerText: () => Promise<string>;
  };
  waitForTimeout: (timeoutMs: number) => Promise<void>;
}

function createBodyTextPage(texts: string[]): MockPage {
  const bodyTexts = [...texts];

  return {
    locator: (selector) => {
      expect(selector).toBe('body');
      return {
        innerText: async () => bodyTexts.shift() ?? bodyTexts[bodyTexts.length - 1] ?? '',
      };
    },
    waitForTimeout: vi.fn(async () => {}),
  };
}

describe('smoke-remote-bootstrap', () => {
  it('parses remote smoke options from flags and environment defaults', () => {
    expect(parseArgs([], { AUTH_TOKEN: 'env-token', SERVER_URL: 'https://example.test' })).toEqual({
      authToken: 'env-token',
      ignoreHttpsErrors: false,
      serverUrl: 'https://example.test',
      timeoutMs: 30_000,
    });

    expect(
      parseArgs(
        [
          '--server-url',
          'https://override.test/base',
          '--auth-token',
          'flag-token',
          '--ignore-https-errors',
          '--timeout-ms',
          '9000',
        ],
        { AUTH_TOKEN: 'env-token', SERVER_URL: 'https://example.test' },
      ),
    ).toEqual({
      authToken: 'flag-token',
      ignoreHttpsErrors: true,
      serverUrl: 'https://override.test/base',
      timeoutMs: 9000,
    });
  });

  it('requires the deployed server URL and auth token before launching Playwright', () => {
    expect(() => assertRequiredOption('', '--server-url')).toThrow(
      'Missing --server-url. Provide it as --server-url <value>',
    );
    expect(() => assertRequiredOption('token', '--auth-token')).not.toThrow();
  });

  it('builds the authenticated remote shell bootstrap URL', () => {
    expect(buildRemoteBootstrapUrl('https://example.test/app/', 'token with space')).toBe(
      'https://example.test/remote?token=token+with+space',
    );
  });

  it('waits for the remote shell instead of passing on an initial blank body', async () => {
    const page = createBodyTextPage(['', 'Parallel Code']);

    await expect(waitForRemoteShell(page, 30_000)).resolves.toBeUndefined();
    expect(page.waitForTimeout).toHaveBeenCalledWith(100);
  });

  it('fails when the remote shell renders the auth fallback', async () => {
    const page = createBodyTextPage(['Not authenticated']);

    await expect(waitForRemoteShell(page, 30_000)).rejects.toThrow(
      'Remote shell rendered the auth fallback instead of the remote app.',
    );
  });

  it('waits for the remote websocket after the shell is visible', async () => {
    const page = createBodyTextPage([]);
    const isReady = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(waitForRemoteWebSocket(isReady, page, 30_000)).resolves.toBeUndefined();
    expect(page.waitForTimeout).toHaveBeenCalledWith(100);
  });

  it('treats body read failures as an empty body for diagnostic reporting', async () => {
    const page: MockPage = {
      locator: () => ({
        innerText: async () => {
          throw new Error('body unavailable');
        },
      }),
      waitForTimeout: vi.fn(async () => {}),
    };

    await expect(readPageBodyText(page)).resolves.toBe('');
  });
});
