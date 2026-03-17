function normalizeBasePath(pathname) {
  if (!pathname || pathname === '/') {
    return '';
  }

  return pathname.replace(/\/+$/, '');
}

function resolveServerUrl(baseUrl, relativePath) {
  const url = new globalThis.URL(baseUrl);
  const basePath = normalizeBasePath(url.pathname);
  url.hash = '';
  url.search = '';
  url.pathname = `${basePath}${relativePath}` || '/';
  return url;
}

function resolveAuthToken(authToken) {
  const resolved = authToken ?? process.env.AUTH_TOKEN;
  if (!resolved) {
    throw new Error('Missing auth token. Pass --auth-token or set AUTH_TOKEN.');
  }

  return resolved;
}

export function normalizeServerBaseUrl(serverUrl) {
  const url = new globalThis.URL(serverUrl);
  url.hash = '';
  url.search = '';
  const basePath = normalizeBasePath(url.pathname);
  url.pathname = basePath || '/';
  return url.toString();
}

export function createBrowserServerClient({ authToken, serverUrl }) {
  const baseUrl = normalizeServerBaseUrl(serverUrl);
  const resolvedAuthToken = resolveAuthToken(authToken);

  async function invokeIpc(channel, body) {
    const response = await fetch(resolveServerUrl(baseUrl, `/api/ipc/${channel}`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolvedAuthToken}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `${channel} failed (${response.status}): ${payload.error ?? 'unknown error'}`,
      );
    }

    return payload.result;
  }

  function createWebSocketUrl() {
    const url = resolveServerUrl(baseUrl, '/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', resolvedAuthToken);
    return url.toString();
  }

  return {
    authToken: resolvedAuthToken,
    baseUrl,
    createWebSocketUrl,
    invokeIpc,
  };
}
