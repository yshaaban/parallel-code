import { describe, expect, it, vi } from 'vitest';

import { applyLoginShellEnvironment, resolveUserShell } from './user-shell.js';

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

describe('applyLoginShellEnvironment', () => {
  function createExecFileSync(output: string): typeof import('child_process').execFileSync {
    return vi.fn(() => output) as unknown as typeof import('child_process').execFileSync;
  }

  it('merges the login shell environment into the current process environment', () => {
    const env = {
      PATH: '/usr/bin:/bin',
    };
    const execFileSync = createExecFileSync(
      'noise before__PCODE_ENV__PATH=/opt/homebrew/bin:/usr/bin\0SSH_AUTH_SOCK=/tmp/agent.sock\0__PCODE_ENV__noise after',
    );

    applyLoginShellEnvironment({
      env,
      execFileSync,
      platform: 'darwin',
      resolveShell: () => '/bin/zsh',
    });

    expect(execFileSync).toHaveBeenCalledWith(
      '/bin/zsh',
      [
        '-ilc',
        `printf '__PCODE_ENV__' && perl -e 'print "$_=$ENV{$_}\\0" for keys %ENV' && printf '__PCODE_ENV__'`,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      },
    );
    expect(env).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
  });

  it('does not overwrite environment variables owned by the Electron runtime', () => {
    const env = {
      NODE_OPTIONS: '--original',
      PATH: '/usr/bin:/bin',
    };

    applyLoginShellEnvironment({
      env,
      execFileSync: createExecFileSync(
        '__PCODE_ENV__NODE_OPTIONS=--from-shell\0LD_PRELOAD=/tmp/libhook.so\0PATH=/custom/bin\0__PCODE_ENV__',
      ),
      platform: 'linux',
      resolveShell: () => '/bin/bash',
    });

    expect(env).toEqual({
      NODE_OPTIONS: '--original',
      PATH: '/custom/bin',
    });
  });

  it('does nothing on Windows', () => {
    const env = {
      PATH: 'C:\\Windows\\System32',
    };
    const execFileSync = createExecFileSync(
      '__PCODE_ENV__PATH=C:\\Users\\test\\bin\0__PCODE_ENV__',
    );

    applyLoginShellEnvironment({
      env,
      execFileSync,
      platform: 'win32',
      resolveShell: () => 'cmd.exe',
    });

    expect(execFileSync).not.toHaveBeenCalled();
    expect(env).toEqual({
      PATH: 'C:\\Windows\\System32',
    });
  });

  it('warns and keeps the original environment when login shell capture fails', () => {
    const env = {
      PATH: '/usr/bin:/bin',
    };
    const error = new Error('shell failed');
    const warn = vi.fn();
    const execFileSync = vi.fn(() => {
      throw error;
    }) as unknown as typeof import('child_process').execFileSync;

    applyLoginShellEnvironment({
      env,
      execFileSync,
      platform: 'linux',
      resolveShell: () => '/bin/bash',
      warn,
    });

    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
    });
    expect(warn).toHaveBeenCalledWith('[fixEnv] Failed to resolve login shell environment:', error);
  });
});
