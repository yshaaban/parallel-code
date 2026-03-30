/**
 * Parsing and validation for git SSH clone URLs.
 *
 * Supports two forms:
 *   SCP-style:  git@host:group/repo.git
 *   URI-style:  ssh://git@host:2222/group/repo.git
 */

const SCP_PATTERN = /^git@[a-zA-Z0-9._-]+:[a-zA-Z0-9._/-]+(?:\.git)?$/;
const SSH_URI_PATTERN =
  /^ssh:\/\/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+(?::\d+)?\/[a-zA-Z0-9._/-]+(?:\.git)?$/;

export interface GitSshHost {
  hostname: string;
  port: number;
}

function trimGitSshUrl(url: string): string {
  return url.trim();
}

function getGitSshPath(url: string): string {
  if (url.startsWith('ssh://')) {
    const withoutScheme = url.slice('ssh://'.length);
    const slashIndex = withoutScheme.indexOf('/');
    return slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : '';
  }

  const colonIndex = url.indexOf(':');
  return colonIndex >= 0 ? url.slice(colonIndex + 1) : '';
}

export function isGitSshUrl(url: string): boolean {
  const trimmedUrl = trimGitSshUrl(url);
  return SCP_PATTERN.test(trimmedUrl) || SSH_URI_PATTERN.test(trimmedUrl);
}

export function parseGitSshHost(url: string): GitSshHost | null {
  const trimmedUrl = trimGitSshUrl(url);
  if (!isGitSshUrl(trimmedUrl)) {
    return null;
  }

  if (trimmedUrl.startsWith('ssh://')) {
    const withoutScheme = trimmedUrl.slice('ssh://'.length);
    const afterAt = withoutScheme.slice(withoutScheme.indexOf('@') + 1);
    const slashIndex = afterAt.indexOf('/');
    const hostWithPort = slashIndex >= 0 ? afterAt.slice(0, slashIndex) : afterAt;
    const colonIndex = hostWithPort.indexOf(':');
    if (colonIndex < 0) {
      return hostWithPort ? { hostname: hostWithPort, port: 22 } : null;
    }

    const hostname = hostWithPort.slice(0, colonIndex);
    const portValue = Number.parseInt(hostWithPort.slice(colonIndex + 1), 10);
    if (!hostname || Number.isNaN(portValue)) {
      return null;
    }

    return {
      hostname,
      port: portValue,
    };
  }

  const atIndex = trimmedUrl.indexOf('@');
  const colonIndex = trimmedUrl.indexOf(':');
  if (atIndex < 0 || colonIndex < 0) {
    return null;
  }

  const hostname = trimmedUrl.slice(atIndex + 1, colonIndex);
  if (!hostname) {
    return null;
  }

  return {
    hostname,
    port: 22,
  };
}

export function deriveRepoNameFromSshUrl(url: string): string {
  const pathValue = getGitSshPath(trimGitSshUrl(url));
  const repoName = pathValue.split('/').pop() ?? '';
  return repoName.replace(/\.git$/, '');
}
