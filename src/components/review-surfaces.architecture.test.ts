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
const reviewPanelControllerSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/review-panel/review-panel-controller.ts'),
  'utf8',
);
const reviewPanelDiffPaneSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/review-panel/ReviewPanelDiffPane.tsx'),
  'utf8',
);
const reviewSurfaceSessionSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/review-surface-session.ts'),
  'utf8',
);
const diffViewerDialogSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/DiffViewerDialog.tsx'),
  'utf8',
);
const planViewerDialogSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/PlanViewerDialog.tsx'),
  'utf8',
);

describe('review surface architecture guardrails', () => {
  it('keeps changed-files freshness behind shared review-file adapters', () => {
    expect(changedFilesListSource).toContain('fetchTaskReviewFiles');
    expect(changedFilesListSource).not.toContain('IPC.GetProjectDiff');
    expect(changedFilesListSource).not.toContain('IPC.GetChangedFilesFromBranch');
    expect(changedFilesListSource).not.toContain('invoke(');
  });

  it('keeps review loading state behind the named review-panel controller', () => {
    expect(reviewPanelSource).toContain('createReviewPanelController');
    expect(reviewPanelSource).not.toContain('createAsyncRequestGuard');
    expect(reviewPanelSource).not.toContain('fetchTaskReviewFiles');
    expect(reviewPanelSource).not.toContain('fetchTaskFileDiff');
    expect(reviewPanelSource).not.toContain('IPC.');
    expect(reviewPanelSource).not.toContain('invoke(');
    expect(reviewPanelControllerSource).toContain('createAsyncRequestGuard');
    expect(reviewPanelControllerSource).toContain('fetchTaskReviewFiles');
    expect(reviewPanelControllerSource).toContain('fetchTaskFileDiff');
  });

  it('keeps the embedded review panel on the shared review-session/sidebar flow', () => {
    expect(reviewPanelSource).toContain('createReviewSurfaceSession');
    expect(reviewPanelSource).toContain('ReviewPanelDiffPane');
    expect(reviewPanelSource).not.toContain('copyReviewCommentsPrompt');
    expect(reviewPanelSource).not.toContain('createTaskReviewSession');
    expect(reviewPanelSource).not.toContain('createReviewCommentCopyController');
    expect(reviewPanelSource).not.toContain('createReviewSidebarProps');
    expect(reviewPanelSource).toContain('startAskAboutCodeSession');
    expect(reviewPanelSource).not.toContain('<ReviewSidebar');
  });

  it('keeps the embedded review diff pane presentational', () => {
    expect(reviewPanelDiffPaneSource).toContain('ReviewSidebar');
    expect(reviewPanelDiffPaneSource).toContain('ScrollingDiffView');
    expect(reviewPanelDiffPaneSource).toContain('MonacoDiffEditor');
    expect(reviewPanelDiffPaneSource).not.toContain('fetchTaskReviewFiles');
    expect(reviewPanelDiffPaneSource).not.toContain('invoke(');
    expect(reviewPanelDiffPaneSource).not.toContain('startAskAboutCodeSession');
  });

  it('keeps plan review on the shared review-session/sidebar export flow', () => {
    expect(reviewSurfaceSessionSource).toContain('createTaskReviewSession');
    expect(reviewSurfaceSessionSource).toContain('createReviewSidebarProps');
    expect(diffViewerDialogSource).toContain('createReviewSurfaceSession');
    expect(diffViewerDialogSource).not.toContain('createTaskReviewSession');
    expect(diffViewerDialogSource).not.toContain('createReviewCommentCopyController');
    expect(diffViewerDialogSource).not.toContain('createReviewSidebarProps');
    expect(diffViewerDialogSource).not.toContain('copyReviewCommentsPrompt');
    expect(planViewerDialogSource).toContain('createReviewSurfaceSession');
    expect(planViewerDialogSource).not.toContain('createTaskReviewSession');
    expect(planViewerDialogSource).not.toContain('createReviewCommentCopyController');
    expect(planViewerDialogSource).not.toContain('createReviewSidebarProps');
    expect(planViewerDialogSource).toContain('ReviewSidebar');
    expect(planViewerDialogSource).not.toContain('copyReviewCommentsPrompt');
  });
});
