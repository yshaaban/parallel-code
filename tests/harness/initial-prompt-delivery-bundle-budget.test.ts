import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIST_ASSETS_PATH = path.join(PROJECT_ROOT, 'dist', 'assets');
const DIST_INDEX_PATH = path.join(PROJECT_ROOT, 'dist', 'index.html');
// Fresh production artifact captured before the D01 renderer cutover with the
// repository-pinned Node/npm target.
const BASELINE_MAIN_GZIP_BYTES = 212_701;
const AGGREGATE_ENTRY_CLOSURE_GZIP_BUDGET_BYTES = 258 * 1_024;
const INITIAL_PROMPT_LAZY_GZIP_BUDGET_BYTES = 8 * 1_024;
const MANUAL_AGENT_SESSION_LAZY_GZIP_BUDGET_BYTES = 2 * 1_024;
const MANUAL_AGENT_SESSION_LAZY_CLOSURE_GZIP_BUDGET_BYTES = 10 * 1_024;
const SHARED_RELIABILITY_GZIP_BUDGET_BYTES = 8 * 1_024;

function getMainEntryRelativePath(indexHtml: string): string {
  const moduleScripts = [...indexHtml.matchAll(/<script\b[^>]*><\/script>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\btype=["']module["']/iu.test(tag));
  expect(moduleScripts).toHaveLength(1);
  const src = moduleScripts[0]?.match(/\bsrc=["']\.\/([^"']+\.js)["']/iu)?.[1];
  if (!src || !/^assets\/index-[^/]+\.js$/u.test(src)) {
    throw new Error(`Unable to identify the Vite main entry from ${DIST_INDEX_PATH}`);
  }
  return src;
}

function getStaticJavaScriptImports(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/\b(?:from|import)\s*["']\.\/([^"']+\.js)["']/gu)].map(
        (match) => match[1] as string,
      ),
    ),
  ].sort();
}

