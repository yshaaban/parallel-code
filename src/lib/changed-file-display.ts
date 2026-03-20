import type { ChangedFile } from '../ipc/types';

export interface ChangedFileDisplayEntry {
  disambig: string;
  fullPath: string;
  name: string;
}

function normalizeDisplayPath(filePath: string): string {
  return filePath.replace(/\/+$/, '');
}

function splitDisplayPath(filePath: string): { dir: string; name: string } {
  const normalizedPath = normalizeDisplayPath(filePath);
  if (normalizedPath === '') {
    return { dir: '', name: filePath };
  }

  const separatorIndex = normalizedPath.lastIndexOf('/');
  if (separatorIndex === -1) {
    return { dir: '', name: normalizedPath };
  }

  return {
    dir: normalizedPath.slice(0, separatorIndex),
    name: normalizedPath.slice(separatorIndex + 1),
  };
}

export function isDiffableChangedFilePath(filePath: string): boolean {
  const trimmedPath = filePath.trim();
  return trimmedPath !== '' && !trimmedPath.endsWith('/');
}

export function getChangedFileDisplayEntries(
  files: ReadonlyArray<Pick<ChangedFile, 'path'>>,
): ChangedFileDisplayEntry[] {
  const nameCounts = new Map<string, number>();
  const parsedFiles = files.map((file) => {
    const { dir, name } = splitDisplayPath(file.path);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    return { dir, fullPath: file.path, name };
  });

  return parsedFiles.map((file) => {
    if ((nameCounts.get(file.name) ?? 0) <= 1 || !file.dir) {
      return { name: file.name, disambig: '', fullPath: file.fullPath };
    }

    const siblingFiles = parsedFiles.filter(
      (candidate) => candidate.name === file.name && candidate.fullPath !== file.fullPath,
    );
    const pathSegments = file.dir.split('/');

    for (let depth = 1; depth <= pathSegments.length; depth += 1) {
      const suffix = pathSegments.slice(pathSegments.length - depth).join('/');
      const isUnique = siblingFiles.every((candidate) => {
        const candidateSegments = candidate.dir.split('/');
        const candidateSuffix = candidateSegments.slice(candidateSegments.length - depth).join('/');
        return candidateSuffix !== suffix;
      });

      if (isUnique) {
        return { name: file.name, disambig: `${suffix}/`, fullPath: file.fullPath };
      }
    }

    return { name: file.name, disambig: `${file.dir}/`, fullPath: file.fullPath };
  });
}
