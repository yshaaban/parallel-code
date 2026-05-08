import type { ChangedFile } from '../ipc/types';
import { isHydraCoordinationArtifact } from './hydra';

export type ChangedFilesLineTotalMode = 'all' | 'committed';

export interface ChangedFilesVisibleFileStats {
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  uncommittedCount: number;
}

export interface ChangedFilesVisibilityModel {
  hiddenHydraArtifactCount: number;
  visibleFiles: ReadonlyArray<ChangedFile>;
}

interface ChangedFilesVisibilityOptions {
  filterHydraArtifacts: boolean;
  includeFile?: (file: ChangedFile) => boolean;
  showHydraArtifacts: boolean;
}

export function getChangedFilesVisibleFileStats(
  files: ReadonlyArray<ChangedFile>,
  lineTotalMode: ChangedFilesLineTotalMode,
): ChangedFilesVisibleFileStats {
  const stats: ChangedFilesVisibleFileStats = {
    fileCount: files.length,
    totalAdded: 0,
    totalRemoved: 0,
    uncommittedCount: 0,
  };

  for (const file of files) {
    if (!file.committed) {
      stats.uncommittedCount += 1;
      if (lineTotalMode === 'committed') {
        continue;
      }
    }

    stats.totalAdded += file.lines_added;
    stats.totalRemoved += file.lines_removed;
  }

  return stats;
}

export function getChangedFilesVisibilityModel(
  files: ReadonlyArray<ChangedFile>,
  options: ChangedFilesVisibilityOptions,
): ChangedFilesVisibilityModel {
  if (!options.filterHydraArtifacts && !options.includeFile) {
    return {
      hiddenHydraArtifactCount: 0,
      visibleFiles: files,
    };
  }

  let hiddenHydraArtifactCount = 0;
  const visibleFiles: ChangedFile[] = [];

  for (const file of files) {
    const isHydraArtifact = options.filterHydraArtifacts && isHydraCoordinationArtifact(file.path);
    if (isHydraArtifact) {
      hiddenHydraArtifactCount += 1;
    }

    if (options.includeFile && !options.includeFile(file)) {
      continue;
    }

    if (isHydraArtifact && !options.showHydraArtifacts) {
      continue;
    }

    visibleFiles.push(file);
  }

  return {
    hiddenHydraArtifactCount,
    visibleFiles,
  };
}
