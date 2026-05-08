import { describe, expect, it } from 'vitest';
import { getChangedFileDisplayEntries, isDiffableChangedFilePath } from './changed-file-display';

describe('changed-file-display', () => {
  it('uses the shortest unique directory suffix for repeated filenames', () => {
    expect(
      getChangedFileDisplayEntries([
        { path: 'src/app/index.ts' },
        { path: 'src/lib/index.ts' },
        { path: 'tests/lib/index.ts' },
        { path: 'src/app/main.ts' },
      ]),
    ).toEqual([
      { disambig: 'app/', fullPath: 'src/app/index.ts', name: 'index.ts' },
      { disambig: 'src/lib/', fullPath: 'src/lib/index.ts', name: 'index.ts' },
      { disambig: 'tests/lib/', fullPath: 'tests/lib/index.ts', name: 'index.ts' },
      { disambig: '', fullPath: 'src/app/main.ts', name: 'main.ts' },
    ]);
  });

  it('preserves root-file and repeated-path disambiguation edge cases', () => {
    expect(
      getChangedFileDisplayEntries([
        { path: 'index.ts' },
        { path: 'src/index.ts' },
        { path: 'src/app.ts' },
        { path: 'src/app.ts' },
      ]),
    ).toEqual([
      { disambig: '', fullPath: 'index.ts', name: 'index.ts' },
      { disambig: 'src/', fullPath: 'src/index.ts', name: 'index.ts' },
      { disambig: 'src/', fullPath: 'src/app.ts', name: 'app.ts' },
      { disambig: 'src/', fullPath: 'src/app.ts', name: 'app.ts' },
    ]);
  });

  it('keeps diffable file path checks explicit', () => {
    expect(isDiffableChangedFilePath('src/app.ts')).toBe(true);
    expect(isDiffableChangedFilePath('src/')).toBe(false);
    expect(isDiffableChangedFilePath('   ')).toBe(false);
  });
});
