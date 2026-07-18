import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createTestShellEnv,
  getTestShellHomePath,
  TEST_SHELL_HOME_DIRECTORY_NAME,
} from './test-shell-env.js';

const RAW_NODE_PROFILER_SCRIPT_NAMES = [
  'profile-server-boot.mjs',
  'profile-terminal-input-latency.mjs',
  'profile-terminal-ui-fluidity.mjs',
] as const;

describe('test-shell-env', () => {
  it('nests the stable shell home path under the cleanup-owned user data directory', () => {
    expect(getTestShellHomePath('/tmp/parallel-code-user-data')).toBe(
      path.resolve('/tmp/parallel-code-user-data', 'shell-home'),
    );
  });

  it('creates the test shell home environment override', () => {
    expect(createTestShellEnv('/tmp/parallel-code-user-data')).toEqual({
      PARALLEL_CODE_TEST_SHELL_HOME: path.resolve('/tmp/parallel-code-user-data', 'shell-home'),
    });
  });
});

describe('raw Node profiler entrypoints', () => {
  it('keeps the raw-Node helper aligned with the TypeScript contract', () => {
    const helperUrl = pathToFileURL(path.resolve('scripts/lib/test-shell-env.mjs')).href;
    const userDataPath = '/tmp/parallel-code-user-data';
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          `import { createTestShellEnv, TEST_SHELL_HOME_DIRECTORY_NAME } from ${JSON.stringify(helperUrl)};`,
          `process.stdout.write(JSON.stringify({ directoryName: TEST_SHELL_HOME_DIRECTORY_NAME, env: createTestShellEnv(${JSON.stringify(userDataPath)}) }));`,
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      directoryName: TEST_SHELL_HOME_DIRECTORY_NAME,
      env: createTestShellEnv(userDataPath),
    });
  });

  for (const scriptName of RAW_NODE_PROFILER_SCRIPT_NAMES) {
    it(`${scriptName} resolves its runtime imports`, () => {
      const result = spawnSync(process.execPath, [path.resolve('scripts', scriptName), '--help'], {
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    });
  }
});
