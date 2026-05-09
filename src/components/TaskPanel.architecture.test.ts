import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const taskPanelSource = readFileSync(
  path.resolve(projectRoot, 'src/components/TaskPanel.tsx'),
  'utf8',
);
const taskPanelPermissionControllerSource = readFileSync(
  path.resolve(projectRoot, 'src/components/task-panel/task-panel-permission-controller.ts'),
  'utf8',
);
const taskPermissionWorkflowsSource = readFileSync(
  path.resolve(projectRoot, 'src/app/task-permission-workflows.ts'),
  'utf8',
);
const taskPreviewSectionSource = readFileSync(
  path.resolve(projectRoot, 'src/components/task-panel/TaskPreviewSection.tsx'),
  'utf8',
);
const taskNotesFilesSectionSource = readFileSync(
  path.resolve(projectRoot, 'src/components/task-panel/TaskNotesFilesSection.tsx'),
  'utf8',
);
const taskPlanContentSource = readFileSync(
  path.resolve(projectRoot, 'src/components/task-panel/TaskPlanContent.tsx'),
  'utf8',
);
const taskStepsSectionSource = readFileSync(
  path.resolve(projectRoot, 'src/components/task-panel/TaskStepsSection.tsx'),
  'utf8',
);

describe('task panel architecture guardrails', () => {
  it('keeps task-panel focus, preview, and dialog orchestration behind named owners', () => {
    expect(taskPanelSource).toContain('createTaskPanelFocusRuntime');
    expect(taskPanelSource).toContain('createTaskPanelPreviewController');
    expect(taskPanelSource).toContain('createTaskPanelDialogState');
    expect(taskPanelSource).toContain('createTaskPanelPermissionController');
    expect(taskPanelSource).toContain('createTaskPanelStepsController');
    expect(taskPanelSource).not.toContain('handlePermissionResponse');
    expect(taskPanelSource).not.toContain('permissionRequests[');
    expect(taskPanelSource).not.toContain('setPrefillPrompt(');
  });

  it('keeps permission response in the app-layer permission workflow owner', () => {
    expect(taskPermissionWorkflowsSource).toContain('handleTaskPermissionResponse');
    expect(taskPanelPermissionControllerSource).toContain('handleTaskPermissionResponse');
  });

  it('keeps the preview section presentational', () => {
    expect(taskPreviewSectionSource).toContain('lazyNamed(() =>');
    expect(taskPreviewSectionSource).toContain("import('../PreviewPanel')");
    expect(taskPreviewSectionSource).toContain('onFocusPreview');
    expect(taskPreviewSectionSource).toContain(
      "import type { PreviewPanelProps } from '../PreviewPanel'",
    );
    expect(taskPreviewSectionSource).not.toMatch(
      /^import\s+(?!type)[^;]*from\s+['"]\.\.\/PreviewPanel['"]/mu,
    );
    expect(taskPreviewSectionSource).not.toContain('store/store');
    expect(taskPreviewSectionSource).not.toContain('setTaskFocusedPanel');
  });

  it('keeps plan markdown rendering out of the default task panel startup path', () => {
    expect(taskNotesFilesSectionSource).toContain('lazyNamed(() =>');
    expect(taskNotesFilesSectionSource).toContain("import('./TaskPlanContent')");
    expect(taskNotesFilesSectionSource).not.toContain('marked-shiki');
    expect(taskPlanContentSource).toContain('renderMarkdownSafely');
  });

  it('keeps the embedded review panel out of the default task panel startup path', () => {
    expect(taskNotesFilesSectionSource).toContain('lazyNamed(() =>');
    expect(taskNotesFilesSectionSource).toContain("import('../ReviewPanel')");
    expect(taskNotesFilesSectionSource).not.toMatch(/from\s+['"]\.\.\/ReviewPanel['"]/u);
  });

  it('keeps the steps section presentational', () => {
    expect(taskStepsSectionSource).toContain('onNextClick');
    expect(taskStepsSectionSource).toContain('onJumpToStep');
    expect(taskStepsSectionSource).not.toContain('setPrefillPrompt');
    expect(taskStepsSectionSource).not.toContain('setTaskFocusedPanel');
    expect(taskStepsSectionSource).not.toContain('invoke(');
  });
});
