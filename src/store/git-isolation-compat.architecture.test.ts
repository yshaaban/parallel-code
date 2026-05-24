import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const SOURCE_ROOTS = ['electron', 'server', 'src'] as const;
const COMPATIBILITY_OWNERS = new Set([
  'electron/ipc/persisted-task-lookup-state.ts',
  'electron/ipc/task-git-handlers.ts',
  'server/browser-ipc-command-side-effects.ts',
  'server/task-names.ts',
  'src/domain/server-state.ts',
  'src/domain/task-closing.ts',
  'src/remote/agent-presentation.ts',
  'src/store/persistence-codecs.ts',
  'src/store/persistence-legacy-state.ts',
  'src/store/persistence-projects.ts',
  'src/store/projects.ts',
  'src/store/task-git-isolation.ts',
  'src/store/types.ts',
]);

function listSourceFiles(relativePath: string): string[] {
  const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    return [absolutePath];
  }

  const sourceFiles: string[] = [];
  const entries = readdirSync(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      sourceFiles.push(...listSourceFiles(childRelativePath));
      continue;
    }

    if (!entry.isFile() || !/\.(ts|tsx)$/u.test(entry.name) || entry.name.includes('.test.')) {
      continue;
    }

    sourceFiles.push(path.resolve(PROJECT_ROOT, childRelativePath));
  }

  return sourceFiles;
}

function findLegacyGitIsolationReferences(): string[] {
  const offenders: string[] = [];
  for (const sourcePath of SOURCE_ROOTS.flatMap((sourceRoot) => listSourceFiles(sourceRoot))) {
    const relativePath = path.relative(PROJECT_ROOT, sourcePath);
    if (COMPATIBILITY_OWNERS.has(relativePath)) {
      continue;
    }

    const source = readFileSync(sourcePath, 'utf8');
    if (source.includes('directMode') || source.includes('defaultDirectMode')) {
      offenders.push(relativePath);
    }
  }

  return offenders;
}

describe('git isolation compatibility guardrails', () => {
  it('keeps legacy directMode shims inside explicit compatibility owners', () => {
    expect(findLegacyGitIsolationReferences()).toEqual([]);
  });
});
