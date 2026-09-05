import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REMOTE_DIST_DIR = path.join(PROJECT_ROOT, 'dist-remote');
const REMOTE_INDEX_PATH = path.join(REMOTE_DIST_DIR, 'index.html');
const REMOTE_MANIFEST_PATH = path.join(REMOTE_DIST_DIR, '.vite', 'manifest.json');
const TASK_NOTES_VIEW_PATH = path.join(PROJECT_ROOT, 'src', 'remote', 'TaskNotesView.tsx');

// Fresh production artifact captured before the final task-detail/secure-capability slice on
// 2026-08-03 with the repository-pinned Node/npm target.
const BASELINE_REMOTE_ENTRY_GZIP_BYTES = 154_251;
const REMOTE_ENTRY_GROWTH_BUDGET = 0.02;
const NEW_TASK_GZIP_BUDGET_BYTES = 15 * 1_024;
// The former 8 KiB check followed only static manifest imports while TaskNotesView immediately
// fetched its mandatory runtime as a nested dynamic chunk. The honest first-open closure measured
// 8,594 B after restoring static ownership, so D14 uses 9 KiB with 622 B of regression headroom.
const TASK_NOTES_GZIP_BUDGET_BYTES = 9 * 1_024;
const TASK_NOTES_RECOVERY_GZIP_BUDGET_BYTES = 3 * 1_024;

interface ViteManifestEntry {
  css?: string[];
  dynamicImports?: string[];
  file: string;
  imports?: string[];
  isDynamicEntry?: boolean;
  isEntry?: boolean;
  name?: string;
  src?: string;
}

