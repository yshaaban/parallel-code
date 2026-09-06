import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  assertRequiredOption,
  buildRemoteBootstrapUrl,
  loadSmokeEnv,
  parseArgs,
  parseEnvFile,
  readPageBodyText,
  resolveChromiumExecutablePath,
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
  let lastBodyText = '';

  return {
    locator: (selector) => {
      expect(selector).toBe('body');
      return {
        innerText: async () => {
          const nextBodyText = bodyTexts.shift();
          if (nextBodyText !== undefined) {
            lastBodyText = nextBodyText;
          }

          return lastBodyText;
        },
      };
    },
    waitForTimeout: vi.fn(async () => {}),
  };
}

describe('smoke-remote-bootstrap', () => {
  it('uses the local port without inventing authentication when no credential is provided', () => {
    expect(parseArgs([], {})).toEqual({
      authToken: '',
      ignoreHttpsErrors: false,
      serverUrl: 'http://127.0.0.1:43117',
      timeoutMs: 30_000,
    });
  });

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

  it('loads local smoke env values over checked-in defaults', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'parallel-code-smoke-env-'));
    writeFileSync(
      path.join(tempDir, '.env.example'),
      'AUTH_TOKEN=default-token\nSERVER_URL=http://127.0.0.1:43117\n',
      'utf8',
    );
    writeFileSync(path.join(tempDir, '.env'), 'AUTH_TOKEN=local-token\n', 'utf8');

    try {
      expect(loadSmokeEnv(tempDir, {})).toMatchObject({
        AUTH_TOKEN: 'local-token',
        SERVER_URL: 'http://127.0.0.1:43117',
      });
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('honors an explicit Chromium executable override', () => {
    expect(
      resolveChromiumExecutablePath(
        { PLAYWRIGHT_CHROMIUM_EXECUTABLE: '/opt/chrome/chrome' },
        'linux',
      ),
    ).toBe('/opt/chrome/chrome');
  });

  it('parses env files with comments and quoted values', () => {
    expect(
      parseEnvFile(`
AUTH_TOKEN="quoted token"
# comment
SERVER_URL=http://x
`),
    ).toEqual({
      AUTH_TOKEN: 'quoted token',
      SERVER_URL: 'http://x',
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

  it('accepts the current mobile session shell as ready', async () => {
    const page = createBodyTextPage(['Name this mobile session']);

    await expect(waitForRemoteShell(page, 30_000)).resolves.toBeUndefined();
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
