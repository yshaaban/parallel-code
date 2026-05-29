import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  deriveRepoNameFromSshUrl,
  isGitSshUrl,
  parseGitSshHost,
} from '../../src/lib/git-ssh-url.js';

// ---------------------------------------------------------------------------
// git-ssh-url.ts — URL validation
// ---------------------------------------------------------------------------

describe('isGitSshUrl', () => {
  describe('SCP-style URLs', () => {
    it('accepts standard SCP-style URLs', () => {
      expect(isGitSshUrl('git@github.com:user/repo.git')).toBe(true);
      expect(isGitSshUrl('git@github.com:user/repo')).toBe(true);
      expect(isGitSshUrl('git@gitlab.com:org/sub/repo.git')).toBe(true);
      expect(isGitSshUrl('git@bitbucket.org:team/project.git')).toBe(true);
    });

    it('accepts URLs with leading/trailing whitespace', () => {
      expect(isGitSshUrl('  git@github.com:user/repo.git  ')).toBe(true);
    });
  });

  describe('URI-style SSH URLs', () => {
    it('accepts ssh:// URLs without port', () => {
      expect(isGitSshUrl('ssh://git@github.com/user/repo.git')).toBe(true);
    });

    it('accepts ssh:// URLs with port', () => {
      expect(
        isGitSshUrl(
          'ssh://git@gitlab.humain.com:2222/humain/data-and-ai-modeling/modeling/sautech/triton-inference.git',
        ),
      ).toBe(true);
      expect(isGitSshUrl('ssh://git@example.com:22/user/repo.git')).toBe(true);
    });

    it('accepts ssh:// URLs with leading/trailing whitespace', () => {
      expect(isGitSshUrl('  ssh://git@gitlab.com:2222/org/repo.git  ')).toBe(true);
    });
  });

  describe('rejections', () => {
    it('rejects HTTPS URLs', () => {
      expect(isGitSshUrl('https://github.com/user/repo.git')).toBe(false);
    });

    it('rejects plain paths', () => {
      expect(isGitSshUrl('/home/user/repo')).toBe(false);
      expect(isGitSshUrl('~/repo')).toBe(false);
    });

    it('rejects empty strings', () => {
      expect(isGitSshUrl('')).toBe(false);
      expect(isGitSshUrl('   ')).toBe(false);
    });

    it('rejects URLs with shell metacharacters', () => {
      expect(isGitSshUrl('git@github.com:user/repo;echo hi')).toBe(false);
      expect(isGitSshUrl('git@github.com:user/repo$(cmd)')).toBe(false);
    });

    it('rejects leading-hyphen SSH authorities', () => {
      expect(isGitSshUrl('git@-oProxyCommand=evil:user/repo.git')).toBe(false);
      expect(isGitSshUrl('ssh://-oProxyCommand=evil@github.com/user/repo.git')).toBe(false);
      expect(isGitSshUrl('ssh://git@-oProxyCommand=evil/user/repo.git')).toBe(false);
    });

    it('rejects ssh:// with no path', () => {
      expect(isGitSshUrl('ssh://git@github.com')).toBe(false);
      expect(isGitSshUrl('ssh://git@github.com:2222')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// git-ssh-url.ts — repo name derivation
// ---------------------------------------------------------------------------

describe('deriveRepoNameFromSshUrl', () => {
  it('SCP-style: extracts repo name', () => {
    expect(deriveRepoNameFromSshUrl('git@github.com:user/my-project.git')).toBe('my-project');
    expect(deriveRepoNameFromSshUrl('git@github.com:user/repo')).toBe('repo');
    expect(deriveRepoNameFromSshUrl('git@gitlab.com:org/group/repo.git')).toBe('repo');
  });

  it('URI-style: extracts repo name without port', () => {
    expect(deriveRepoNameFromSshUrl('ssh://git@github.com/user/repo.git')).toBe('repo');
  });

  it('URI-style: extracts repo name with port', () => {
    expect(
      deriveRepoNameFromSshUrl(
        'ssh://git@gitlab.humain.com:2222/humain/data-and-ai-modeling/modeling/sautech/triton-inference.git',
      ),
    ).toBe('triton-inference');
  });
});

// ---------------------------------------------------------------------------
// git-ssh-url.ts — host parsing
// ---------------------------------------------------------------------------

describe('parseGitSshHost', () => {
  it('SCP-style: extracts host with default port', () => {
    expect(parseGitSshHost('git@github.com:user/repo.git')).toEqual({
      hostname: 'github.com',
      port: 22,
    });
  });

  it('URI-style: extracts host with explicit port', () => {
    expect(parseGitSshHost('ssh://git@gitlab.humain.com:2222/group/repo.git')).toEqual({
      hostname: 'gitlab.humain.com',
      port: 2222,
    });
  });

  it('URI-style: defaults to port 22 when no port', () => {
    expect(parseGitSshHost('ssh://git@github.com/user/repo.git')).toEqual({
      hostname: 'github.com',
      port: 22,
    });
  });

  it('returns null for invalid input', () => {
    expect(parseGitSshHost('https://github.com/user/repo.git')).toBeNull();
    expect(parseGitSshHost('/home/user/repo')).toBeNull();
    expect(parseGitSshHost('git@-oProxyCommand=evil:user/repo.git')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// system-handlers.ts — cloneGitRepo workflow
// ---------------------------------------------------------------------------

const { existsSyncMock, mkdirSyncMock, rmSyncMock, execFileAsyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      rmSync: rmSyncMock,
      mkdtempSync: actual.mkdtempSync,
      writeFileSync: actual.writeFileSync,
      unlinkSync: actual.unlinkSync,
    },
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    rmSync: rmSyncMock,
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    },
  };
});

vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util');
  return {
    ...actual,
    promisify: () => execFileAsyncMock,
  };
});

import { cloneGitRepo, isHostKeyVerificationFailure } from './system-handlers.js';

describe('isHostKeyVerificationFailure', () => {
  it('detects host key verification failure message', () => {
    expect(isHostKeyVerificationFailure('Host key verification failed.')).toBe(true);
    expect(isHostKeyVerificationFailure('fatal: something\nHost key verification failed.\n')).toBe(
      true,
    );
  });

  it('does not match other errors', () => {
    expect(isHostKeyVerificationFailure('Permission denied (publickey).')).toBe(false);
    expect(isHostKeyVerificationFailure('Connection refused')).toBe(false);
  });
});

describe('cloneGitRepo', () => {
  it('rejects invalid SSH URLs', async () => {
    await expect(cloneGitRepo('https://github.com/user/repo', '/home/user')).rejects.toThrow(
      'url must be a valid git SSH URL',
    );
  });

  it('rejects when destination already exists', async () => {
    const destination = path.join('/home/user', 'repo');
    existsSyncMock.mockImplementation((p: string) => String(p) === destination);

    await expect(cloneGitRepo('git@github.com:user/repo.git', '/home/user')).rejects.toThrow(
      'Destination already exists',
    );
  });

  it('clones successfully with status cloned', async () => {
    const url = 'git@github.com:user/repo.git';
    const destination = path.join('/home/user', 'repo');

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p) === destination) return false;
      if (String(p) === path.join(destination, '.git')) return true;
      return false;
    });
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await cloneGitRepo(url, '/home/user');

    expect(result).toEqual({ status: 'cloned', repoRoot: destination });
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['clone', url, destination],
      expect.objectContaining({
        env: expect.objectContaining({ GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }),
      }),
    );
  });

  it('passes URI-style SSH URL with port verbatim to git clone', async () => {
    const url = 'ssh://git@gitlab.humain.com:2222/humain/sautech/triton-inference.git';
    const destination = path.join('/home/user', 'triton-inference');

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p) === destination) return false;
      if (String(p) === path.join(destination, '.git')) return true;
      return false;
    });
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await cloneGitRepo(url, '/home/user');

    expect(result).toEqual({ status: 'cloned', repoRoot: destination });
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['clone', url, destination],
      expect.objectContaining({ cwd: '/home/user' }),
    );
  });

  it('returns host_key_confirmation_required on host key failure', async () => {
    const url = 'git@gitlab.example.com:team/repo.git';
    const destination = path.join('/home/user', 'repo');

    existsSyncMock.mockReturnValue(false);
    const hostKeyError = Object.assign(new Error('git clone failed'), {
      stderr: 'Host key verification failed.\nfatal: Could not read from remote repository.',
    });

    // First call: git clone fails with host key error
    // Second call: ssh-keyscan returns fingerprint
    execFileAsyncMock
      .mockRejectedValueOnce(hostKeyError)
      .mockResolvedValueOnce({ stdout: 'gitlab.example.com ssh-ed25519 AAAA...', stderr: '' })
      .mockResolvedValueOnce({ stdout: '256 SHA256:abcdef (ED25519)', stderr: '' });

    const result = await cloneGitRepo(url, '/home/user');

    expect(result).toEqual({
      status: 'host_key_confirmation_required',
      hostname: 'gitlab.example.com',
      port: 22,
      fingerprint: expect.stringContaining('SHA256'),
    });
    expect(rmSyncMock).toHaveBeenCalledWith(destination, { recursive: true, force: true });
  });

  it('retries with StrictHostKeyChecking=accept-new when acceptHostKey is true', async () => {
    const url = 'git@github.com:user/repo.git';
    const destination = path.join('/home/user', 'repo');

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p) === destination) return false;
      if (String(p) === path.join(destination, '.git')) return true;
      return false;
    });
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await cloneGitRepo(url, '/home/user', true);

    expect(result).toEqual({ status: 'cloned', repoRoot: destination });
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['clone', url, destination],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new',
        }),
      }),
    );
  });

  it('propagates non-host-key clone failures as BadRequestError', async () => {
    existsSyncMock.mockReturnValue(false);
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('Permission denied (publickey).'), {
        stderr: 'Permission denied (publickey).',
      }),
    );

    await expect(cloneGitRepo('git@github.com:user/repo.git', '/home/user')).rejects.toThrow(
      'git clone failed: Permission denied',
    );
  });

  it('returns a clear error when git is not installed', async () => {
    existsSyncMock.mockReturnValue(false);
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('spawn git ENOENT'), {
        code: 'ENOENT',
      }),
    );

    await expect(cloneGitRepo('git@github.com:user/repo.git', '/home/user')).rejects.toThrow(
      'git is not installed or not available on PATH',
    );
  });

  it('reports a missing ssh-keyscan tool in the host key confirmation path', async () => {
    const url = 'git@gitlab.example.com:team/repo.git';

    existsSyncMock.mockReturnValue(false);
    const hostKeyError = Object.assign(new Error('git clone failed'), {
      stderr: 'Host key verification failed.\nfatal: Could not read from remote repository.',
    });

    execFileAsyncMock.mockRejectedValueOnce(hostKeyError).mockRejectedValueOnce(
      Object.assign(new Error('spawn ssh-keyscan ENOENT'), {
        code: 'ENOENT',
      }),
    );

    const result = await cloneGitRepo(url, '/home/user');

    expect(result).toEqual({
      status: 'host_key_confirmation_required',
      hostname: 'gitlab.example.com',
      port: 22,
      fingerprint: 'ssh-keyscan is not installed or not available on PATH',
    });
  });

  it('cleans up partial clone directory on non-host-key failure', async () => {
    const destination = path.join('/home/user', 'repo');
    existsSyncMock.mockReturnValue(false);
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('network error'), { stderr: 'network error' }),
    );

    await expect(cloneGitRepo('git@github.com:user/repo.git', '/home/user')).rejects.toThrow(
      'git clone failed',
    );

    expect(rmSyncMock).toHaveBeenCalledWith(destination, { recursive: true, force: true });
  });
});
