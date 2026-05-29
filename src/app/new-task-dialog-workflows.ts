import { showNotification } from '../store/notification';
import { toggleAddProjectDialog, toggleNewTaskDialog } from '../store/navigation';
import { store } from '../store/state';

export function openNewTaskDialog(): void {
  if (store.projects.length === 0) {
    showNotification('Add a project first');
    toggleAddProjectDialog(true);
    return;
  }

  toggleNewTaskDialog(true);
}
