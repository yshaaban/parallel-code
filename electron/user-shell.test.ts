import { describe, expect, it } from 'vitest';

import { resolveUserShell } from './user-shell.js';

const mockUserInfo = {
  gid: 20,
  homedir: '/home/test-user',
  uid: 501,
  username: 'test-user',
};

function allowShells(...shells: string[]): (shell: string) => boolean {
  return (shell: string) => shells.includes(shell);
}

describe('resolveUserShell', () => {
  it('prefers the OS account shell over the inherited SHELL env var', () => {
    const shell = resolveUserShell({
      canUseShell: allowShells('/bin/zsh', '/bin/bash'),
      env: { SHELL: '/bin/bash' },
      platform: 'darwin',
      userInfo: () => ({
        ...mockUserInfo,
        shell: '/bin/zsh',
      }),
    });

    expect(shell).toBe('/bin/zsh');
  });

  it('falls back to SHELL when the OS lookup has no shell', () => {
    const shell = resolveUserShell({
      canUseShell: allowShells('/opt/homebrew/bin/bash'),
      env: { SHELL: '/opt/homebrew/bin/bash' },
      platform: 'darwin',
      userInfo: () => ({
        ...mockUserInfo,
        shell: '',
      }),
    });

    expect(shell).toBe('/opt/homebrew/bin/bash');
  });

  it('falls back to SHELL when the OS lookup throws', () => {
    const shell = resolveUserShell({
      canUseShell: allowShells('/bin/zsh'),
      env: { SHELL: '/bin/zsh' },
      platform: 'linux',
      userInfo: () => {
        throw new Error('unavailable');
      },
    });

    expect(shell).toBe('/bin/zsh');
  });

  it('falls back to SHELL when the OS shell is not executable', () => {
    const shell = resolveUserShell({
      canUseShell: allowShells('/bin/bash'),
      env: { SHELL: '/bin/bash' },
      platform: 'linux',
      userInfo: () => ({
        ...mockUserInfo,
        shell: '/missing/zsh',
      }),
    });

    expect(shell).toBe('/bin/bash');
  });

  it('falls back to /bin/sh on POSIX when neither OS nor env provides a usable shell', () => {
    const shell = resolveUserShell({
      canUseShell: allowShells(),
      env: { SHELL: '/missing/bash' },
      platform: 'linux',
      userInfo: () => ({
        ...mockUserInfo,
        shell: '/missing/zsh',
      }),
    });

    expect(shell).toBe('/bin/sh');
  });
});
