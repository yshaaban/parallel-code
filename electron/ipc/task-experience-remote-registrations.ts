import type { TaskCatalogState } from './task-catalog-state.js';
import { createTaskCatalogRemoteCommandRegistrations } from './task-catalog-remote-commands.js';
import { createTaskCreationRemoteCommandRegistrations } from './task-creation-remote-commands.js';
import type { TaskCreationWorkflow } from './task-creation-workflow.js';
import { createTaskNotesRemoteCommandRegistrations } from './task-notes-remote-commands.js';
import type { TaskNotesService } from './task-notes-service.js';
import type { RemoteCommandRegistrationTable } from './remote-command-gateway.js';
import type { TaskNotesWriterEntitlement } from './task-notes-writer-entitlements.js';

type TaskNotesRemoteOwner = Pick<
  TaskNotesService,
  'getTaskNotes' | 'issueTaskNotesOperation' | 'updateTaskNotes'
>;

export interface TaskExperienceRemoteRuntime {
  creation: TaskCreationWorkflow;
  notes: TaskNotesRemoteOwner;
}

export interface TaskExperienceRemoteRegistrationDependencies {
  catalog: TaskCatalogState;
  getRuntime(): Promise<TaskExperienceRemoteRuntime>;
  writerEntitlement: TaskNotesWriterEntitlement;
}

function deferredCreation(
  getRuntime: () => Promise<TaskExperienceRemoteRuntime>,
): TaskCreationWorkflow {
  return {
    cancel: async (...args) => (await getRuntime()).creation.cancel(...args),
    create: async (...args) => (await getRuntime()).creation.create(...args),
    get: async (...args) => (await getRuntime()).creation.get(...args),
    getCapabilities: async (...args) => (await getRuntime()).creation.getCapabilities(...args),
    getPickerPage: async (...args) => (await getRuntime()).creation.getPickerPage(...args),
    getWorktreeLinkCandidates: async (...args) =>
      (await getRuntime()).creation.getWorktreeLinkCandidates(...args),
    issue: async (...args) => (await getRuntime()).creation.issue(...args),
    refreshOperation: async (...args) => (await getRuntime()).creation.refreshOperation(...args),
    retryShell: async (...args) => (await getRuntime()).creation.retryShell(...args),
    subscribeOperation: async (...args) =>
      (await getRuntime()).creation.subscribeOperation(...args),
  };
}

function deferredNotes(
  getRuntime: () => Promise<TaskExperienceRemoteRuntime>,
): TaskNotesRemoteOwner {
  return {
    getTaskNotes: async (...args) => (await getRuntime()).notes.getTaskNotes(...args),
    issueTaskNotesOperation: async (...args) =>
      (await getRuntime()).notes.issueTaskNotesOperation(...args),
    updateTaskNotes: async (...args) => (await getRuntime()).notes.updateTaskNotes(...args),
  };
}

/**
 * Shared scoped command manifest for Electron-hosted and standalone hosts.
 * The provider lets a synchronous host assemble transport wiring while one
 * memoized activation promise owns all durable startup and cutover work.
 */
export function createTaskExperienceRemoteCommandRegistrations(
  dependencies: TaskExperienceRemoteRegistrationDependencies,
): RemoteCommandRegistrationTable {
  const registrations = [
    createTaskCatalogRemoteCommandRegistrations(dependencies.catalog),
    createTaskCreationRemoteCommandRegistrations(deferredCreation(dependencies.getRuntime)),
    createTaskNotesRemoteCommandRegistrations(
      deferredNotes(dependencies.getRuntime),
      dependencies.writerEntitlement,
    ),
  ];
  const names = registrations.flatMap((table) => Object.keys(table));
  if (new Set(names).size !== names.length) {
    throw new Error('Task-experience remote command owners overlap');
  }
  return Object.assign({}, ...registrations) as RemoteCommandRegistrationTable;
}
