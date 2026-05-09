import { describe, expect, it, vi } from 'vitest';

import {
  cleanReleaseOutput,
  getReleaseBuildSteps,
  runReleaseBuild,
} from '../../scripts/build-release.mjs';

describe('build-release', () => {
  it('keeps browser/server artifacts before Electron packaging and verification', () => {
    expect(getReleaseBuildSteps(['--publish', 'never'])).toEqual([
      {
        args: ['run', 'prepare:browser-artifacts'],
        command: 'npm',
        label: 'prepare browser artifacts',
      },
      {
        args: ['run', 'compile'],
        command: 'npm',
        label: 'compile Electron adapter',
      },
      {
        args: ['electron-builder', '--publish', 'never'],
        command: 'npx',
        label: 'package Electron adapter',
      },
      {
        args: ['run', 'verify:electron-package'],
        command: 'npm',
        label: 'verify Electron package',
      },
    ]);
  });

  it('forwards release workflow flags only to electron-builder', async () => {
    const cleanReleaseOutputFn = vi.fn(async () => {});
    const runCommand = vi.fn(async () => ({ code: 0, signal: null }));

    const result = await runReleaseBuild({
      cleanReleaseOutputFn,
      electronBuilderArgs: ['--universal', '--publish', 'never'],
      runCommand,
    });

    expect(result).toEqual({ code: 0, signal: null });
    expect(cleanReleaseOutputFn.mock.invocationCallOrder[0]).toBeLessThan(
      runCommand.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(runCommand).toHaveBeenNthCalledWith(1, 'npm', ['run', 'prepare:browser-artifacts']);
    expect(runCommand).toHaveBeenNthCalledWith(2, 'npm', ['run', 'compile']);
    expect(runCommand).toHaveBeenNthCalledWith(3, 'npx', [
      'electron-builder',
      '--universal',
      '--publish',
      'never',
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(4, 'npm', ['run', 'verify:electron-package']);
  });

  it('stops before verification when packaging fails', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, signal: null })
      .mockResolvedValueOnce({ code: 0, signal: null })
      .mockResolvedValueOnce({ code: 1, signal: null });

    const result = await runReleaseBuild({
      electronBuilderArgs: ['--publish', 'never'],
      runCommand,
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it('cleans stale release output before packaging starts', async () => {
    const rmFn = vi.fn(async () => {});

    await cleanReleaseOutput({
      releaseDir: '/repo/release',
      rmFn,
    });

    expect(rmFn).toHaveBeenCalledWith('/repo/release', { force: true, recursive: true });
  });
});
