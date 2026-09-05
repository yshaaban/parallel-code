import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBrowserPrimaryFindChord } from '../browser/harness/browser-platform';

function createEvaluatingPage(): Page {
  return {
    evaluate: async (callback: () => unknown) => callback(),
  } as unknown as Page;
}

describe('browser platform test helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows the production user-agent rule when navigator.platform contradicts it', async () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
    });

    await expect(getBrowserPrimaryFindChord(createEvaluatingPage())).resolves.toBe('Control+f');
  });
});
