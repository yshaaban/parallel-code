import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile, loadLocalEnvWithDefaults, parseEnvFile } from './env.js';

const temporaryKeys = [
  'PARALLEL_CODE_ENV_FIRST',
  'PARALLEL_CODE_ENV_SECOND',
  'PARALLEL_CODE_ENV_TEST',
  'PARALLEL_CODE_ENV_KEEP',
];

afterEach(() => {
  for (const key of temporaryKeys) {
    Reflect.deleteProperty(process.env, key);
  }
});

describe('env file loader', () => {
  it('parses basic env files with comments and quotes', () => {
    expect(
      parseEnvFile(`
# Comment
PARALLEL_CODE_ENV_TEST=value
PARALLEL_CODE_ENV_KEEP="quoted value"
INVALID
`),
    ).toEqual({
      PARALLEL_CODE_ENV_KEEP: 'quoted value',
      PARALLEL_CODE_ENV_TEST: 'value',
    });
  });

  it('keeps the checked-in local browser defaults parseable', () => {
    const parsed = parseEnvFile(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));

    expect(parsed.PORT).toBe('43117');
    expect(parsed.AUTH_TOKEN).toBe('');
    expect(parsed.PARALLEL_CODE_SERVER_HOST).toBeUndefined();
  });

  it('loads missing keys without overwriting existing environment variables', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'parallel-code-env-'));
    const envPath = path.join(tempDir, '.env');

    writeFileSync(
      envPath,
      'PARALLEL_CODE_ENV_TEST=from-file\nPARALLEL_CODE_ENV_KEEP=ignored-by-loader\n',
      'utf8',
    );
    process.env.PARALLEL_CODE_ENV_KEEP = 'from-process';

    try {
      loadEnvFile(envPath);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }

    expect(process.env.PARALLEL_CODE_ENV_TEST).toBe('from-file');
    expect(process.env.PARALLEL_CODE_ENV_KEEP).toBe('from-process');
  });

  it('loads local env values before checked-in defaults fill missing keys', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'parallel-code-env-'));
    const defaultEnvPath = path.join(tempDir, '.env.example');
    const localEnvPath = path.join(tempDir, '.env');

    writeFileSync(
      defaultEnvPath,
      'PARALLEL_CODE_ENV_FIRST=from-default\nPARALLEL_CODE_ENV_SECOND=from-default\n',
      'utf8',
    );
    writeFileSync(localEnvPath, 'PARALLEL_CODE_ENV_SECOND=from-local\n', 'utf8');

    try {
      loadLocalEnvWithDefaults(localEnvPath, defaultEnvPath);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }

    expect(process.env.PARALLEL_CODE_ENV_FIRST).toBe('from-default');
    expect(process.env.PARALLEL_CODE_ENV_SECOND).toBe('from-local');
  });
});
