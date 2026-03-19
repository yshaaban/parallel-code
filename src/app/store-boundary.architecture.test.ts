import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const LAYER_ROOTS = [
  'src/App.tsx',
  'src/app',
  'src/components',
  'src/runtime',
  'src/remote',
] as const;

function listSourceFiles(relativePath: string): string[] {
  const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    return [absolutePath];
  }

  const entries = readdirSync(absolutePath, { withFileTypes: true });
  const sourceFiles: string[] = [];
  for (const entry of entries) {
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      sourceFiles.push(...listSourceFiles(childRelativePath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes('.test.')) {
      continue;
    }

    sourceFiles.push(path.resolve(PROJECT_ROOT, childRelativePath));
  }

  return sourceFiles;
}

const nonStoreSources = LAYER_ROOTS.flatMap((relativePath) => listSourceFiles(relativePath));
const appRuntimeSources = ['src/app', 'src/runtime'].flatMap((relativePath) =>
  listSourceFiles(relativePath),
);
const browserPresenceSource = readFileSync(
  path.resolve(PROJECT_ROOT, 'src/runtime/browser-presence.ts'),
  'utf8',
);
const taskCommandLeaseSource = readFileSync(
  path.resolve(PROJECT_ROOT, 'src/app/task-command-lease-runtime.ts'),
  'utf8',
);
const terminalInputPipelineSource = readFileSync(
  path.resolve(PROJECT_ROOT, 'src/components/terminal-view/terminal-input-pipeline.ts'),
  'utf8',
);

describe('store boundary architecture guardrails', () => {
  it('keeps store/core internal to the store layer', () => {
    for (const sourcePath of nonStoreSources) {
      const source = readFileSync(sourcePath, 'utf8');
      expect(source, path.relative(PROJECT_ROOT, sourcePath)).not.toContain('store/core');
    }
  });

  it('keeps app and runtime code off the broad store barrel', () => {
    for (const sourcePath of appRuntimeSources) {
      const source = readFileSync(sourcePath, 'utf8');
      expect(source, path.relative(PROJECT_ROOT, sourcePath)).not.toContain('store/store');
    }
  });

  it('keeps task-command controller reads behind controller accessors', () => {
    expect(browserPresenceSource).toContain('listControlledTaskIdsByController');
    expect(browserPresenceSource).not.toContain('store.taskCommandControllers');
    expect(taskCommandLeaseSource).toContain('getTaskCommandController');
    expect(taskCommandLeaseSource).not.toContain('store.taskCommandControllers');
    expect(terminalInputPipelineSource).toContain('getTaskCommandController');
    expect(terminalInputPipelineSource).not.toContain('store.taskCommandControllers');
  });

  it('keeps focused-panel reads behind focus accessors', () => {
    for (const sourcePath of nonStoreSources) {
      const source = readFileSync(sourcePath, 'utf8');
      expect(source, path.relative(PROJECT_ROOT, sourcePath)).not.toContain('store.focusedPanel[');
    }
  });

  it('keeps incoming takeover request reads behind store projections', () => {
    for (const sourcePath of nonStoreSources) {
      const source = readFileSync(sourcePath, 'utf8');
      expect(source, path.relative(PROJECT_ROOT, sourcePath)).not.toContain(
        'Object.values(store.incomingTaskTakeoverRequests)',
      );
    }
  });
});
