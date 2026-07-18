import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { runIndependentCleanups } from '../scripts/lib/cleanup-outcome.mjs';
import {
  resolveRelativeImportSpecifier,
  rewriteDistServerRelativeImports,
  rewriteRelativeSpecifiers,
} from './rewrite-dist-server-relative-imports.mjs';

describe('rewriteDistServerRelativeImports', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await runIndependentCleanups(
      'Server import rewrite test temporary directories',
      tempDirs
        .splice(0)
        .map(
          (directory, index) =>
            [
              `remove server import rewrite temporary directory ${index + 1}`,
              () => rm(directory, { force: true, recursive: true }),
            ] as const,
        ),
    );
  });

  it('adds .js to extensionless relative imports and exports that resolve to files', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-dist-server-rewrite-'));
    tempDirs.push(rootDir);

    const distServerDir = path.join(rootDir, 'dist-server');
    const filePath = path.join(distServerDir, 'src', 'app', 'entry.js');
    await Promise.all([
      mkdir(path.dirname(filePath), { recursive: true }),
      mkdir(path.join(distServerDir, 'src', 'app', 'feature'), { recursive: true }),
      mkdir(path.join(distServerDir, 'src', 'shared'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(distServerDir, 'src', 'app', 'runtime.js'), 'export const ok = true;\n'),
      writeFile(
        path.join(distServerDir, 'src', 'app', 'feature', 'index.js'),
        'export const feature = true;\n',
      ),
      writeFile(
        filePath,
        [
          "import { ok } from './runtime';",
          "export { feature } from './feature';",
          "import './feature';",
          "const other = await import('../shared/module');",
          "import { keepJson } from './config.json' with { type: 'json' };",
          "import { keepBare } from 'node:path';",
          '',
        ].join('\n'),
        'utf8',
      ),
      writeFile(
        path.join(distServerDir, 'src', 'shared', 'module.js'),
        'export const shared = true;\n',
      ),
    ]);

    const result = await rewriteDistServerRelativeImports({ distServerDir });
    const rewrittenText = await readFile(filePath, 'utf8');

    expect(result.changedFileCount).toBe(1);
    expect(result.unresolvedEntries).toEqual([]);
    expect(rewrittenText).toContain("from './runtime.js'");
    expect(rewrittenText).toContain("from './feature/index.js'");
    expect(rewrittenText).toContain("import './feature/index.js'");
    expect(rewrittenText).toContain("import('../shared/module.js')");
    expect(rewrittenText).toContain("from './config.json'");
    expect(rewrittenText).toContain("from 'node:path'");
  });

  it('leaves unresolved or explicit-extension specifiers unchanged', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-dist-server-rewrite-'));
    tempDirs.push(rootDir);

    const filePath = path.join(rootDir, 'dist-server', 'src', 'app', 'entry.js');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      ["import { missing } from './missing';", "import { explicit } from './runtime.js';", ''].join(
        '\n',
      ),
      'utf8',
    );

    const rewrittenFile = await rewriteRelativeSpecifiers(
      filePath,
      await readFile(filePath, 'utf8'),
    );

    expect(rewrittenFile.changed).toBe(false);
    expect(rewrittenFile.text).toContain("from './missing'");
    expect(rewrittenFile.text).toContain("from './runtime.js'");
    expect(rewrittenFile.unresolvedSpecifiers).toEqual(['./missing']);
  });

  it('resolves extensionless relative specifiers against sibling modules and index files', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-dist-server-rewrite-'));
    tempDirs.push(rootDir);

    const entryDir = path.join(rootDir, 'dist-server', 'src', 'app');
    await mkdir(path.join(entryDir, 'nested'), { recursive: true });
    await Promise.all([
      writeFile(path.join(entryDir, 'runtime.js'), 'export const ok = true;\n', 'utf8'),
      writeFile(path.join(entryDir, 'nested', 'index.js'), 'export const ok = true;\n', 'utf8'),
    ]);

    expect(await resolveRelativeImportSpecifier(path.join(entryDir, 'entry.js'), './runtime')).toBe(
      './runtime.js',
    );
    expect(await resolveRelativeImportSpecifier(path.join(entryDir, 'entry.js'), './nested')).toBe(
      './nested/index.js',
    );
    expect(await resolveRelativeImportSpecifier(path.join(entryDir, 'entry.js'), './missing')).toBe(
      './missing',
    );
  });
});
