import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const changedFilesListSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/ChangedFilesList.tsx'),
  'utf8',
);
const reviewPanelSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/ReviewPanel.tsx'),
  'utf8',
);

describe('review surface architecture guardrails', () => {
  it('keeps changed-files freshness behind shared review-file adapters', () => {
    expect(changedFilesListSource).toContain('fetchTaskReviewFiles');
    expect(changedFilesListSource).not.toContain('IPC.GetProjectDiff');
    expect(changedFilesListSource).not.toContain('IPC.GetChangedFilesFromBranch');
    expect(changedFilesListSource).not.toContain('invoke(');
  });

  it('keeps review file-list freshness behind shared review-file adapters', () => {
    expect(reviewPanelSource).toContain('fetchTaskReviewFiles');
    expect(reviewPanelSource).toContain('createAsyncRequestGuard');
    expect(reviewPanelSource).not.toContain('IPC.GetProjectDiff');
    expect(reviewPanelSource).not.toContain('IPC.GetChangedFilesFromBranch');
  });
});
