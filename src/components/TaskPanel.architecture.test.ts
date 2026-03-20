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

describe('task panel architecture guardrails', () => {
  it('keeps task-panel focus, preview, and dialog orchestration behind named owners', () => {
    expect(taskPanelSource).toContain('createTaskPanelFocusRuntime');
    expect(taskPanelSource).toContain('createTaskPanelPreviewController');
    expect(taskPanelSource).toContain('createTaskPanelDialogState');
    expect(taskPanelSource).toContain('createTaskPanelPermissionController');
    expect(taskPanelSource).not.toContain('handlePermissionResponse');
    expect(taskPanelSource).not.toContain('permissionRequests[');
  });

  it('keeps permission response in the app-layer permission workflow owner', () => {
    expect(taskPermissionWorkflowsSource).toContain('handleTaskPermissionResponse');
    expect(taskPanelPermissionControllerSource).toContain('handleTaskPermissionResponse');
  });

  it('keeps the preview section presentational', () => {
    expect(taskPreviewSectionSource).toContain('onFocusPreview');
    expect(taskPreviewSectionSource).not.toContain('store/store');
    expect(taskPreviewSectionSource).not.toContain('setTaskFocusedPanel');
  });
});