function readManifest(value: unknown): Record<string, ViteManifestEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Vite manifest at ${REMOTE_MANIFEST_PATH}`);
  }
  const entries: Record<string, ViteManifestEntry> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      typeof (candidate as { file?: unknown }).file !== 'string'
    ) {
      throw new Error(`Invalid Vite manifest entry ${key}`);
    }
    entries[key] = candidate as ViteManifestEntry;
  }
  return entries;
}

function findSourceEntry(
  manifest: Record<string, ViteManifestEntry>,
  sourceFile: string,
): readonly [string, ViteManifestEntry] {
  const matches = Object.entries(manifest).filter(
    ([key, entry]) => key === sourceFile || entry.src === sourceFile,
  );
  expect(matches, `manifest entry for ${sourceFile}`).toHaveLength(1);
  const match = matches[0];
  if (!match) throw new Error(`Missing Vite manifest entry for ${sourceFile}`);
  return match;
}

function collectStaticAssets(
  manifest: Record<string, ViteManifestEntry>,
  entryKey: string,
  assets = new Set<string>(),
  visited = new Set<string>(),
): Set<string> {
  if (visited.has(entryKey)) return assets;
  visited.add(entryKey);
  const entry = manifest[entryKey];
  if (!entry) throw new Error(`Missing imported manifest entry ${entryKey}`);
  assets.add(entry.file);
  for (const cssFile of entry.css ?? []) assets.add(cssFile);
  for (const importedKey of entry.imports ?? []) {
    collectStaticAssets(manifest, importedKey, assets, visited);
  }
  return assets;
}

function collectLazyStaticAssets(
  manifest: Record<string, ViteManifestEntry>,
  entryKey: string,
  eagerEntryKey: string,
): string[] {
  const eagerAssets = collectStaticAssets(manifest, eagerEntryKey);
  return [...collectStaticAssets(manifest, entryKey)].filter((asset) => !eagerAssets.has(asset));
}

async function getFreshGzipClosureBytes(relativeAssetPaths: readonly string[]): Promise<number> {
  const sizes = await Promise.all(relativeAssetPaths.map(getFreshGzipBytes));
  return sizes.reduce((total, size) => total + size, 0);
}

async function getFreshGzipBytes(relativeAssetPath: string): Promise<number> {
  if (!/^assets\/[A-Za-z0-9_.-]+$/u.test(relativeAssetPath)) {
    throw new Error(`Unexpected emitted asset path: ${relativeAssetPath}`);
  }
  const assetPath = path.join(REMOTE_DIST_DIR, relativeAssetPath);
  const [assetStat, gzipStat] = await Promise.all([stat(assetPath), stat(`${assetPath}.gz`)]);
  expect(assetStat.size).toBeGreaterThan(0);
  expect(gzipStat.size).toBeGreaterThan(0);
  expect(gzipStat.mtimeMs).toBeGreaterThanOrEqual(assetStat.mtimeMs);
  return gzipStat.size;
}

describe('remote task feature bundle budget', () => {
  it('keeps New Task and Notes lazy while the eager remote shell stays within 2%', async () => {
    const [indexHtml, manifestText, taskNotesViewSource] = await Promise.all([
      readFile(REMOTE_INDEX_PATH, 'utf8'),
      readFile(REMOTE_MANIFEST_PATH, 'utf8'),
      readFile(TASK_NOTES_VIEW_PATH, 'utf8'),
    ]);
    const manifest = readManifest(JSON.parse(manifestText) as unknown);
    const [mainEntryKey, mainEntry] = findSourceEntry(manifest, 'index.html');
    const [newTaskEntryKey, newTaskEntry] = findSourceEntry(manifest, 'NewTaskView.tsx');
    const [taskNotesEntryKey, taskNotesEntry] = findSourceEntry(manifest, 'TaskNotesView.tsx');
    const [taskNotesRecoveryEntryKey, taskNotesRecoveryEntry] = findSourceEntry(
      manifest,
      'TaskNotesRecoveryView.tsx',
    );
    const newTaskAssets = collectLazyStaticAssets(manifest, newTaskEntryKey, mainEntryKey);
    const taskNotesAssets = collectLazyStaticAssets(manifest, taskNotesEntryKey, mainEntryKey);
    const taskNotesAssetSet = new Set(taskNotesAssets);
    const taskNotesRecoveryAssets = collectLazyStaticAssets(
      manifest,
      taskNotesRecoveryEntryKey,
      mainEntryKey,
    ).filter((asset) => !taskNotesAssetSet.has(asset));

    expect(mainEntry.isEntry).toBe(true);
    expect(newTaskEntry.isDynamicEntry).toBe(true);
    expect(taskNotesEntry.isDynamicEntry).toBe(true);
    expect(taskNotesRecoveryEntry.isDynamicEntry).toBe(true);
    expect(taskNotesEntry.dynamicImports ?? []).toContain('TaskNotesRecoveryView.tsx');
    expect(taskNotesEntry.dynamicImports ?? []).not.toContain('task-notes-runtime.ts');
    expect(taskNotesViewSource).toContain("from './task-notes-runtime'");
    expect(taskNotesViewSource).not.toContain("import('./task-notes-runtime')");
    expect(indexHtml).toContain(`src="./${mainEntry.file}"`);

    const eagerFeatureLinks = (indexHtml.match(/<link\b[^>]*>/giu) ?? []).filter(
      (tag) =>
        /\brel=["'](?:modulepreload|prefetch)["']/iu.test(tag) &&
        [...newTaskAssets, ...taskNotesAssets, ...taskNotesRecoveryAssets].some((asset) =>
          tag.includes(asset),
        ),
    );
    expect(eagerFeatureLinks).toEqual([]);

    const [mainGzipBytes, newTaskGzipBytes, taskNotesGzipBytes, taskNotesRecoveryGzipBytes] =
      await Promise.all([
        getFreshGzipBytes(mainEntry.file),
        getFreshGzipClosureBytes(newTaskAssets),
        getFreshGzipClosureBytes(taskNotesAssets),
        getFreshGzipClosureBytes(taskNotesRecoveryAssets),
      ]);
    const remoteEntryBudgetBytes = Math.floor(
      BASELINE_REMOTE_ENTRY_GZIP_BYTES * (1 + REMOTE_ENTRY_GROWTH_BUDGET),
    );

    expect(mainGzipBytes).toBeLessThanOrEqual(remoteEntryBudgetBytes);
    expect(newTaskGzipBytes).toBeLessThanOrEqual(NEW_TASK_GZIP_BUDGET_BYTES);
    expect(taskNotesGzipBytes).toBeLessThanOrEqual(TASK_NOTES_GZIP_BUDGET_BYTES);
    expect(taskNotesRecoveryGzipBytes).toBeLessThanOrEqual(TASK_NOTES_RECOVERY_GZIP_BUDGET_BYTES);

    process.stdout.write(
      `${[
        'remote-feature-bundle',
        `entry=${mainGzipBytes}B`,
        `entryBaseline=${BASELINE_REMOTE_ENTRY_GZIP_BYTES}B`,
        `entryBudget=${remoteEntryBudgetBytes}B`,
        `newTask=${newTaskGzipBytes}B`,
        `taskNotes=${taskNotesGzipBytes}B`,
        `taskNotesRecovery=${taskNotesRecoveryGzipBytes}B`,
      ].join(' ')}\n`,
    );
  });
});
