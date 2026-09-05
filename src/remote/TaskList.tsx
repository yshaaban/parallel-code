import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';

import type {
  RemoteProjectSummary,
  RemoteTaskSessionRef,
  RemoteTaskSummary,
} from '../domain/task-catalog';
import type { ConnectionStatus } from './ws';
import type { TaskCatalogStoreSnapshot } from './task-catalog-store';
import { TaskLocationChip } from './TaskLocationChip';
import './task-experience.css';

interface TaskListProps {
  canCreate: boolean;
  catalog: TaskCatalogStoreSnapshot;
  connectionStatus: ConnectionStatus;
  onCreate: () => void;
  onEditSessionName: () => void;
  onSelectTask: (taskId: string) => void;
  sessionName: string;
}

interface ProjectTaskGroup {
  project: RemoteProjectSummary;
  tasks: RemoteTaskSummary[];
}

interface TaskStatePresentation {
  label: string;
  tone: 'danger' | 'neutral' | 'running' | 'warning';
}

function compareLabels(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function getTaskState(
  task: RemoteTaskSummary,
  sessions: readonly RemoteTaskSessionRef[],
): TaskStatePresentation {
  if (task.lifecycle === 'closing') return { label: 'Closing', tone: 'warning' };
  if (task.creationStatus === 'failed') return { label: 'Creation failed', tone: 'danger' };
  if (task.creationStatus === 'needs-attention') {
    return { label: 'Needs attention', tone: 'warning' };
  }
  if (
    task.creationStatus === 'starting' ||
    sessions.some((session) => session.state === 'not-started')
  ) {
    return { label: 'Starting', tone: 'warning' };
  }
  if (sessions.some((session) => session.state === 'running')) {
    return { label: 'Running', tone: 'running' };
  }
  if (sessions.some((session) => session.state === 'failed')) {
    return { label: 'Failed', tone: 'danger' };
  }
  if (sessions.some((session) => session.state === 'stopped')) {
    return { label: 'Stopped', tone: 'neutral' };
  }
  return { label: 'No session', tone: 'neutral' };
}

function getCatalogBanner(
  catalog: TaskCatalogStoreSnapshot,
  connectionStatus: ConnectionStatus,
): { label: string; tone: 'danger' | 'neutral' | 'warning' } | null {
  if (catalog.status === 'capacity-exceeded') {
    return {
      label:
        'The task catalog is larger than the safe remote limit. Creation and navigation are unavailable.',
      tone: 'danger',
    };
  }
  if (catalog.status === 'unavailable') {
    return {
      label: 'The latest task catalog is unavailable. Previously loaded tasks remain visible.',
      tone: 'warning',
    };
  }
  if (catalog.status === 'stale') {
    return {
      label:
        'Task updates fell out of sync. Refreshing while the last complete list stays visible.',
      tone: 'warning',
    };
  }
  if (catalog.status === 'reconnecting' || connectionStatus !== 'connected') {
    return {
      label: 'Reconnecting. The last complete task list may be out of date.',
      tone: 'warning',
    };
  }
  if (catalog.status === 'loading' || catalog.status === 'refreshing') {
    return {
      label:
        catalog.status === 'loading'
          ? 'Loading the task catalog…'
          : 'Refreshing tasks. The current list remains available.',
      tone: 'neutral',
    };
  }
  return null;
}

function TaskCard(props: {
  onSelect: (taskId: string) => void;
  sessions: readonly RemoteTaskSessionRef[];
  task: RemoteTaskSummary;
}): JSX.Element {
  const state = createMemo(() => getTaskState(props.task, props.sessions));
  const stateClass = createMemo(() => {
    if (state().tone === 'running') return 'task-status-dot task-status-dot--running';
    if (state().tone === 'danger') return 'task-status-dot task-status-dot--failed';
    return 'task-status-dot';
  });

  return (
    <button
      aria-label={`Open ${props.task.name}. ${state().label}. ${props.task.taskMode === 'terminal' ? 'Terminal-only task' : 'Agent task'}.`}
      class="task-card"
      type="button"
      onClick={() => props.onSelect(props.task.taskId)}
    >
      <span class="task-card__top">
        <span class="task-card__name">{props.task.name}</span>
        <span aria-hidden="true" class={stateClass()} />
      </span>
      <span class="task-card__meta">
        <span class={state().tone === 'danger' ? 'task-chip task-chip--danger' : 'task-chip'}>
          {state().label}
        </span>
        <Show when={props.task.taskMode === 'terminal'}>
          <span class="task-chip task-chip--accent">Terminal only</span>
        </Show>
        <TaskLocationChip task={props.task} />
        <Show when={props.task.branchLabel}>
          {(label) => (
            <span class="task-chip" title={label()}>
              {label()}
            </span>
          )}
        </Show>
      </span>
    </button>
  );
}

export function TaskList(props: TaskListProps): JSX.Element {
  const [query, setQuery] = createSignal('');
  const projection = createMemo(() => props.catalog.projection);
  const banner = createMemo(() => getCatalogBanner(props.catalog, props.connectionStatus));
  const groups = createMemo<ProjectTaskGroup[]>(() => {
    const current = projection();
    if (!current) return [];
    const normalizedQuery = query().trim().toLocaleLowerCase();
    const tasksByProject = new Map<string, RemoteTaskSummary[]>();
    for (const task of current.tasks.values()) {
      const project = current.projects.get(task.projectId);
      const searchable =
        `${task.name} ${task.branchLabel ?? ''} ${project?.label ?? ''}`.toLocaleLowerCase();
      if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
      const tasks = tasksByProject.get(task.projectId) ?? [];
      tasks.push(task);
      tasksByProject.set(task.projectId, tasks);
    }

    const result: ProjectTaskGroup[] = [];
    for (const [projectId, tasks] of tasksByProject) {
      const project = current.projects.get(projectId);
      if (!project) continue;
      tasks.sort((left, right) => compareLabels(left.name, right.name));
      result.push({ project, tasks });
    }
    result.sort((left, right) => compareLabels(left.project.label, right.project.label));
    return result;
  });
  const taskCount = createMemo(() =>
    groups().reduce((total, group) => total + group.tasks.length, 0),
  );

  return (
    <main class="task-experience" aria-label="Remote tasks">
      <header class="task-experience__header">
        <div class="task-experience__title-group">
          <h1 class="task-experience__title">Tasks</h1>
          <button
            class="task-experience__session-button"
            type="button"
            onClick={() => props.onEditSessionName()}
          >
            {props.sessionName}
          </button>
        </div>
        <span
          aria-label={`${taskCount()} ${taskCount() === 1 ? 'task' : 'tasks'} visible`}
          aria-live="polite"
          class="task-chip"
        >
          {taskCount()} visible
        </span>
      </header>
      <div class="task-experience__body">
        <div class="task-experience__toolbar">
          <label>
            <span class="sr-only">Search tasks</span>
            <input
              class="task-experience__search"
              placeholder="Search tasks"
              type="search"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button
            class="task-experience__button task-experience__button--primary"
            disabled={!props.canCreate}
            title={props.canCreate ? 'Create a task' : 'Remote task creation is unavailable'}
            type="button"
            onClick={() => props.onCreate()}
          >
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" />
            </svg>
            New task
          </button>
        </div>

        <Show when={banner()}>
          {(currentBanner) => (
            <div
              aria-live="polite"
              aria-atomic="true"
              class={`task-experience__banner${currentBanner().tone === 'neutral' ? '' : ` task-experience__banner--${currentBanner().tone}`}`}
              role="status"
            >
              {currentBanner().label}
            </div>
          )}
        </Show>

        <Show
          when={groups().length > 0}
          fallback={
            <div aria-live="polite" class="task-experience__empty" role="status">
              {projection()
                ? query().trim()
                  ? 'No tasks match this search.'
                  : 'No tasks yet. Create an agent or terminal-only task when creation is available.'
                : 'Waiting for a complete task catalog.'}
            </div>
          }
        >
          <For each={groups()}>
            {(group) => (
              <section class="task-project" aria-labelledby={`project-${group.project.id}`}>
                <h2 class="task-project__heading" id={`project-${group.project.id}`}>
                  <span>{group.project.label}</span>
                  <span class="task-project__count">{group.tasks.length}</span>
                </h2>
                <ul class="task-project__list">
                  <For each={group.tasks}>
                    {(currentTask) => (
                      <li>
                        <TaskCard
                          onSelect={props.onSelectTask}
                          sessions={projection()?.sessionsByTask.get(currentTask.taskId) ?? []}
                          task={currentTask}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </Show>
      </div>
    </main>
  );
}
