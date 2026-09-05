import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const changedFilesListSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/ChangedFilesList.tsx'),
  'utf8',
);
const closeTaskDialogSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/CloseTaskDialog.tsx'),
  'utf8',
);
const mergeDialogSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/MergeDialog.tsx'),
  'utf8',
);
const newTaskDialogSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/NewTaskDialog.tsx'),
  'utf8',
);
const settingsDialogSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/SettingsDialog.tsx'),
  'utf8',
);
const symlinkDirPickerSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/SymlinkDirPicker.tsx'),
  'utf8',
);
const newTaskDefaultsSettingsSectionSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/settings/NewTaskDefaultsSettingsSection.tsx'),
  'utf8',
);
const taskGitOptionsControllerSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/new-task-dialog/task-git-options-controller.ts'),
  'utf8',
);
const newTaskDraftSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/new-task-dialog/new-task-draft.ts'),
  'utf8',
);
const appSource = readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const appShortcutsSource = readFileSync(
  path.resolve(process.cwd(), 'src/runtime/app-shortcuts.ts'),
  'utf8',
);
const sidebarSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/Sidebar.tsx'),
  'utf8',
);

const APP_CLOSED_SURFACE_MODULES = [
  './arena/ArenaOverlay',
  './components/AddProjectDialog',
  './components/HelpDialog',
  './components/NewTaskDialog',
  './components/PathInputDialog',
  './components/PlanViewerDialog',
  './components/SettingsDialog',
] as const;

const SIDEBAR_CLOSED_SURFACE_MODULES = ['./ConnectPhoneModal', './EditProjectDialog'] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function expectLazyDynamicImport(source: string, modulePath: string): void {
  expect(source).toContain(`import('${modulePath}')`);
  expect(source).not.toMatch(new RegExp(`from\\s+['"]${escapeRegExp(modulePath)}['"]`, 'u'));
}

describe('task dialog architecture guardrails', () => {
  it('keeps destructive dialog git status behind the shared task-git-status owner', () => {
    expect(closeTaskDialogSource).toContain('getTaskGitStatus');
    expect(closeTaskDialogSource).toContain('refreshTaskGitStatusForTask');
    expect(closeTaskDialogSource).not.toContain('IPC.GetWorktreeStatus');
    expect(mergeDialogSource).toContain('getTaskGitStatus');
    expect(mergeDialogSource).toContain('refreshTaskGitStatusForTask');
    expect(mergeDialogSource).not.toContain('IPC.GetWorktreeStatus');
  });

  it('keeps changed-files mode explicit and task-bound merge lists on the task snapshot path', () => {
    expect(changedFilesListSource).toContain("kind: 'task'");
    expect(changedFilesListSource).toContain("kind: 'worktree'");
    expect(mergeDialogSource).toContain('kind="task"');
    expect(mergeDialogSource).toContain('taskId={props.task.id}');
  });

  it('keeps new-task Git option queries behind their form-local controller', () => {
    expect(newTaskDialogSource).toContain('createTaskGitOptionsController');
    expect(newTaskDialogSource).toContain('createsManagedWorktree: createsNewWorktree');
    expect(newTaskDialogSource).not.toContain('IPC.GetGitignoredDirs');
    expect(newTaskDialogSource).not.toContain('IPC.ListBranches');
    expect(taskGitOptionsControllerSource).toContain('IPC.GetGitignoredDirs');
    expect(taskGitOptionsControllerSource).toContain('IPC.ListBranches');
    expect(taskGitOptionsControllerSource).toContain('options.createsManagedWorktree()');
    expect(taskGitOptionsControllerSource).toContain('candidate.isDefault');
    expect(symlinkDirPickerSource).not.toContain('IPC.');
  });

  it('keeps durable new-task defaults separate from each dialog-open form snapshot', () => {
    expect(newTaskDialogSource).toContain("from '../domain/new-task-defaults'");
    expect(newTaskDialogSource).toContain('copyNewTaskDefaults(store.newTaskDefaults)');
    expect(newTaskDialogSource).not.toContain('defaultSkipPermissions');
    expect(newTaskDialogSource).not.toContain('setNewTaskDefault');
    expect(settingsDialogSource).toContain('<NewTaskDefaultsSettingsSection');
    expect(newTaskDefaultsSettingsSectionSource).not.toMatch(/from ['"]\.\.\/\.\.\/store\//u);
  });

  it('keeps New Task initialization and every user close route behind local draft policy', () => {
    expect(newTaskDialogSource).toMatch(/on\(\s*\(\) => props\.open,/u);
    expect(newTaskDialogSource).toContain('draftBaseline = createNewTaskDraftBaseline');
    expect(newTaskDialogSource).toContain('onClose={requestClose}');
    expect(newTaskDialogSource).toContain('onClick={requestClose}');
    expect(newTaskDialogSource).toContain('<ConfirmDialog');
    expect(appShortcutsSource).not.toContain('toggleNewTaskDialog');
    expect(newTaskDraftSource).not.toMatch(/from ['"].*(?:solid|store|ipc)/u);
  });

  it('keeps closed app surfaces out of the eager startup path', () => {
    expect(appSource).toContain('lazyNamed(() =>');
    for (const modulePath of APP_CLOSED_SURFACE_MODULES) {
      expectLazyDynamicImport(appSource, modulePath);
    }
  });

  it('keeps closed sidebar surfaces out of the eager startup path', () => {
    expect(sidebarSource).toContain('lazyNamed(() =>');
    for (const modulePath of SIDEBAR_CLOSED_SURFACE_MODULES) {
      expectLazyDynamicImport(sidebarSource, modulePath);
    }
  });
});
