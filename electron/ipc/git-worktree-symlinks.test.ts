import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execGitBufferMock, execGitMock } = vi.hoisted(() => ({
  execGitBufferMock: vi.fn(),
  execGitMock: vi.fn(),
}));

vi.mock('./git-exec.js', () => ({
  execGit: execGitMock,
  execGitBuffer: execGitBufferMock,
}));

import {
  MAX_WORKTREE_SYMLINK_REQUEST_BYTES,
  WorktreeSymlinkSafetyError,
  applyRequestedWorktreeSymlinks,
  assertTaskWorktreeLinkRequestV1,
  encodeTaskWorktreeLinkRequestV1,
  escapeWorktreeSymlinkNameForGitExclude,
  getDefaultWorktreeSymlinkCandidateNames,
  getWorktreeSymlinkCandidates,
  isReservedWorktreeSymlinkName,
  isValidWorktreeSymlinkName,
  normalizeGitExcludeLine,
} from './git-worktree-symlinks.js';
import { BadRequestError } from './errors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function fixedLengthName(index: number, byteLength: number): string {
  const prefix = `${index.toString(16).padStart(2, '0')}-`;
  return `${prefix}${'x'.repeat(byteLength - prefix.length)}`;
}

function exactBoundaryNames(lastLength: number): string[] {
  return [
    ...Array.from({ length: 63 }, (_, index) => fixedLengthName(index, 255)),
    fixedLengthName(63, lastLength),
  ];
}

