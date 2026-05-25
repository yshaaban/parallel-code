import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BadRequestError } from './errors.js';

export function validatePath(p: unknown, label: string): asserts p is string {
  if (typeof p !== 'string') throw new BadRequestError(`${label} must be a string`);
  if (!path.isAbsolute(p)) throw new BadRequestError(`${label} must be absolute`);
  if (p.includes('..')) throw new BadRequestError(`${label} must not contain ".."`);
}

export function validateRelativePath(p: unknown, label: string): asserts p is string {
  if (typeof p !== 'string') throw new BadRequestError(`${label} must be a string`);
  if (path.isAbsolute(p)) throw new BadRequestError(`${label} must not be absolute`);
  if (p.includes('..')) throw new BadRequestError(`${label} must not contain ".."`);
}

export function validateBranchName(name: unknown, label: string): asserts name is string {
  if (typeof name !== 'string' || !name) {
    throw new BadRequestError(`${label} must be a non-empty string`);
  }
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
  } catch {
    throw new BadRequestError(`${label} must be a valid branch name`);
  }
}

export function validateOptionalBranchName(
  name: unknown,
  label: string,
): asserts name is string | undefined {
  if (name === undefined) {
    return;
  }

  validateBranchName(name, label);
}

export function getHomeDirectory(): string {
  return os.homedir() || process.env.HOME || process.env.USERPROFILE || '/';
}

export function getProjectBaseDirectory(): string {
  const configuredPath = process.env.PARALLEL_CODE_PROJECTS_DIR?.trim();
  if (!configuredPath) {
    return getHomeDirectory();
  }

  if (!path.isAbsolute(configuredPath) || hasTraversalSegment(configuredPath)) {
    return getHomeDirectory();
  }

  return path.normalize(configuredPath);
}

export function hasTraversalSegment(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/).some((segment) => segment === '..');
}

function isRelativeChildPath(relativePath: string): boolean {
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return isRelativeChildPath(relativePath);
}

export function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relativePath === '' || isRelativeChildPath(relativePath);
}

export function resolveUserPath(inputPath: string): string {
  const home = getHomeDirectory();
  let resolvedPath = inputPath.trim();

  if (resolvedPath === '~' || resolvedPath === '~/') {
    resolvedPath = home;
  } else if (resolvedPath.startsWith('~/')) {
    const homeRelativePath = resolvedPath.slice(2);
    if (hasTraversalSegment(homeRelativePath)) {
      throw new BadRequestError('path must not contain ".."');
    }
    resolvedPath = path.join(home, homeRelativePath);
  }

  if (!path.isAbsolute(resolvedPath)) {
    throw new BadRequestError('path must be absolute');
  }
  if (hasTraversalSegment(resolvedPath)) {
    throw new BadRequestError('path must not contain ".."');
  }

  return path.normalize(resolvedPath);
}

export function compareDirectoryNames(a: string, b: string): number {
  const aHidden = a.startsWith('.');
  const bHidden = b.startsWith('.');
  if (aHidden !== bHidden) return aHidden ? 1 : -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export async function statIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

export function normalizeAbsolutePath(candidatePath: string): string | null {
  if (typeof candidatePath !== 'string') return null;
  const trimmed = candidatePath.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || hasTraversalSegment(trimmed)) {
    return null;
  }
  return path.normalize(trimmed);
}

export async function resolveExistingDirectory(
  candidatePath: string | null,
): Promise<string | null> {
  const normalizedPath = normalizeAbsolutePath(candidatePath ?? '');
  if (!normalizedPath) return null;
  const stats = await statIfExists(normalizedPath);
  return stats?.isDirectory() ? normalizedPath : null;
}
