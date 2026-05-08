import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../ipc/types';
import {
  getChangedFilesVisibilityModel,
  getChangedFilesVisibleFileStats,
} from './changed-file-projection';

function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    committed: true,
    lines_added: 3,
    lines_removed: 1,
    path: 'src/app.ts',
    status: 'modified',
    ...overrides,
  };
}

describe('changed-file-projection', () => {
  it('keeps visible file stats mode explicit', () => {
    const files = [
      createChangedFile({ committed: true, lines_added: 4, lines_removed: 1 }),
      createChangedFile({ committed: false, lines_added: 7, lines_removed: 2 }),
    ];

    expect(getChangedFilesVisibleFileStats(files, 'committed')).toEqual({
      fileCount: 2,
      totalAdded: 4,
      totalRemoved: 1,
      uncommittedCount: 1,
    });
    expect(getChangedFilesVisibleFileStats(files, 'all')).toEqual({
      fileCount: 2,
      totalAdded: 11,
      totalRemoved: 3,
      uncommittedCount: 1,
    });
  });

  it('derives Hydra visibility and hidden counts in one projection', () => {
    const files = [
      createChangedFile({ path: 'docs/coordination/plan.json' }),
      createChangedFile({ path: 'src/app.ts' }),
    ];

    expect(
      getChangedFilesVisibilityModel(files, {
        filterHydraArtifacts: true,
        showHydraArtifacts: false,
      }),
    ).toEqual({
      hiddenHydraArtifactCount: 1,
      visibleFiles: [files[1]],
    });
    expect(
      getChangedFilesVisibilityModel(files, {
        filterHydraArtifacts: true,
        showHydraArtifacts: true,
      }),
    ).toEqual({
      hiddenHydraArtifactCount: 1,
      visibleFiles: files,
    });
  });

  it('counts hidden Hydra artifacts even when they are excluded by another visibility predicate', () => {
    const files = [
      createChangedFile({ path: 'docs/coordination/' }),
      createChangedFile({ path: 'src/app.ts' }),
    ];

    expect(
      getChangedFilesVisibilityModel(files, {
        filterHydraArtifacts: true,
        includeFile: (file) => !file.path.endsWith('/'),
        showHydraArtifacts: true,
      }),
    ).toEqual({
      hiddenHydraArtifactCount: 1,
      visibleFiles: [files[1]],
    });
  });
});