describe('TaskWorktreeLinkRequestV1', () => {
  it('encodes the exact V1 layout in unsigned UTF-8 order', () => {
    const request = encodeTaskWorktreeLinkRequestV1(['é', 'a', 'é']);

    expect(request.format).toBe(1);
    expect(request.names).toEqual(['a', 'é']);
    expect([...request.encodedBytes]).toEqual([
      0x01, 0x02, 0x00, 0x01, 0x61, 0x00, 0x02, 0xc3, 0xa9,
    ]);
    expect(request.encodedLength).toBe(9);
  });

  it('is invariant to input order and exact duplicate names', () => {
    const first = encodeTaskWorktreeLinkRequestV1(['z', 'a', 'z', 'b']);
    const reordered = encodeTaskWorktreeLinkRequestV1(['b', 'z', 'a']);

    expect(first.names).toEqual(['a', 'b', 'z']);
    expect(first.encodedBytes).toEqual(reordered.encodedBytes);
  });

  it('keeps byte-distinct case and Unicode forms distinct', () => {
    const request = encodeTaskWorktreeLinkRequestV1(['é', 'é', 'A', 'a']);

    expect(request.names).toEqual(['A', 'a', 'é', 'é']);
    expect(request.encodedBytes[1]).toBe(4);
  });

  it('accepts 0 and 128 canonical names but rejects 129 raw duplicates before deduplication', () => {
    expect(encodeTaskWorktreeLinkRequestV1([]).encodedBytes).toEqual(Uint8Array.from([0x01, 0x00]));
    const maxCount = encodeTaskWorktreeLinkRequestV1(
      Array.from({ length: 128 }, (_, index) => `entry-${index}`),
    );
    expect(maxCount.encodedBytes[1]).toBe(128);

    expect(() => encodeTaskWorktreeLinkRequestV1(Array(129).fill('same'))).toThrowError(
      BadRequestError,
    );
  });

  it('uses UTF-8 byte length for the 1..255 byte name boundary', () => {
    const maxName = `${'é'.repeat(127)}a`;
    const request = encodeTaskWorktreeLinkRequestV1([maxName]);

    expect(request.encodedLength).toBe(2 + 2 + 255);
    expect(() => encodeTaskWorktreeLinkRequestV1([''])).toThrowError(BadRequestError);
    expect(() => encodeTaskWorktreeLinkRequestV1(['é'.repeat(128)])).toThrowError(BadRequestError);
  });

  it('accepts exactly 16,384 canonical bytes and rejects one byte more', () => {
    const exact = encodeTaskWorktreeLinkRequestV1(exactBoundaryNames(189));
    expect(exact.encodedLength).toBe(MAX_WORKTREE_SYMLINK_REQUEST_BYTES);

    expect(() => encodeTaskWorktreeLinkRequestV1(exactBoundaryNames(190))).toThrowError(
      /canonical V1 encoding must be at most 16384 bytes/u,
    );
  });

  it('rejects non-string entries even for direct JavaScript callers', () => {
    expect(() =>
      encodeTaskWorktreeLinkRequestV1(['valid', 42] as unknown as string[]),
    ).toThrowError(/every symlinkDirs entry must be a string/u);
  });

  it('rejects malformed Unicode instead of aliasing it to a replacement-character name', () => {
    expect(() => encodeTaskWorktreeLinkRequestV1(['\ud800'])).toThrowError(
      /must contain valid Unicode scalars/u,
    );
    expect(() => encodeTaskWorktreeLinkRequestV1(['\udc00'])).toThrowError(
      /must contain valid Unicode scalars/u,
    );
    expect(encodeTaskWorktreeLinkRequestV1(['\ud83d\ude80']).names).toEqual(['🚀']);
  });

  it('rejects owner-branded bytes with mismatched names, count, lengths, or trailing data', () => {
    const base = encodeTaskWorktreeLinkRequestV1(['a', 'b']);
    const invalidRequests = [
      { ...base, names: ['b', 'a'] },
      { ...base, encodedBytes: Uint8Array.from([0x01, 0x01, 0x00, 0x01, 0x61]) },
      { ...base, encodedBytes: Uint8Array.from([0x01, 0x02, 0x00, 0x02, 0x61, 0x00, 0x01, 0x62]) },
      {
        ...encodeTaskWorktreeLinkRequestV1([]),
        encodedBytes: Uint8Array.from([0x01, 0x00, 0xff]),
        encodedLength: 3,
      },
    ];

    for (const request of invalidRequests) {
      expect(() => assertTaskWorktreeLinkRequestV1(request)).toThrowError(
        'Invalid canonical TaskWorktreeLinkRequestV1',
      );
    }
  });

  it('rejects a byte-consistent request whose entries are not strictly sorted and unique', () => {
    const ownerBrand = encodeTaskWorktreeLinkRequestV1([]);
    const descending = {
      ...ownerBrand,
      encodedBytes: Uint8Array.from([0x01, 0x02, 0x00, 0x01, 0x62, 0x00, 0x01, 0x61]),
      encodedLength: 8,
      names: ['b', 'a'],
    };
    const duplicate = {
      ...descending,
      encodedBytes: Uint8Array.from([0x01, 0x02, 0x00, 0x01, 0x61, 0x00, 0x01, 0x61]),
      names: ['a', 'a'],
    };

    expect(() => assertTaskWorktreeLinkRequestV1(descending)).toThrowError(
      'Invalid canonical TaskWorktreeLinkRequestV1',
    );
    expect(() => assertTaskWorktreeLinkRequestV1(duplicate)).toThrowError(
      'Invalid canonical TaskWorktreeLinkRequestV1',
    );
  });

  it('rejects a branded request mutated to contain malformed Unicode', () => {
    const branded = encodeTaskWorktreeLinkRequestV1(['�']);
    const malformed = { ...branded, names: ['\ud800'] };

    expect(() => assertTaskWorktreeLinkRequestV1(malformed)).toThrowError(
      'Invalid canonical TaskWorktreeLinkRequestV1',
    );
  });
});

