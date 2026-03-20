import { showNotification } from '../store/notification';
import { toggleNewTaskDialog } from '../store/navigation';
import { store } from '../store/state';
import { pickAndAddProject } from './project-workflows';

export function openNewTaskDialog(): void {
  if (store.projects.length === 0) {
    showNotification('Add a project first');
    void pickAndAddProject();
    return;
  }

  toggleNewTaskDialog(true);
}
