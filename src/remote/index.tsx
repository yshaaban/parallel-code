import '@xterm/xterm/css/xterm.css';
import { render } from 'solid-js/web';
import { createTaskNotesCapability } from '../app/task-notes-capability';
import { App } from './App';
import { getRemoteSessionCapabilities, initializeRemoteAuthSession } from './auth';
import { remoteTaskCatalogFacade, remoteTaskCreationCapabilitiesFacade } from './remote-ipc';
import { TaskCatalogRuntime } from './task-catalog-store';
import { remoteTaskCatalogLiveEvents } from './ws';

async function renderRemoteApp(): Promise<void> {
  const authMode = await initializeRemoteAuthSession();
  const sessionCapabilities = getRemoteSessionCapabilities();
  const taskNotesCapability = createTaskNotesCapability(
    sessionCapabilities?.commands.includes('task-notes.get') === true,
    sessionCapabilities?.mutationAdmission === 'open' &&
      sessionCapabilities.commands.includes('task-notes.issue') &&
      sessionCapabilities.commands.includes('task-notes.update'),
  );
  const taskExperience =
    authMode === 'scoped'
      ? {
          catalogRuntime: new TaskCatalogRuntime({
            liveEvents: remoteTaskCatalogLiveEvents,
            transport: remoteTaskCatalogFacade,
          }),
          creationCapabilities: remoteTaskCreationCapabilitiesFacade,
          taskNotesCapability,
        }
      : undefined;

  render(
    () => <App {...(taskExperience ? { taskExperience } : {})} />,
    document.getElementById('root') as HTMLElement,
  );
}

void renderRemoteApp();
