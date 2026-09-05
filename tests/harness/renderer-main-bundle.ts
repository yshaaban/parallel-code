import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const ABSOLUTE_RENDERER_MAIN_GZIP_BUDGET_BYTES = 250 * 1_024;

// Recaptured with the repository-pinned Node 24.19.0/npm 11.17.0 toolchain after the 2026-08-03
// feature set was integrated and manual session policy moved behind its explicit action boundary.
// This is deliberately separate from each feature's historical attribution evidence.
export const INTEGRATED_RENDERER_MAIN_GZIP_BASELINE_BYTES = 214_614;
export const INTEGRATED_RENDERER_MAIN_GZIP_DRIFT_BUDGET_BYTES = 1_024;
export const INTEGRATED_RENDERER_MAIN_GZIP_BUDGET_BYTES =
  INTEGRATED_RENDERER_MAIN_GZIP_BASELINE_BYTES + INTEGRATED_RENDERER_MAIN_GZIP_DRIFT_BUDGET_BYTES;

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIST_INDEX_PATH = path.join(PROJECT_ROOT, 'dist', 'index.html');

export interface RendererMainBundleMeasurement {
  entryRelativePath: string;
  gzipBytes: number;
  rawBytes: number;
}

function getMainEntryRelativePath(indexHtml: string): string {
  const moduleScripts = [...indexHtml.matchAll(/<script\b[^>]*><\/script>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\btype=["']module["']/iu.test(tag));
  if (moduleScripts.length !== 1) {
    throw new Error(
      `Expected one module entry in ${DIST_INDEX_PATH}; found ${moduleScripts.length}`,
    );
  }

  const source = moduleScripts[0]?.match(/\bsrc=["']\.\/([^"']+\.js)["']/iu)?.[1];
  if (!source || !/^assets\/index-[^/]+\.js$/u.test(source)) {
    throw new Error(`Unable to identify the Vite main entry from ${DIST_INDEX_PATH}`);
  }
  return source;
}

export async function measureFreshRendererMainBundle(): Promise<RendererMainBundleMeasurement> {
  const indexHtml = await readFile(DIST_INDEX_PATH, 'utf8');
  const entryRelativePath = getMainEntryRelativePath(indexHtml);
  const entryPath = path.join(PROJECT_ROOT, 'dist', entryRelativePath);
  const gzipPath = `${entryPath}.gz`;
  const [entryStat, gzipStat] = await Promise.all([stat(entryPath), stat(gzipPath)]);
  if (entryStat.size <= 0 || gzipStat.size <= 0) {
    throw new Error(`Renderer main entry or gzip sibling is empty: ${entryRelativePath}`);
  }
  if (gzipStat.mtimeMs < entryStat.mtimeMs) {
    throw new Error(`Renderer main gzip sibling is stale: ${entryRelativePath}.gz`);
  }
  return {
    entryRelativePath,
    gzipBytes: gzipStat.size,
    rawBytes: entryStat.size,
  };
}
