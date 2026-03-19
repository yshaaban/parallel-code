import { For, Show, type Accessor } from 'solid-js';

import { theme } from '../../lib/theme';
import { sf } from '../../lib/fontScale';
import {
  getTaskFocusedPanel,
  setActiveTask,
  setTaskFocusedPanel,
  store,
  uncollapseTask,
  unfocusSidebar,
} from '../../store/store';
import type { GroupedSidebarTasks } from '../../store/sidebar-order';
import { CollapsedSidebarTaskRow, SidebarTaskRow } from '../SidebarTaskRow';
import type { Project } from '../../store/types';

interface SidebarTaskListProps {
  dragFromIndex: Accessor<number | null>;
  dropTargetIndex: Accessor<number | null>;
  globalIndex: (taskId: string) => number;
  groupedTasks: Accessor<GroupedSidebarTasks>;
  onEditProject: (project: Project) => void;
  setTaskListRef: (element: HTMLDivElement | undefined) => void;
}

export function SidebarTaskList(props: SidebarTaskListProps) {
  return (
    <div
      ref={(element) => props.setTaskListRef(element)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (!store.sidebarFocused) return;
        if (event.key !== 'Enter') return;

        event.preventDefault();
        const focusedProjectId = store.sidebarFocusedProjectId;
        if (focusedProjectId) {
          const project = store.projects.find((entry) => entry.id === focusedProjectId);
          if (project) {
            props.onEditProject(project);
          }
          return;
        }

        const taskId = store.sidebarFocusedTaskId;
        if (!taskId) {
          return;
        }

        if (store.tasks[taskId]?.collapsed) {
          uncollapseTask(taskId);
          return;
        }

        setActiveTask(taskId);
        unfocusSidebar();
        setTaskFocusedPanel(taskId, getTaskFocusedPanel(taskId));
      }}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '1px',
        flex: '1',
        overflow: 'auto',
        outline: 'none',
      }}
    >
      <For each={store.projects}>
        {(project: Project) => {
          const projectTasks = () => props.groupedTasks().grouped[project.id];
          const activeTasks = () => projectTasks()?.active ?? [];
          const collapsedTasks = () => projectTasks()?.collapsed ?? [];
          const totalCount = () => activeTasks().length + collapsedTasks().length;
          return (
            <Show when={totalCount() > 0}>
              <span
                style={{
                  'font-size': sf(10),
                  color: theme.fgSubtle,
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                  'margin-top': '8px',
                  'margin-bottom': '4px',
                  padding: '0 2px',
                  display: 'flex',
                  'align-items': 'center',
                  gap: '5px',
                }}
              >
                <div
                  style={{
                    width: '6px',
                    height: '6px',
                    'border-radius': '50%',
                    background: project.color,
                    'flex-shrink': '0',
                  }}
                />
                {project.name} ({totalCount()})
              </span>
              <For each={activeTasks()}>
                {(taskId) => (
                  <SidebarTaskRow
                    taskId={taskId}
                    globalIndex={props.globalIndex}
                    dragFromIndex={props.dragFromIndex}
                    dropTargetIndex={props.dropTargetIndex}
                  />
                )}
              </For>
              <For each={collapsedTasks()}>
                {(taskId) => <CollapsedSidebarTaskRow taskId={taskId} />}
              </For>
            </Show>
          );
        }}
      </For>

      <Show
        when={
          props.groupedTasks().orphanedActive.length +
            props.groupedTasks().orphanedCollapsed.length >
          0
        }
      >
        <span
          style={{
            'font-size': sf(10),
            color: theme.fgSubtle,
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
            'margin-top': '8px',
            'margin-bottom': '4px',
            padding: '0 2px',
          }}
        >
          Other (
          {props.groupedTasks().orphanedActive.length +
            props.groupedTasks().orphanedCollapsed.length}
          )
        </span>
        <For each={props.groupedTasks().orphanedActive}>
          {(taskId) => (
            <SidebarTaskRow
              taskId={taskId}
              globalIndex={props.globalIndex}
              dragFromIndex={props.dragFromIndex}
              dropTargetIndex={props.dropTargetIndex}
            />
          )}
        </For>
        <For each={props.groupedTasks().orphanedCollapsed}>
          {(taskId) => <CollapsedSidebarTaskRow taskId={taskId} />}
        </For>
      </Show>

      <Show when={props.dropTargetIndex() === store.taskOrder.length}>
        <div class="drop-indicator" />
      </Show>
    </div>
  );
}
