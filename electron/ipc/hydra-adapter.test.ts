import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHydraOperatorArgs,
  deriveHydraPortFromWorktree,
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

  afterEach(() => {
    for (const tempRoot of tempRoots) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses bare hydra and hydra-daemon commands by default', () => {
    expect(resolveHydraRuntime('hydra')).toEqual({
      operator: { command: 'hydra', args: [] },
      daemon: { command: 'hydra-daemon', args: ['start'] },
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
});
