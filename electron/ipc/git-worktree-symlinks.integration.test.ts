import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorktree } from './git-worktree.js';
import {
  applyRequestedWorktreeSymlinks,
  encodeTaskWorktreeLinkRequestV1,
  escapeWorktreeSymlinkNameForGitExclude,
} from './git-worktree-symlinks.js';

const temporaryRoots = new Set<string>();

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function createRepository(ignoreLines: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-worktree-links-'));
  temporaryRoots.add(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'parallel-code-tests@example.com']);
  git(root, ['config', 'user.name', 'Parallel Code Tests']);
  fs.writeFileSync(path.join(root, '.gitignore'), `${ignoreLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n', 'utf8');
  git(root, ['add', '.gitignore', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function assertLinkPointsTo(linkPath: string, sourcePath: string): void {
  expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath))).toBe(
    path.resolve(sourcePath),
  );
}

afterEach(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  temporaryRoots.clear();
});

describe('worktree link safety with real Git repositories', () => {
  it('links legal ignored roots, fixes directory-only ignore rules, and preserves .claude policy', async () => {
    const root = createRepository(['node_modules/', 'foo..bar/', '.claude/', '.env']);
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'package.txt'), 'shared\n');
    fs.mkdirSync(path.join(root, 'foo..bar'));
    fs.writeFileSync(path.join(root, 'foo..bar', 'cache.txt'), 'shared\n');
    fs.mkdirSync(path.join(root, '.claude', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'shared.md'), 'shared\n');
    fs.writeFileSync(path.join(root, '.claude', 'plans', 'local.md'), 'local\n');
    fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{}\n');
    fs.writeFileSync(path.join(root, '.env'), 'SHARED=true\n');

    const result = await createWorktree(
      root,
      'task/safe-links',
      encodeTaskWorktreeLinkRequestV1(['node_modules', 'foo..bar', '.claude', '.env']),
    );

    expect(result.symlink_warnings).toBeUndefined();
    assertLinkPointsTo(path.join(result.path, 'node_modules'), path.join(root, 'node_modules'));
    assertLinkPointsTo(path.join(result.path, 'foo..bar'), path.join(root, 'foo..bar'));
    assertLinkPointsTo(path.join(result.path, '.env'), path.join(root, '.env'));
    expect(fs.lstatSync(path.join(result.path, '.claude')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(result.path, '.claude')).isSymbolicLink()).toBe(false);
    assertLinkPointsTo(
      path.join(result.path, '.claude', 'shared.md'),
      path.join(root, '.claude', 'shared.md'),
    );
    expect(fs.existsSync(path.join(result.path, '.claude', 'plans'))).toBe(false);
    expect(fs.existsSync(path.join(result.path, '.claude', 'settings.local.json'))).toBe(false);

    const commonDirectory = git(root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).trimEnd();
    const commonExclude = fs.readFileSync(path.join(commonDirectory, 'info', 'exclude'), 'utf8');
    expect(commonExclude).toContain('\n/node_modules\n');
    expect(commonExclude).toContain('\n/foo..bar\n');
    expect(commonExclude).toContain('\n/.env\n');
    expect(commonExclude).not.toContain('\n/.claude\n');
    expect(git(result.path, ['status', '--porcelain', '-z'])).toBe('');
    expect(() =>
      git(result.path, ['check-ignore', '--no-index', '-q', 'node_modules']),
    ).not.toThrow();
  });

  it('turns forged, unsafe, source-symlink, and destination-collision requests into warnings', async () => {
    const root = createRepository(['source-link', 'collision/']);
    const sourceTarget = path.join(root, 'source-target');
    fs.mkdirSync(sourceTarget);
    fs.symlinkSync(sourceTarget, path.join(root, 'source-link'), 'dir');
    fs.mkdirSync(path.join(root, 'collision'));
    const worktree = await createWorktree(
      root,
      'task/warnings',
      encodeTaskWorktreeLinkRequestV1([]),
    );
    fs.writeFileSync(path.join(worktree.path, 'collision'), 'owned by worktree\n');

    const { warnings } = await applyRequestedWorktreeSymlinks(
      root,
      worktree.path,
      encodeTaskWorktreeLinkRequestV1(['source-link', 'collision', 'forged-cache', '../escape']),
    );

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '../escape', reason: 'invalid_name' }),
        expect.objectContaining({ name: 'collision', reason: 'destination_exists' }),
        expect.objectContaining({ name: 'forged-cache', reason: 'not_current_candidate' }),
        expect.objectContaining({ name: 'source-link', reason: 'source_symlink' }),
      ]),
    );
    expect(warnings).toHaveLength(4);
    expect(fs.readFileSync(path.join(worktree.path, 'collision'), 'utf8')).toBe(
      'owned by worktree\n',
    );
    expect(fs.existsSync(path.join(worktree.path, 'source-link'))).toBe(false);
    expect(fs.existsSync(path.join(worktree.path, 'forged-cache'))).toBe(false);
  });

  it('preserves Git-reported casing while protecting folded .claude local entries', async () => {
    const root = createRepository(['.claude/']);
    git(root, ['config', 'core.ignorecase', 'true']);
    fs.mkdirSync(path.join(root, '.CLAUDE'));
    fs.mkdirSync(path.join(root, '.CLAUDE', 'Plans'));
    fs.writeFileSync(path.join(root, '.CLAUDE', 'Settings.Local.JSON'), '{}\n');
    fs.writeFileSync(path.join(root, '.CLAUDE', 'shared.md'), 'shared\n');

    const result = await createWorktree(
      root,
      'task/folded-claude',
      encodeTaskWorktreeLinkRequestV1(['.claude']),
    );

    expect(result.symlink_warnings).toBeUndefined();
    expect(fs.readdirSync(path.join(result.path, '.CLAUDE'))).toEqual(['shared.md']);
    assertLinkPointsTo(
      path.join(result.path, '.CLAUDE', 'shared.md'),
      path.join(root, '.CLAUDE', 'shared.md'),
    );
  });

  it('handles unusual literal root names and never replaces an ignored tracked path', async () => {
    const literalNames = ['#cache', '!cache', 'a*b?[c]', 'tab\tcache', 'trail  ', 'é-cache'];
    const root = createRepository([
      '/\\#cache',
      '/\\!cache',
      '/a\\*b\\?\\[c\\]',
      '/tab\tcache',
      '/trail\\ \\ ',
      '/é-cache',
      '/tracked-cache',
    ]);
    for (const name of literalNames) {
      fs.mkdirSync(path.join(root, name));
    }
    fs.mkdirSync(path.join(root, 'tracked-cache'));
    fs.writeFileSync(path.join(root, 'tracked-cache', 'tracked.txt'), 'tracked\n');
    git(root, ['add', '-f', 'tracked-cache/tracked.txt']);
    git(root, ['commit', '-qm', 'tracked ignored fixture']);

    const result = await createWorktree(
      root,
      'task/literal-links',
      encodeTaskWorktreeLinkRequestV1([...literalNames, 'tracked-cache']),
    );

    expect(result.symlink_warnings).toEqual([
      expect.objectContaining({ name: 'tracked-cache', reason: 'not_current_candidate' }),
    ]);
    for (const name of literalNames) {
      assertLinkPointsTo(path.join(result.path, name), path.join(root, name));
    }
    expect(fs.lstatSync(path.join(result.path, 'tracked-cache')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(result.path, 'tracked-cache')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(result.path, 'tracked-cache', 'tracked.txt'), 'utf8')).toBe(
      'tracked\n',
    );
    expect(git(result.path, ['status', '--porcelain', '-z'])).toBe('');

    const commonDirectory = git(root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).trimEnd();
    const commonExclude = fs.readFileSync(path.join(commonDirectory, 'info', 'exclude'), 'utf8');
    for (const name of literalNames) {
      expect(commonExclude).toContain(`${escapeWorktreeSymlinkNameForGitExclude(name)}\n`);
    }
  });

  it('discovers project, common, and configured global ignore sources', async () => {
    const root = createRepository(['project-cache/']);
    const globalExcludePath = path.join(root, 'global-excludes');
    fs.writeFileSync(globalExcludePath, '/global-cache\n', 'utf8');
    git(root, ['config', 'core.excludesFile', globalExcludePath]);
    fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/common-cache\n');
    for (const name of ['project-cache', 'common-cache', 'global-cache']) {
      fs.mkdirSync(path.join(root, name));
    }

    const result = await createWorktree(
      root,
      'task/all-ignore-sources',
      encodeTaskWorktreeLinkRequestV1(['project-cache', 'common-cache', 'global-cache']),
    );

    expect(result.symlink_warnings).toBeUndefined();
    for (const name of ['project-cache', 'common-cache', 'global-cache']) {
      assertLinkPointsTo(path.join(result.path, name), path.join(root, name));
    }
    expect(git(result.path, ['status', '--porcelain', '-z'])).toBe('');
  });

  it('serializes concurrent common-exclude appends and keeps each literal rule idempotent', async () => {
    const root = createRepository(['cache/']);
    fs.mkdirSync(path.join(root, 'cache'));
    const first = await createWorktree(
      root,
      'task/concurrent-a',
      encodeTaskWorktreeLinkRequestV1([]),
    );
    const second = await createWorktree(
      root,
      'task/concurrent-b',
      encodeTaskWorktreeLinkRequestV1([]),
    );
    const request = encodeTaskWorktreeLinkRequestV1(['cache']);

    const results = await Promise.all([
      applyRequestedWorktreeSymlinks(root, first.path, request),
      applyRequestedWorktreeSymlinks(root, second.path, request),
    ]);

    expect(results).toEqual([{ warnings: [] }, { warnings: [] }]);
    assertLinkPointsTo(path.join(first.path, 'cache'), path.join(root, 'cache'));
    assertLinkPointsTo(path.join(second.path, 'cache'), path.join(root, 'cache'));
    const commonDirectory = git(root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).trimEnd();
    const lines = fs
      .readFileSync(path.join(commonDirectory, 'info', 'exclude'), 'utf8')
      .split(/\r?\n/u);
    expect(
      lines.filter((line) => line === escapeWorktreeSymlinkNameForGitExclude('cache')),
    ).toHaveLength(1);
  });

  it('never follows a common exclude symlink or creates a link without a durable rule', async () => {
    const root = createRepository(['cache/']);
    fs.mkdirSync(path.join(root, 'cache'));
    const worktree = await createWorktree(
      root,
      'task/exclude-symlink',
      encodeTaskWorktreeLinkRequestV1([]),
    );
    const excludePath = path.join(root, '.git', 'info', 'exclude');
    const sentinelPath = path.join(root, 'exclude-sentinel.txt');
    fs.writeFileSync(sentinelPath, 'sentinel\n', 'utf8');
    fs.rmSync(excludePath);
    fs.symlinkSync(sentinelPath, excludePath, 'file');

    const result = await applyRequestedWorktreeSymlinks(
      root,
      worktree.path,
      encodeTaskWorktreeLinkRequestV1(['cache']),
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({ name: 'cache', reason: 'exclude_update_failed' }),
    ]);
    expect(fs.readFileSync(sentinelPath, 'utf8')).toBe('sentinel\n');
    expect(fs.existsSync(path.join(worktree.path, 'cache'))).toBe(false);
  });

  it('never follows a symlinked common info directory or writes outside the repository', async () => {
    const root = createRepository(['cache/']);
    fs.mkdirSync(path.join(root, 'cache'));
    const worktree = await createWorktree(
      root,
      'task/info-directory-symlink',
      encodeTaskWorktreeLinkRequestV1([]),
    );
    const externalDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'parallel-code-external-git-info-'),
    );
    temporaryRoots.add(externalDirectory);
    const externalSentinel = path.join(externalDirectory, 'sentinel.txt');
    fs.writeFileSync(externalSentinel, 'sentinel\n', 'utf8');

    const infoDirectory = path.join(root, '.git', 'info');
    fs.rmSync(infoDirectory, { force: true, recursive: true });
    fs.symlinkSync(
      externalDirectory,
      infoDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await applyRequestedWorktreeSymlinks(
      root,
      worktree.path,
      encodeTaskWorktreeLinkRequestV1(['cache']),
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({ name: 'cache', reason: 'exclude_update_failed' }),
    ]);
    expect(fs.readFileSync(externalSentinel, 'utf8')).toBe('sentinel\n');
    expect(fs.existsSync(path.join(externalDirectory, 'exclude'))).toBe(false);
    expect(fs.existsSync(path.join(worktree.path, 'cache'))).toBe(false);
  });
});
