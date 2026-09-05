import { Show, type JSX } from 'solid-js';

import type { RemoteTaskSummary } from '../domain/task-catalog';

export function TaskLocationChip(props: { task: RemoteTaskSummary }): JSX.Element {
  return (
    <Show
      when={props.task.location === 'project-root'}
      fallback={
        <Show when={props.task.location === 'existing-worktree'}>
          <span class="task-chip task-chip--warning" title="Imported worktree — externally owned">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 5.5h10v7H3zM5 3h6v2.5H5z" stroke="currentColor" stroke-width="1.3" />
            </svg>
            Imported
            <span class="sr-only"> worktree — externally owned</span>
          </span>
        </Show>
      }
    >
      <span class="task-chip task-chip--warning" title="Project root — shared working directory">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M2.5 6.5h11v6h-11zM4 4h3l1.2 2.5" stroke="currentColor" stroke-width="1.3" />
        </svg>
        Project root
        <span class="sr-only"> — shared working directory</span>
      </span>
    </Show>
  );
}