describe('worktree link name and exclude policy', () => {
  it.each([
    ['foo..bar', true],
    ['#cache', true],
    ['a b', true],
    ['.', false],
    ['..', false],
    ['', false],
    ['nested/path', false],
    ['nested\\path', false],
    ['line\nname', false],
    ['line\rname', false],
    ['nul\0name', false],
    ['\ud800', false],
    ['\udc00', false],
    ['\ud83d\ude80', true],
  ])('validates %j as %s', (name, expected) => {
    expect(isValidWorktreeSymlinkName(name)).toBe(expected);
  });

  it('folds reserved names only when Git reports ignorecase', () => {
    expect(isReservedWorktreeSymlinkName('.git', false)).toBe(true);
    expect(isReservedWorktreeSymlinkName('.GIT', false)).toBe(false);
    expect(isReservedWorktreeSymlinkName('.GIT', true)).toBe(true);
    expect(isReservedWorktreeSymlinkName('.WORKTREES', true)).toBe(true);
  });

  it.each([
    ['plain', '/plain'],
    ['#cache', '/\\#cache'],
    ['!cache', '/\\!cache'],
    ['a*b?[c]d', '/a\\*b\\?\\[c\\]d'],
    ['name  ', '/name\\ \\ '],
    ['tab\tname', '/tab\tname'],
  ])('escapes the literal Git exclude rule for %j', (name, expected) => {
    expect(escapeWorktreeSymlinkNameForGitExclude(name)).toBe(expected);
  });

  it.each([
    ['rule\r', 'rule'],
    ['rule  ', 'rule'],
    ['rule\\ ', 'rule\\ '],
    ['rule\\  ', 'rule\\ '],
    ['rule\\\\ ', 'rule\\\\'],
    [' leading\t', ' leading\t'],
  ])('normalizes Git exclude line %j', (line, expected) => {
    expect(normalizeGitExcludeLine(line)).toBe(expected);
  });
});

describe('worktree link discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execGitMock.mockResolvedValue({ stderr: '', stdout: 'true\n' });
  });

  it('discovers bounded root entries with defaults first and two Git processes', async () => {
    const dynamicNames = Array.from({ length: 130 }, (_, index) => `zz-cache-${index}`);
    execGitBufferMock.mockResolvedValue({
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(
        [
          ...dynamicNames,
          '.env',
          '.ENV',
          '.GIT',
          '.worktrees',
          'nested/path',
          'foo..bar/',
          '',
        ].join('\0'),
        'utf8',
      ),
    });

    const result = await getWorktreeSymlinkCandidates('/repo');

    expect(result.candidates).toHaveLength(128);
    expect(result.truncated).toBe(true);
    expect(result.candidates[0]).toEqual({ isDefault: true, name: '.ENV' });
    expect(result.candidates).toContainEqual({ isDefault: false, name: 'foo..bar' });
    expect(result.candidates.some(({ name }) => name === '.GIT')).toBe(false);
    expect(result.candidates.some(({ name }) => name.includes('/'))).toBe(false);
    expect(execGitMock).toHaveBeenCalledOnce();
    expect(execGitBufferMock).toHaveBeenCalledOnce();
    expect(execGitBufferMock).toHaveBeenCalledWith(
      [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '--',
        ':(top,glob)*',
        ':(top,glob).*',
      ],
      expect.objectContaining({ cwd: '/repo', maxBuffer: 10 * 1024 * 1024, timeout: 3_000 }),
    );
  });

  it('keeps the legacy renderer query limited to curated defaults', async () => {
    execGitMock.mockRejectedValue(new Error('core.ignorecase is unset'));
    execGitBufferMock.mockResolvedValue({
      stderr: Buffer.alloc(0),
      stdout: Buffer.from('.env\0node_modules/\0project-cache/\0', 'utf8'),
    });

    await expect(getDefaultWorktreeSymlinkCandidateNames('/repo')).resolves.toEqual([
      '.env',
      'node_modules',
    ]);
  });

  it('drops non-UTF-8 Git path bytes instead of aliasing them to a replacement name', async () => {
    execGitBufferMock.mockResolvedValue({
      stderr: Buffer.alloc(0),
      stdout: Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from('valid-cache\0', 'utf8')]),
    });

    await expect(getWorktreeSymlinkCandidates('/repo')).resolves.toEqual({
      candidates: [{ isDefault: false, name: 'valid-cache' }],
      truncated: false,
    });
  });
});