function getPreloadedJavaScriptAssets(indexHtml: string): string[] {
  return [...indexHtml.matchAll(/<link\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\brel=["'](?:modulepreload|prefetch)["']/iu.test(tag))
    .map((tag) => tag.match(/\bhref=["']\.\/assets\/([^"']+\.js)["']/iu)?.[1])
    .filter((asset): asset is string => asset !== undefined)
    .sort();
}

async function collectStaticJavaScriptClosure(
  entry: string,
  assets = new Set<string>(),
): Promise<Set<string>> {
  if (assets.has(entry)) return assets;
  if (!/^[A-Za-z0-9_.-]+\.js$/u.test(entry)) {
    throw new Error(`Unexpected emitted JavaScript asset: ${entry}`);
  }
  assets.add(entry);
  const source = await readFile(path.join(DIST_ASSETS_PATH, entry), 'utf8');
  for (const importedEntry of getStaticJavaScriptImports(source)) {
    await collectStaticJavaScriptClosure(importedEntry, assets);
  }
  return assets;
}

async function getFreshGzipBytes(entry: string): Promise<number> {
  const entryPath = path.join(DIST_ASSETS_PATH, entry);
  const [entryStat, gzipStat] = await Promise.all([stat(entryPath), stat(`${entryPath}.gz`)]);
  expect(entryStat.size).toBeGreaterThan(0);
  expect(gzipStat.size).toBeGreaterThan(0);
  expect(gzipStat.mtimeMs).toBeGreaterThanOrEqual(entryStat.mtimeMs);
  return gzipStat.size;
}

async function getLazyStaticClosure(
  lazyEntry: string,
  mainEntryRelativePath: string,
): Promise<string[]> {
  const mainEntry = path.basename(mainEntryRelativePath);
  const [eagerAssets, lazyAssets] = await Promise.all([
    collectStaticJavaScriptClosure(mainEntry),
    collectStaticJavaScriptClosure(lazyEntry),
  ]);
  return [...lazyAssets].filter((asset) => !eagerAssets.has(asset)).sort();
}

async function getFreshGzipClosureBytes(entries: readonly string[]): Promise<number> {
  const sizes = await Promise.all(entries.map(getFreshGzipBytes));
  return sizes.reduce((total, size) => total + size, 0);
}

function getSharedReliabilityEntry(lazyClosure: readonly string[]): string {
  const matches = lazyClosure.filter((entry) =>
    /^task-reliability-production-[^/]+\.js$/u.test(entry),
  );
  expect(matches).toHaveLength(1);
  return matches[0] as string;
}

describe('initial-prompt delivery bundle budget', () => {
  it('bounds the main plus lazy-control aggregate and keeps the control non-preloaded', async () => {
    const indexHtml = await readFile(DIST_INDEX_PATH, 'utf8');
    const mainEntryRelativePath = getMainEntryRelativePath(indexHtml);
    const mainEntryPath = path.join(PROJECT_ROOT, 'dist', mainEntryRelativePath);
    const assetNames = await readdir(DIST_ASSETS_PATH);
    const lazyEntries = assetNames.filter((name) =>
      /^InitialPromptDeliveryControl-[^/]+\.js$/u.test(name),
    );
    expect(lazyEntries).toHaveLength(1);
    const lazyEntry = lazyEntries[0] as string;
    const lazyEntryPath = path.join(DIST_ASSETS_PATH, lazyEntry);
    const [mainStat, gzipStat, mainSource, lazyStat, lazySource, lazyGzipStat] = await Promise.all([
      stat(mainEntryPath),
      stat(`${mainEntryPath}.gz`),
      readFile(mainEntryPath, 'utf8'),
      stat(lazyEntryPath),
      readFile(lazyEntryPath, 'utf8'),
      stat(`${lazyEntryPath}.gz`),
    ]);

    expect(mainStat.size).toBeGreaterThan(0);
    expect(gzipStat.size).toBeGreaterThan(0);
    expect(gzipStat.mtimeMs).toBeGreaterThanOrEqual(mainStat.mtimeMs);

    const deltaBytes = gzipStat.size - BASELINE_MAIN_GZIP_BYTES;
    const lazyStaticImports = getStaticJavaScriptImports(lazySource);
    const lazyClosure = await getLazyStaticClosure(lazyEntry, mainEntryRelativePath);
    const sharedReliabilityEntry = getSharedReliabilityEntry(lazyClosure);
    const [lazyClosureGzipBytes, sharedReliabilityGzipBytes] = await Promise.all([
      getFreshGzipClosureBytes(lazyClosure),
      getFreshGzipBytes(sharedReliabilityEntry),
    ]);
    const aggregateEntryClosureBytes = gzipStat.size + lazyClosureGzipBytes;
    const preloadedAssets = getPreloadedJavaScriptAssets(indexHtml);
    process.stdout.write(
      `${[
        'initial-prompt-delivery-bundle',
        `entry=${mainEntryRelativePath}`,
        `baseline=${BASELINE_MAIN_GZIP_BYTES}B`,
        `current=${gzipStat.size}B`,
        `delta=${deltaBytes}B`,
        `historicalAttributableDelta=${deltaBytes}B`,
        `lazyEntry=${lazyEntry}`,
        `lazyStaticImports=${lazyStaticImports.join(',')}`,
        `lazyClosure=${lazyClosure.join(',')}`,
        `lazyGzip=${lazyGzipStat.size}B`,
        `lazyClosureGzip=${lazyClosureGzipBytes}B`,
        `sharedReliabilityGzip=${sharedReliabilityGzipBytes}B`,
        `aggregateEntryClosure=${aggregateEntryClosureBytes}B`,
      ].join(' ')}\n`,
    );

    expect(aggregateEntryClosureBytes).toBeLessThan(AGGREGATE_ENTRY_CLOSURE_GZIP_BUDGET_BYTES);
    expect(lazyGzipStat.size).toBeLessThan(INITIAL_PROMPT_LAZY_GZIP_BUDGET_BYTES);
    expect(sharedReliabilityGzipBytes).toBeLessThan(SHARED_RELIABILITY_GZIP_BUDGET_BYTES);
    expect(lazyGzipStat.mtimeMs).toBeGreaterThanOrEqual(lazyStat.mtimeMs);
    for (const lazyAsset of lazyClosure) expect(preloadedAssets).not.toContain(lazyAsset);
    expect(lazySource).toContain('Initial prompt sent.');
    expect(mainSource).not.toContain('Initial prompt sent.');
  });

  it('keeps manual agent-session policy behind the explicit action boundary', async () => {
    const indexHtml = await readFile(DIST_INDEX_PATH, 'utf8');
    const mainEntryRelativePath = getMainEntryRelativePath(indexHtml);
    const assetNames = await readdir(DIST_ASSETS_PATH);
    const workflowEntries = assetNames.filter((name) =>
      /^agent-session-workflows-[^/]+\.js$/u.test(name),
    );
    expect(workflowEntries).toHaveLength(1);
    const workflowEntry = workflowEntries[0] as string;
    const workflowPath = path.join(DIST_ASSETS_PATH, workflowEntry);
    const [workflowStat, workflowGzipStat, workflowSource] = await Promise.all([
      stat(workflowPath),
      stat(`${workflowPath}.gz`),
      readFile(workflowPath, 'utf8'),
    ]);
    const workflowStaticImports = getStaticJavaScriptImports(workflowSource);
    const workflowClosure = await getLazyStaticClosure(workflowEntry, mainEntryRelativePath);
    const sharedReliabilityEntry = getSharedReliabilityEntry(workflowClosure);
    const workflowClosureGzipBytes = await getFreshGzipClosureBytes(workflowClosure);
    const preloadedAssets = getPreloadedJavaScriptAssets(indexHtml);

    process.stdout.write(
      `${[
        'manual-agent-session-bundle',
        `lazyEntry=${workflowEntry}`,
        `lazyStaticImports=${workflowStaticImports.join(',')}`,
        `lazyClosure=${workflowClosure.join(',')}`,
        `lazyGzip=${workflowGzipStat.size}B`,
        `lazyClosureGzip=${workflowClosureGzipBytes}B`,
        `sharedReliability=${sharedReliabilityEntry}`,
      ].join(' ')}\n`,
    );

    expect(workflowStat.size).toBeGreaterThan(0);
    expect(workflowGzipStat.size).toBeLessThan(MANUAL_AGENT_SESSION_LAZY_GZIP_BUDGET_BYTES);
    expect(workflowClosureGzipBytes).toBeLessThan(
      MANUAL_AGENT_SESSION_LAZY_CLOSURE_GZIP_BUDGET_BYTES,
    );
    expect(workflowGzipStat.mtimeMs).toBeGreaterThanOrEqual(workflowStat.mtimeMs);
    for (const lazyAsset of workflowClosure) expect(preloadedAssets).not.toContain(lazyAsset);
    expect(workflowSource).toContain('Managed agent-session replacement is unavailable.');
  });
});
