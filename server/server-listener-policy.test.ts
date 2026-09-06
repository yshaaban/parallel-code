import { describe, expect, it } from 'vitest';
import { resolveBrowserServerHost } from './server-listener-policy.js';

describe('browser server listener policy', () => {
  it('keeps ordinary startup local even when a private token is configured', () => {
    expect(resolveBrowserServerHost({ scopedRemote: false, token: 'private-test-token' })).toBe(
      '127.0.0.1',
    );
  });

  it('treats configured scoped remote access as explicit network intent', () => {
    expect(resolveBrowserServerHost({ scopedRemote: true, token: 'private-test-token' })).toBe(
      '0.0.0.0',
    );
  });

  it.each(['127.0.0.1', '0.0.0.0'] as const)('honors explicit host %s', (host) => {
    expect(
      resolveBrowserServerHost({ host, scopedRemote: true, token: 'private-test-token' }),
    ).toBe(host);
  });

  it.each(['', ' ', 'localhost', '::', '::1', '127.0.0.1 ', 'example.invalid'])(
    'fails closed for unsupported or ambiguous host %j',
    (host) => {
      expect(() =>
        resolveBrowserServerHost({ host, scopedRemote: false, token: 'private-test-token' }),
      ).toThrow('PARALLEL_CODE_SERVER_HOST must be');
    },
  );

  it.each(['', ' ', 'parallel-code-local-browser', ' parallel-code-local-browser '])(
    'rejects empty/public credentials on local and network listeners without echoing them',
    (token) => {
      for (const host of ['127.0.0.1', '0.0.0.0']) {
        expect(() => resolveBrowserServerHost({ host, scopedRemote: false, token })).toThrow(
          'Set a private AUTH_TOKEN or remove it to generate a fresh token.',
        );
      }
    },
  );
});
