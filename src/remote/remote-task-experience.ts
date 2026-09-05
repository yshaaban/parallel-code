import type { TaskCreationClientFacade } from '../domain/task-creation';
import type { TaskNotesCapability } from '../app/task-notes-capability';
import type { TaskCatalogRuntime } from './task-catalog-store';

/**
 * Explicit composition boundary for the task-first remote shell. Production
 * stays on the established agent view until a host supplies both guarded
 * facades; importing frontend components cannot activate a backend command.
 */
export interface RemoteTaskExperience {
  readonly catalogRuntime: TaskCatalogRuntime;
  readonly creationCapabilities: Pick<TaskCreationClientFacade, 'getCapabilities'>;
  readonly taskNotesCapability: Readonly<TaskNotesCapability>;
}