describe('worktree link postconditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createApplyFixture(): {
    commonDirectory: string;
    projectRoot: string;
    temporaryRoot: string;
    worktreePath: string;
  } {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'parallel-code-worktree-link-policy-'),
    );
    const projectRoot = path.join(temporaryRoot, 'project');
    const worktreePath = path.join(temporaryRoot, 'worktree');
    const commonDirectory = path.join(temporaryRoot, 'common');
    fs.mkdirSync(path.join(projectRoot, 'cache'), { recursive: true });
    fs.mkdirSync(worktreePath);
    fs.mkdirSync(path.join(commonDirectory, 'info'), { recursive: true });
    fs.writeFileSync(path.join(commonDirectory, 'info', 'exclude'), '', 'utf8');
    return { commonDirectory, projectRoot, temporaryRoot, worktreePath };
  }

  function mockApplyGit(commonDirectory: string, checkIgnoreResult: Buffer | Error): void {
    execGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'config') {
        return { stderr: '', stdout: 'false\n' };
      }
      if (args[0] === 'rev-parse') {
        return { stderr: '', stdout: `${commonDirectory}\n` };
      }
      throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    });
    execGitBufferMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'ls-files') {
        return { stderr: Buffer.alloc(0), stdout: Buffer.from('cache/\0') };
      }
      if (args[0] === 'check-ignore') {
        if (checkIgnoreResult instanceof Error) {
          throw checkIgnoreResult;
        }
        return { stderr: Buffer.alloc(0), stdout: checkIgnoreResult };
      }
      throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    });
  }

  it('does no Git or filesystem discovery for an empty canonical request', async () => {
    await expect(
      applyRequestedWorktreeSymlinks(
        '/missing-project',
        '/missing-worktree',
        encodeTaskWorktreeLinkRequestV1([]),
      ),
    ).resolves.toEqual({ warnings: [] });
    expect(execGitMock).not.toHaveBeenCalled();
    expect(execGitBufferMock).not.toHaveBeenCalled();
  });

  it('returns one bounded query warning per canonical exact name when discovery fails', async () => {
    execGitMock.mockResolvedValue({ stderr: '', stdout: 'false\n' });
    execGitBufferMock.mockRejectedValue(new Error('discovery failed'));

    await expect(
      applyRequestedWorktreeSymlinks(
        '/missing-project',
        '/missing-worktree',
        encodeTaskWorktreeLinkRequestV1(['z', 'a', 'z']),
      ),
    ).resolves.toEqual({
      warnings: [
        expect.objectContaining({ name: 'a', reason: 'candidate_query_failed' }),
        expect.objectContaining({ name: 'z', reason: 'candidate_query_failed' }),
      ],
    });
  });

  it('uses ignorecase only to reduce later policy outcomes', async () => {
    execGitMock.mockResolvedValue({ stderr: '', stdout: 'true\n' });
    execGitBufferMock.mockResolvedValue({
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });

    const result = await applyRequestedWorktreeSymlinks(
      '/missing-project',
      '/missing-worktree',
      encodeTaskWorktreeLinkRequestV1(['a', 'A']),
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({ name: 'A', reason: 'not_current_candidate' }),
    ]);
  });

  it('removes a generic link that Git does not prove ignored', async () => {
    const fixture = createApplyFixture();
    mockApplyGit(fixture.commonDirectory, Buffer.alloc(0));

    try {
      const result = await applyRequestedWorktreeSymlinks(
        fixture.projectRoot,
        fixture.worktreePath,
        encodeTaskWorktreeLinkRequestV1(['cache']),
      );

      expect(result.warnings).toEqual([
        expect.objectContaining({ name: 'cache', reason: 'ignore_postcondition_failed' }),
      ]);
      expect(fs.existsSync(path.join(fixture.worktreePath, 'cache'))).toBe(false);
      expect(execGitMock).toHaveBeenCalledTimes(2);
      expect(execGitBufferMock).toHaveBeenCalledTimes(2);
      expect(execGitBufferMock).toHaveBeenLastCalledWith(
        ['check-ignore', '--no-index', '-z', '--stdin'],
        expect.objectContaining({
          cwd: fixture.worktreePath,
          input: Buffer.from('cache\0'),
        }),
      );
    } finally {
      fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
    }
  });

  it('makes ambiguous removal of an unproved link fatal', async () => {
    const fixture = createApplyFixture();
    mockApplyGit(fixture.commonDirectory, new Error('check-ignore failed'));
    vi.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(new Error('unlink failed'));

    try {
      await expect(
        applyRequestedWorktreeSymlinks(
          fixture.projectRoot,
          fixture.worktreePath,
          encodeTaskWorktreeLinkRequestV1(['cache']),
        ),
      ).rejects.toBeInstanceOf(WorktreeSymlinkSafetyError);
      expect(fs.lstatSync(path.join(fixture.worktreePath, 'cache')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
    }
  });

  it('refuses to remove a same-source link that replaced the app-created target', async () => {
    const fixture = createApplyFixture();
    execGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'config') {
        return { stderr: '', stdout: 'false\n' };
      }
      if (args[0] === 'rev-parse') {
        return { stderr: '', stdout: `${fixture.commonDirectory}\n` };
      }
      throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    });
    execGitBufferMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'ls-files') {
        return { stderr: Buffer.alloc(0), stdout: Buffer.from('cache/\0') };
      }
      if (args[0] === 'check-ignore') {
        const targetPath = path.join(fixture.worktreePath, 'cache');
        fs.unlinkSync(targetPath);
        fs.symlinkSync(path.join(fixture.projectRoot, 'cache'), targetPath, 'dir');
        return { stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
      }
      throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    });

    try {
      await expect(
        applyRequestedWorktreeSymlinks(
          fixture.projectRoot,
          fixture.worktreePath,
          encodeTaskWorktreeLinkRequestV1(['cache']),
        ),
      ).rejects.toBeInstanceOf(WorktreeSymlinkSafetyError);
      expect(fs.lstatSync(path.join(fixture.worktreePath, 'cache')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
    }
  });

  it('cleans only app-created .claude links and treats external target content as fatal', async () => {
    const fixture = createApplyFixture();
    fs.mkdirSync(path.join(fixture.projectRoot, '.claude'));
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude', 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(fixture.projectRoot, '.claude', 'b.txt'), 'b\n');
    execGitMock.mockResolvedValue({ stderr: '', stdout: 'false\n' });
    execGitBufferMock.mockResolvedValue({
      stderr: Buffer.alloc(0),
      stdout: Buffer.from('.claude/\0'),
    });
    const nativeSymlink = fs.promises.symlink.bind(fs.promises);
    let symlinkCalls = 0;
    vi.spyOn(fs.promises, 'symlink').mockImplementation(async (sourcePath, targetPath, type) => {
      symlinkCalls += 1;
      if (symlinkCalls === 2) {
        fs.writeFileSync(path.join(fixture.worktreePath, '.claude', 'external.txt'), 'external\n');
        throw new Error('simulated second link failure');
      }
      await nativeSymlink(sourcePath, targetPath, type);
    });

    try {
      await expect(
        applyRequestedWorktreeSymlinks(
          fixture.projectRoot,
          fixture.worktreePath,
          encodeTaskWorktreeLinkRequestV1(['.claude']),
        ),
      ).rejects.toBeInstanceOf(WorktreeSymlinkSafetyError);
      expect(fs.existsSync(path.join(fixture.worktreePath, '.claude', 'a.txt'))).toBe(false);
      expect(
        fs.readFileSync(path.join(fixture.worktreePath, '.claude', 'external.txt'), 'utf8'),
      ).toBe('external\n');
    } finally {
      fs.rmSync(fixture.temporaryRoot, { force: true, recursive: true });
    }
  });
});
