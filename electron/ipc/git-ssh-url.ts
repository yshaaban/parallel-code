/**
 * Parsing and validation for git SSH clone URLs.
 *
 * Supports two forms:
 *   SCP-style:  git@host:group/repo.git
 *   URI-style:  ssh://git@host:2222/group/repo.git
 */

/** SCP-style: git@host:path (colon separates host from path, no slash after colon as first char) */
const SCP_PATTERN = /^git@[a-zA-Z0-9._-]+:[a-zA-Z0-9._/-]+(?:\.git)?$/;

/** URI-style: ssh://[user@]host[:port]/path */
const SSH_URI_PATTERN =
  /^ssh:\/\/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+(:\d+)?\/[a-zA-Z0-9._/-]+(?:\.git)?$/;

export function isGitSshUrl(url: string): boolean {
  const trimmed = url.trim();
  return SCP_PATTERN.test(trimmed) || SSH_URI_PATTERN.test(trimmed);
}

export interface GitSshHost {
  hostname: string;
  port: number;
}

export function parseGitSshHost(url: string): GitSshHost | null {
  const trimmed = url.trim();

  if (trimmed.startsWith('ssh://')) {
    // ssh://user@host:port/path or ssh://user@host/path
    const withoutScheme = trimmed.slice('ssh://'.length);
    const atIndex = withoutScheme.indexOf('@');
    if (atIndex < 0) return null;
    const afterAt = withoutScheme.slice(atIndex + 1);
    const slashIndex = afterAt.indexOf('/');
    const hostPort = slashIndex >= 0 ? afterAt.slice(0, slashIndex) : afterAt;
    const colonIndex = hostPort.indexOf(':');
    if (colonIndex >= 0) {
      const hostname = hostPort.slice(0, colonIndex);
      const port = parseInt(hostPort.slice(colonIndex + 1), 10);
      return hostname && !isNaN(port) ? { hostname, port } : null;
    }
    return hostPort ? { hostname: hostPort, port: 22 } : null;
  }

  if (SCP_PATTERN.test(trimmed)) {
    // git@host:path — host is between @ and :
    const atIndex = trimmed.indexOf('@');
    const colonIndex = trimmed.indexOf(':');
    if (atIndex < 0 || colonIndex < 0) return null;
    const hostname = trimmed.slice(atIndex + 1, colonIndex);
    return hostname ? { hostname, port: 22 } : null;
  }

  return null;
}

export function deriveRepoNameFromSshUrl(url: string): string {
  const trimmed = url.trim();

  let pathname: string;
  if (trimmed.startsWith('ssh://')) {
    // URI-style: ssh://git@host:port/group/repo.git — pathname is everything after host[:port]
    const withoutScheme = trimmed.slice('ssh://'.length);
    const slashIndex = withoutScheme.indexOf('/');
    pathname = slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : '';
  } else {
    // SCP-style: git@host:group/repo.git — pathname is everything after the colon
    const colonIndex = trimmed.indexOf(':');
    pathname = colonIndex >= 0 ? trimmed.slice(colonIndex + 1) : '';
  }

  const basename = pathname.split('/').pop() ?? '';
  return basename.replace(/\.git$/, '');
}
