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
const taskNotesFilesSectionEntrySource = readFileSync(
  path.resolve(projectRoot, 'src/components/task-panel/TaskNotesFilesSectionEntry.tsx'),
  'utf8',
);
const taskCoordinatorSectionEntrySource = readFileSync(
  path.resolve(projectRoot, 'src/components/task-panel/TaskCoordinatorSectionEntry.tsx'),
  'utf8',
);
const coordinatorAttentionSource = readFileSync(
  path.resolve(projectRoot, 'src/app/coordinator-attention.ts'),
  'utf8',
);
const taskPresentationStatusSource = readFileSync(
  path.resolve(projectRoot, 'src/app/task-presentation-status.ts'),
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
const taskTitleBarSource = readFileSync(
  path.resolve(projectRoot, 'src/components/TaskTitleBar.tsx'),
  'utf8',
);
const taskPanelDialogStateSource = readFileSync(
  path.resolve(projectRoot, 'src/components/task-panel/task-panel-dialog-state.ts'),
  'utf8',
);
const taskGitActionCapabilitySource = readFileSync(
  path.resolve(projectRoot, 'src/app/task-git-action-capability.ts'),
  'utf8',
);
const appShortcutsSource = readFileSync(
  path.resolve(projectRoot, 'src/runtime/app-shortcuts.ts'),
  'utf8',
);
const taskLifecycleWorkflowsSource = readFileSync(
  path.resolve(projectRoot, 'src/app/task-lifecycle-workflows.ts'),
  'utf8',
);
const projectWorkflowsSource = readFileSync(
  path.resolve(projectRoot, 'src/app/project-workflows.ts'),
  'utf8',
);
const taskNotesRecoveryChannelSource = readFileSync(
  path.resolve(projectRoot, 'src/app/task-notes-recovery-channel.ts'),
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

  it('keeps typed task-note conflict and autosave policy out of the default task panel path', () => {
    expect(taskNotesFilesSectionSource).toContain("import('./TypedTaskNotesEditor')");
    expect(taskNotesFilesSectionSource).not.toContain('getTaskNotesPresentation');
    expect(taskNotesFilesSectionSource).not.toContain("import('../../app/task-notes-runtime')");
  });

  it('keeps structural task-note retirement behind the lightweight lazy-runtime channel', () => {
    expect(taskLifecycleWorkflowsSource).toContain("from './task-notes-recovery-channel'");
    expect(projectWorkflowsSource).toContain("from './task-notes-recovery-channel'");
    expect(taskLifecycleWorkflowsSource).not.toContain("from './task-notes-runtime'");
    expect(projectWorkflowsSource).not.toContain("from './task-notes-runtime'");
    expect(taskNotesRecoveryChannelSource).not.toContain('task-notes-controller');
    expect(taskNotesRecoveryChannelSource).not.toContain('task-notes-runtime');
    expect(taskNotesRecoveryChannelSource).not.toContain('task-notes-transport');
  });

  it('keeps the secondary notes and changed-files surface out of the first-parse task path', () => {
    expect(taskPanelSource).toContain("from './task-panel/TaskNotesFilesSectionEntry'");
    expect(taskNotesFilesSectionEntrySource).toContain("import('./TaskNotesFilesSection')");
    expect(taskNotesFilesSectionEntrySource).toContain('ErrorBoundary');
    expect(taskNotesFilesSectionEntrySource).toContain('Suspense');
    expect(taskPanelSource).not.toContain("from './task-panel/TaskNotesFilesSection'");
  });

  it('keeps the embedded review panel out of the default task panel startup path', () => {
    expect(taskNotesFilesSectionSource).toContain('lazyNamed(() =>');
    expect(taskNotesFilesSectionSource).toContain("import('../ReviewPanel')");
    expect(taskNotesFilesSectionSource).not.toMatch(/from\s+['"]\.\.\/ReviewPanel['"]/u);
  });

  it('keeps the coordinator inspector out of the default task panel startup path', () => {
    expect(taskPanelSource).toContain("from './task-panel/TaskCoordinatorSectionEntry'");
    expect(taskCoordinatorSectionEntrySource).toContain('lazyNamed(');
    expect(taskCoordinatorSectionEntrySource).toContain("import('./TaskCoordinatorSection')");
    expect(taskCoordinatorSectionEntrySource).not.toMatch(
      /^import\s+(?!type)[^;]*from\s+['"]\.\/TaskCoordinatorSection['"]/mu,
    );
    expect(taskCoordinatorSectionEntrySource).toContain('ErrorBoundary');
    expect(taskCoordinatorSectionEntrySource).toContain('CoordinatorSectionState');
    expect(taskPresentationStatusSource).toContain("from './coordinator-attention'");
    expect(taskPresentationStatusSource).not.toContain("from './coordinator-ui-model'");
    expect(coordinatorAttentionSource).not.toContain('coordinator-ui-model');
    expect(coordinatorAttentionSource).not.toContain('../components/');
  });

  it('keeps the steps section presentational', () => {
    expect(taskStepsSectionSource).toContain('onNextClick');
    expect(taskStepsSectionSource).toContain('onJumpToStep');
    expect(taskStepsSectionSource).not.toContain('setPrefillPrompt');
    expect(taskStepsSectionSource).not.toContain('setTaskFocusedPanel');
    expect(taskStepsSectionSource).not.toContain('invoke(');
  });

  it('keeps merge and push capability in one app-layer owner', () => {
    expect(taskGitActionCapabilitySource).toContain('getTaskGitActionDecision');
    expect(taskGitActionCapabilitySource).toContain('requestTaskGitAction');
    expect(taskPanelSource).toContain('getCurrentTaskGitActionDecision');
    expect(taskPanelSource).toContain('requestTaskGitAction');
    expect(taskPanelDialogStateSource).toContain('getCurrentTaskGitActionDecision');
    expect(taskPanelDialogStateSource).not.toContain('isCurrentBranchTask');
    expect(taskPanelDialogStateSource).not.toContain('isNonGitProject');
    expect(taskTitleBarSource).toContain('props.mergeAvailable');
    expect(taskTitleBarSource).toContain('props.pushAvailable');
    expect(taskTitleBarSource).not.toContain(
      '!isCurrentBranchTask(props.task) && !isNonGitProject(props.task)',
    );
    expect(appShortcutsSource).toContain("requestTaskGitAction('merge'");
    expect(appShortcutsSource).toContain("requestTaskGitAction('push'");
  });
});
