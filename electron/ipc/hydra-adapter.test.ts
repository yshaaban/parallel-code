import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHydraOperatorArgs,
  deriveHydraPortFromWorktree,
  getHydraRuntimeAvailability,
  normalizeHydraStartupMode,
  resolveHydraAdapterLaunch,
  resolveHydraRuntime,
} from './hydra-adapter.js';

describe('hydra adapter helpers', () => {
  it('derives a stable per-worktree daemon port', () => {
    const first = deriveHydraPortFromWorktree('/tmp/parallel-code/worktree-one');
    const second = deriveHydraPortFromWorktree('/tmp/parallel-code/worktree-one');
    const third = deriveHydraPortFromWorktree('/tmp/parallel-code/worktree-two');

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(43_000);
    expect(first).toBeLessThan(58_000);
    expect(third).not.toBe(first);
  });

  it('normalizes unsupported startup modes back to auto', () => {
    expect(normalizeHydraStartupMode('dispatch')).toBe('dispatch');
    expect(normalizeHydraStartupMode('unsupported')).toBe('auto');
    expect(normalizeHydraStartupMode(undefined)).toBe('auto');
  });

  it('builds operator args with url, startup mode, and welcome suppression', () => {
    expect(
      buildHydraOperatorArgs(['agents=codex,claude'], {
        url: 'http://127.0.0.1:43123',
        startupMode: 'smart',
      }),
    ).toEqual(['agents=codex,claude', 'url=http://127.0.0.1:43123', 'welcome=false', 'mode=smart']);
  });

  it('does not override explicit operator args', () => {
    expect(
      buildHydraOperatorArgs(['mode=council', 'welcome=true', 'url=http://127.0.0.1:41000'], {
        url: 'http://127.0.0.1:43123',
        startupMode: 'auto',
      }),
    ).toEqual(['mode=council', 'welcome=true', 'url=http://127.0.0.1:41000']);
  });

  it('wraps Hydra launches through the internal adapter process', () => {
    const launch = resolveHydraAdapterLaunch({
      command: 'hydra',
      args: ['agents=codex,claude'],
      cwd: '/tmp/parallel-code/worktree-one',
      env: { PARALLEL_CODE_HYDRA_STARTUP_MODE: 'council' },
    });

    expect(launch.command).toBe(process.execPath);
    expect(launch.isInternalNodeProcess).toBe(true);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        expect.stringContaining('hydra-adapter'),
        '--hydra-command',
        'hydra',
        '--startup-mode',
        'council',
        '--operator-arg',
        'agents=codex,claude',
      ]),
    );
  });
});

describe('resolveHydraRuntime', () => {
  const tempRoots: string[] = [];
  const vendoredRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../vendor/hydra',
  );

  afterEach(() => {
    for (const tempRoot of tempRoots) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses bare hydra and hydra-daemon commands by default', () => {
    const runtime = resolveHydraRuntime('hydra', { resolveBareCommandPath: false });

    expect(runtime.operator).toMatchObject({
      command: 'hydra',
      args: [],
    });
    expect(runtime.daemon).toMatchObject({
      command: 'hydra-daemon',
      args: ['start'],
    });
  });

  it('derives node-backed Hydra commands from a local Hydra checkout', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-hydra-'));
    tempRoots.push(tempRoot);
    fs.mkdirSync(path.join(tempRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'bin', 'hydra-cli.mjs'), '#!/usr/bin/env node\n');
    fs.writeFileSync(
      path.join(tempRoot, 'lib', 'orchestrator-daemon.mjs'),
      '#!/usr/bin/env node\n',
    );

    expect(resolveHydraRuntime(path.join(tempRoot, 'bin', 'hydra-cli.mjs'))).toEqual({
      operator: {
        command: process.execPath,
        args: [path.join(tempRoot, 'bin', 'hydra-cli.mjs')],
      },
      daemon: {
        command: process.execPath,
        args: [path.join(tempRoot, 'lib', 'orchestrator-daemon.mjs'), 'start'],
      },
    });
  });

  it('falls back to the vendored Hydra runtime when bare hydra is not on PATH', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';

    try {
      expect(resolveHydraRuntime('hydra', { resolveBareCommandPath: true })).toEqual({
        operator: {
          command: process.execPath,
          args: [path.join(vendoredRoot, 'bin', 'hydra-cli.mjs')],
        },
        daemon: {
          command: process.execPath,
          args: [path.join(vendoredRoot, 'lib', 'orchestrator-daemon.mjs'), 'start'],
        },
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('finds the vendored Hydra runtime from a standalone server dist layout', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-server-dist-'));
    tempRoots.push(tempRoot);

    const startDir = path.join(tempRoot, 'dist-server', 'electron', 'ipc');
    fs.mkdirSync(startDir, { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'vendor', 'hydra', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'vendor', 'hydra', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'vendor', 'hydra', 'bin', 'hydra-cli.mjs'), '');
    fs.writeFileSync(path.join(tempRoot, 'vendor', 'hydra', 'lib', 'orchestrator-daemon.mjs'), '');

    const originalPath = process.env.PATH;
    process.env.PATH = '';

    try {
      expect(
        resolveHydraRuntime('hydra', {
          assetSearch: { startDir },
          resolveBareCommandPath: true,
        }),
      ).toEqual({
        operator: {
          command: process.execPath,
          args: [path.join(tempRoot, 'vendor', 'hydra', 'bin', 'hydra-cli.mjs')],
        },
        daemon: {
          command: process.execPath,
          args: [path.join(tempRoot, 'vendor', 'hydra', 'lib', 'orchestrator-daemon.mjs'), 'start'],
        },
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('reports a useful diagnostic when a Hydra override path is invalid', async () => {
    const availability = await getHydraRuntimeAvailability('/tmp/does-not-exist/hydra-cli.mjs', {
      resolveBareCommandPath: true,
    });

    expect(availability.available).toBe(false);
    expect(availability.source).toBe('unavailable');
    expect(availability.detail).toContain('not found');
  });
});
