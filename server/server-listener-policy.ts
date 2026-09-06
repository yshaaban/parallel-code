/** Listener and credential policy is shared by configured startup and direct host composition. */
export type BrowserServerHost = '127.0.0.1' | '0.0.0.0';

const RETIRED_DEVELOPMENT_TOKEN = 'parallel-code-local-browser';

export function resolveBrowserServerHost(options: {
  host?: string;
  scopedRemote: boolean;
  token: string;
}): BrowserServerHost {
  if (!options.token.trim() || options.token.trim() === RETIRED_DEVELOPMENT_TOKEN) {
    throw new Error(
      'Set a private AUTH_TOKEN or remove it to generate a fresh token. The public development token is no longer accepted.',
    );
  }

  const host = options.host ?? (options.scopedRemote ? '0.0.0.0' : '127.0.0.1');
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('PARALLEL_CODE_SERVER_HOST must be 127.0.0.1 or 0.0.0.0.');
  }
  return host;
}
