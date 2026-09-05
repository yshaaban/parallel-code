import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ABSOLUTE_RENDERER_MAIN_GZIP_BUDGET_BYTES,
  INTEGRATED_RENDERER_MAIN_GZIP_BASELINE_BYTES,
  INTEGRATED_RENDERER_MAIN_GZIP_BUDGET_BYTES,
  INTEGRATED_RENDERER_MAIN_GZIP_DRIFT_BUDGET_BYTES,
  measureFreshRendererMainBundle,
} from './renderer-main-bundle';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const DIST_ASSETS_DIR = path.join(DIST_DIR, 'assets');
const DIST_INDEX_PATH = path.join(DIST_DIR, 'index.html');
// Fresh isolated D04 before/after production artifacts captured on this workspace on 2026-08-03.
// These remain attribution evidence; final integrated bundles use the shared regression baseline.
const HISTORICAL_PRE_D04_MAIN_GZIP_BYTES = 218_255;
const HISTORICAL_POST_D04_MAIN_GZIP_BYTES = 218_437;
const HISTORICAL_PRE_D04_TERMINAL_SESSION_GZIP_BYTES = 108_538;
const HISTORICAL_POST_D04_TERMINAL_SESSION_GZIP_BYTES = 109_566;
const INTEGRATED_TERMINAL_SESSION_GZIP_BASELINE_BYTES = 109_565;
const INTEGRATED_TERMINAL_SESSION_GZIP_DRIFT_BUDGET_BYTES = 1_024;
const ADDON_SEARCH_GZIP_BUDGET_BYTES = 30 * 1_024;

function getUniqueChunkName(assetNames: string[], pattern: RegExp, label: string): string {
  const matches = assetNames.filter((name) => pattern.test(name));
  expect(matches, label).toHaveLength(1);
  return matches[0];
}

async function getFreshGzipBytes(assetName: string): Promise<number> {
  const assetPath = path.join(DIST_ASSETS_DIR, assetName);
  const gzipPath = `${assetPath}.gz`;
  const [assetStat, gzipStat] = await Promise.all([stat(assetPath), stat(gzipPath)]);
  expect(assetStat.size).toBeGreaterThan(0);
  expect(gzipStat.size).toBeGreaterThan(0);
  expect(gzipStat.mtimeMs).toBeGreaterThanOrEqual(assetStat.mtimeMs);
  return gzipStat.size;
}

describe('terminal search bundle budget', () => {
  it('keeps search lazy and within the renderer chunk budgets', async () => {
    const [indexHtml, assetNames] = await Promise.all([
      readFile(DIST_INDEX_PATH, 'utf8'),
      readdir(DIST_ASSETS_DIR),
    ]);
    const terminalSessionName = getUniqueChunkName(
      assetNames,
      /^terminal-session-[^.]+\.js$/u,
      'terminal session chunk',
    );
    const addonSearchName = getUniqueChunkName(
      assetNames,
      /^addon-search-[^.]+\.js$/u,
      'terminal search addon chunk',
    );
    const [mainBundle, terminalSessionGzipBytes, addonSearchGzipBytes] = await Promise.all([
      measureFreshRendererMainBundle(),
      getFreshGzipBytes(terminalSessionName),
      getFreshGzipBytes(addonSearchName),
    ]);

    const eagerSearchLinks = (indexHtml.match(/<link\b[^>]*>/giu) ?? []).filter(
      (tag) =>
        /\brel=["'](?:modulepreload|prefetch)["']/iu.test(tag) &&
        /\bhref=["'][^"']*addon-search-[^"']+\.js["']/iu.test(tag),
    );
    expect(eagerSearchLinks).toEqual([]);
    expect(mainBundle.gzipBytes).toBeLessThan(ABSOLUTE_RENDERER_MAIN_GZIP_BUDGET_BYTES);
    expect(mainBundle.gzipBytes).toBeLessThanOrEqual(INTEGRATED_RENDERER_MAIN_GZIP_BUDGET_BYTES);
    expect(terminalSessionGzipBytes).toBeLessThanOrEqual(
      INTEGRATED_TERMINAL_SESSION_GZIP_BASELINE_BYTES +
        INTEGRATED_TERMINAL_SESSION_GZIP_DRIFT_BUDGET_BYTES,
    );
    expect(addonSearchGzipBytes).toBeLessThanOrEqual(ADDON_SEARCH_GZIP_BUDGET_BYTES);

    process.stdout.write(
      `${[
        'terminal-search-bundle',
        `main=${mainBundle.gzipBytes}B`,
        `integrationMainBaseline=${INTEGRATED_RENDERER_MAIN_GZIP_BASELINE_BYTES}B`,
        `integrationMainDelta=${mainBundle.gzipBytes - INTEGRATED_RENDERER_MAIN_GZIP_BASELINE_BYTES}B`,
        `integrationMainDriftBudget=${INTEGRATED_RENDERER_MAIN_GZIP_DRIFT_BUDGET_BYTES}B`,
        `historicalD04MainDelta=${HISTORICAL_POST_D04_MAIN_GZIP_BYTES - HISTORICAL_PRE_D04_MAIN_GZIP_BYTES}B`,
        `terminalSession=${terminalSessionGzipBytes}B`,
        `integrationTerminalSessionBaseline=${INTEGRATED_TERMINAL_SESSION_GZIP_BASELINE_BYTES}B`,
        `integrationTerminalSessionDelta=${terminalSessionGzipBytes - INTEGRATED_TERMINAL_SESSION_GZIP_BASELINE_BYTES}B`,
        `historicalD04TerminalSessionDelta=${HISTORICAL_POST_D04_TERMINAL_SESSION_GZIP_BYTES - HISTORICAL_PRE_D04_TERMINAL_SESSION_GZIP_BYTES}B`,
        `addonSearch=${addonSearchGzipBytes}B`,
      ].join(' ')}\n`,
    );
  });
});
