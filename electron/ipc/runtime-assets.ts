import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_ANCESTOR_DEPTH = 8;

export interface RuntimeAssetSearchOptions {
  extraRoots?: string[];
  maxAncestorDepth?: number;
  startDir?: string;
}

function addExistingCandidateRoot(roots: Set<string>, value: string | undefined): void {
  if (!value) {
    return;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  roots.add(path.resolve(trimmed));
}

function addAncestorRoots(
  roots: Set<string>,
  startDir: string | undefined,
  maxAncestorDepth: number,
): void {
  if (!startDir) {
    return;
  }

  let current = path.resolve(startDir);
  for (let depth = 0; depth <= maxAncestorDepth; depth += 1) {
    roots.add(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

export function getRuntimeAssetCandidateRoots(options: RuntimeAssetSearchOptions = {}): string[] {
  const maxAncestorDepth = options.maxAncestorDepth ?? DEFAULT_MAX_ANCESTOR_DEPTH;
  const roots = new Set<string>();
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;

  addAncestorRoots(roots, options.startDir, maxAncestorDepth);
  addAncestorRoots(roots, process.cwd(), maxAncestorDepth);
  addAncestorRoots(roots, path.dirname(process.execPath), maxAncestorDepth);
  addExistingCandidateRoot(roots, process.env.PARALLEL_CODE_APP_ROOT);
  addExistingCandidateRoot(roots, resourcesPath);
  if (resourcesPath) {
    addExistingCandidateRoot(roots, path.join(resourcesPath, 'app.asar'));
    addExistingCandidateRoot(roots, path.join(resourcesPath, 'app'));
  }

  for (const root of options.extraRoots ?? []) {
    addExistingCandidateRoot(roots, root);
  }

  return Array.from(roots);
}

export function getRuntimeAssetCandidates(
  relativePath: string,
  options: RuntimeAssetSearchOptions = {},
): string[] {
  return getRuntimeAssetCandidateRoots(options).map((root) => path.join(root, relativePath));
}

export function findRuntimeAsset(
  relativePath: string,
  options: RuntimeAssetSearchOptions = {},
): string | null {
  for (const candidate of getRuntimeAssetCandidates(relativePath, options)) {
    const stats = fs.statSync(candidate, { throwIfNoEntry: false });
    if (stats?.isFile()) {
      return candidate;
    }
  }

  return null;
}
