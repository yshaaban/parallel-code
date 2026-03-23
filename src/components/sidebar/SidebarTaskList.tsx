import { For, Show, type Accessor } from 'solid-js';

import { SectionLabel } from '../SectionLabel';
import {
  SIDEBAR_ORPHANED_ACTIVE_GROUP_ID,
  type GroupedSidebarTasks,
} from '../../store/sidebar-order';
import {
  getTaskFocusedPanel,
  setActiveTask,
  setTaskFocusedPanel,
  store,
  unfocusSidebar,
} from '../../store/store';
import { uncollapseTask } from '../../app/task-workflows';
import { CollapsedSidebarTaskRow, SidebarTaskRow } from '../SidebarTaskRow';
import type { Project } from '../../store/types';

interface SidebarTaskListProps {
  dragState: Accessor<{ groupId: string; taskId: string } | null>;
  dropTarget: Accessor<{ groupId: string; index: number } | null>;
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
        gap: 'var(--space-xs)',
        flex: '1',
        overflow: 'auto',
        outline: 'none',
        padding: '0 0 var(--space-2xs)',
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
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--space-3xs)' }}>
                <SectionLabel
                  as="span"
                  style={{
                    padding: `0 var(--space-3xs)`,
                    display: 'flex',
                    'align-items': 'center',
                    gap: 'var(--space-2xs)',
                  }}
                  tone="subtle"
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
                </SectionLabel>
                <For each={activeTasks()}>
                  {(taskId, taskIndex) => (
                    <SidebarTaskRow
                      dragState={props.dragState}
                      dropTarget={props.dropTarget}
                      groupId={project.id}
                      groupIndex={taskIndex()}
                      taskId={taskId}
                    />
                  )}
                </For>
                <Show
                  when={
                    props.dropTarget()?.groupId === project.id &&
                    props.dropTarget()?.index === activeTasks().length
                  }
                >
                  <div class="drop-indicator" />
                </Show>
                <For each={collapsedTasks()}>
                  {(taskId) => <CollapsedSidebarTaskRow taskId={taskId} />}
                </For>
              </div>
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
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--space-3xs)' }}>
          <SectionLabel
            as="span"
            style={{
              padding: `0 var(--space-3xs)`,
            }}
            tone="subtle"
          >
            Other (
            {props.groupedTasks().orphanedActive.length +
              props.groupedTasks().orphanedCollapsed.length}
            )
          </SectionLabel>
          <For each={props.groupedTasks().orphanedActive}>
            {(taskId, taskIndex) => (
              <SidebarTaskRow
                dragState={props.dragState}
                dropTarget={props.dropTarget}
                groupId={SIDEBAR_ORPHANED_ACTIVE_GROUP_ID}
                groupIndex={taskIndex()}
                taskId={taskId}
              />
            )}
          </For>
          <Show
            when={
              props.dropTarget()?.groupId === SIDEBAR_ORPHANED_ACTIVE_GROUP_ID &&
              props.dropTarget()?.index === props.groupedTasks().orphanedActive.length
            }
          >
            <div class="drop-indicator" />
          </Show>
          <For each={props.groupedTasks().orphanedCollapsed}>
            {(taskId) => <CollapsedSidebarTaskRow taskId={taskId} />}
          </For>
        </div>
      </Show>
    </div>
  );
}
