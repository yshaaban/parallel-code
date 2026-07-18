import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  cleanServerBuildOutput,
  containsVitestImport,
  isDevelopmentServerOutputPath,
  runServerBuild,
  validateServerBuildOutput,
} from '../../server/build-server.mjs';

describe('build-server', () => {
  it('cleans stale server output before compiling and rewrites only a successful build', async () => {
    const cleanOutput = vi.fn(async () => {});
    const compile = vi.fn(async () => ({ code: 0, signal: null }));
    const rewriteImports = vi.fn(async () => {});
    const validateOutput = vi.fn(async () => {});

    await expect(
      runServerBuild({ cleanOutput, compile, rewriteImports, validateOutput }),
    ).resolves.toEqual({ code: 0, signal: null });
    expect(cleanOutput.mock.invocationCallOrder[0]).toBeLessThan(
      compile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(compile.mock.invocationCallOrder[0]).toBeLessThan(
      rewriteImports.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(rewriteImports.mock.invocationCallOrder[0]).toBeLessThan(
      validateOutput.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('removes and never rewrites a failed partial TypeScript emit', async () => {
    const cleanOutput = vi.fn(async () => {});
    const compile = vi.fn(async () => ({ code: 1, signal: null }));
    const rewriteImports = vi.fn(async () => {});
    const validateOutput = vi.fn(async () => {});

    await expect(
      runServerBuild({ cleanOutput, compile, rewriteImports, validateOutput }),
    ).resolves.toEqual({ code: 1, signal: null });
    expect(cleanOutput).toHaveBeenCalledTimes(2);
    expect(rewriteImports).not.toHaveBeenCalled();
    expect(validateOutput).not.toHaveBeenCalled();
  });

  it('reports both a failed TypeScript exit and failed partial-output cleanup', async () => {
    const cleanupError = new Error('partial output cleanup failed');
    const cleanOutput = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(cleanupError);

    const failure = await runServerBuild({
      cleanOutput,
      compile: async () => ({ code: 2, signal: null }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      'Server build failed and cleanup also failed.',
    );
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'TypeScript server build exited with code 2' }),
      cleanupError,
    ]);
  });

  it('removes output when the compiler process rejects', async () => {
    const compileError = new Error('compiler process failed');
    const cleanOutput = vi.fn(async () => {});

    await expect(
      runServerBuild({
        cleanOutput,
        compile: async () => {
          throw compileError;
        },
      }),
    ).rejects.toBe(compileError);
    expect(cleanOutput).toHaveBeenCalledTimes(2);
  });

  it('removes output when import rewriting fails', async () => {
    const rewriteError = new Error('rewrite failed');
    const cleanOutput = vi.fn(async () => {});
    const validateOutput = vi.fn(async () => {});

    await expect(
      runServerBuild({
        cleanOutput,
        compile: async () => ({ code: 0, signal: null }),
        rewriteImports: async () => {
          throw rewriteError;
        },
        validateOutput,
      }),
    ).rejects.toBe(rewriteError);
    expect(cleanOutput).toHaveBeenCalledTimes(2);
    expect(validateOutput).not.toHaveBeenCalled();
  });

  it('removes output when production validation fails', async () => {
    const validationError = new Error('validation failed');
    const cleanOutput = vi.fn(async () => {});

    await expect(
      runServerBuild({
        cleanOutput,
        compile: async () => ({ code: 0, signal: null }),
        rewriteImports: async () => {},
        validateOutput: async () => {
          throw validationError;
        },
      }),
    ).rejects.toBe(validationError);
    expect(cleanOutput).toHaveBeenCalledTimes(2);
  });

  it('reports both post-processing and cleanup failures', async () => {
    const rewriteError = new Error('rewrite failed');
    const cleanupError = new Error('cleanup failed');
    const cleanOutput = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(cleanupError);

    const failure = await runServerBuild({
      cleanOutput,
      compile: async () => ({ code: 0, signal: null }),
      rewriteImports: async () => {
        throw rewriteError;
      },
      validateOutput: async () => {},
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([rewriteError, cleanupError]);
    expect((failure as AggregateError).message).toBe(
      'Server build failed and cleanup also failed.',
    );
  });

  it('removes the complete output tree', async () => {
    const rmFn = vi.fn(async () => {});

    await cleanServerBuildOutput({ distServerDir: '/repo/dist-server', rmFn });

    expect(rmFn).toHaveBeenCalledWith('/repo/dist-server', { force: true, recursive: true });
  });

  it('uses a production-only TypeScript emit configuration', () => {
    const buildConfig = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'server/tsconfig.build.json'), 'utf8'),
    ) as { exclude?: string[] };

    expect(buildConfig.exclude).toEqual(
      expect.arrayContaining([
        './**/*.test.ts',
        './**/*.spec.ts',
        './**/*.test-helper.ts',
        '../electron/ipc/**/*.test.ts',
        '../electron/ipc/**/*.spec.ts',
        '../electron/ipc/**/*.test-helper.ts',
        '../electron/remote/**/*.test.ts',
        '../electron/remote/**/*.spec.ts',
        '../electron/remote/**/*.test-helper.ts',
      ]),
    );
  });

  it.each([
    'server/session.test.js',
    'server/session.spec.mjs',
    'server/test-utils.test-helper.cjs',
    'server/__tests__/session.js',
    'server/specs/session.js',
  ])('classifies development-only output path %s', (filePath) => {
    expect(isDevelopmentServerOutputPath(filePath)).toBe(true);
  });

  it.each([
    'server/test-shell-sandbox.js',
    'server/workflow-spec.js',
    'server/contest.js',
    'server/main.js',
  ])('preserves production path %s', (filePath) => {
    expect(isDevelopmentServerOutputPath(filePath)).toBe(false);
  });

  it.each([
    "import { describe } from 'vitest';",
    'import "vitest";',
    "export { describe } from 'vitest';",
    "const vitest = await import('vitest/runtime');",
    "const vitest = require('vitest');",
  ])('detects Vitest import in %s', (source) => {
    expect(containsVitestImport(source)).toBe(true);
  });

  it.each([
    "// import { describe } from 'vitest';",
    'const example = "import \'vitest\'";',
    "const source = `from 'vitest'`;",
    "import { runtime } from 'not-vitest';",
  ])('does not mistake Vitest text for an import in %s', (source) => {
    expect(containsVitestImport(source)).toBe(false);
  });

  it('aggregates development artifacts and Vitest imports from production output', async () => {
    const sources = new Map([
      ['server/main.js', "import { describe } from 'vitest';"],
      ['server/session.test.js', 'export {};'],
      ['server/test-utils.test-helper.js', 'export {};'],
    ]);

    await expect(
      validateServerBuildOutput({
        distServerDir: '/repo/dist-server',
        listFiles: async () => [...sources.keys()],
        readFileFn: async (filePath) => {
          const source = sources.get(path.posix.relative('/repo/dist-server', filePath));
          if (source === undefined) {
            throw new Error(`Unexpected output file: ${filePath}`);
          }
          return source;
        },
      }),
    ).rejects.toThrow(
      'Invalid production server output:\ndevelopment artifacts (2):\nserver/session.test.js\nserver/test-utils.test-helper.js\nVitest imports (1):\nserver/main.js',
    );
  });
});
