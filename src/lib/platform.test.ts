import { describe, expect, it } from 'vitest';

import { isMacUserAgent } from './platform';

describe('platform', () => {
  it('uses the user agent as the platform authority when legacy platform metadata contradicts it', () => {
    const navigatorSnapshot = {
      platform: 'MacIntel',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
    };

    expect(navigatorSnapshot.platform).toBe('MacIntel');
    expect(isMacUserAgent(navigatorSnapshot.userAgent)).toBe(false);
  });

  it('recognizes a macOS user agent', () => {
    expect(
      isMacUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
      ),
    ).toBe(true);
  });
});
