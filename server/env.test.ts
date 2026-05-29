import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile, parseEnvFile } from './env.js';

const temporaryKeys = ['PARALLEL_CODE_ENV_TEST', 'PARALLEL_CODE_ENV_KEEP'];

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
    expect(parsed.AUTH_TOKEN).toBe('parallel-code-local-browser');
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
});
