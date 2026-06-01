import { For, Show, createMemo, type Accessor, type JSX } from 'solid-js';
import { isCoordinatorPendingPromptStatus } from '../../domain/coordinator';
import { getCoordinatorRunForTask } from '../../store/coordinator';
import type { Task } from '../../store/types';
import { sf } from '../../lib/fontScale';
import { theme } from '../../lib/theme';
import type { PanelChild } from '../ResizablePanel';
import { ScalablePanel } from '../ScalablePanel';

interface TaskCoordinatorSectionProps {
  task: Accessor<Task>;
}

function statusColor(status: string): string {
  switch (status) {
    case 'landed':
    case 'completed':
    case 'delivered':
      return theme.success;
    case 'failed':
    case 'landing-failed':
    case 'cleanup-failed':
      return theme.error;
    case 'waiting-for-user':
    case 'waiting-for-command-lease':
    case 'waiting-for-user-idle':
      return theme.warning;
    default:
      return theme.fgSubtle;
  }
}

export function TaskCoordinatorSection(props: TaskCoordinatorSectionProps): JSX.Element {
  const run = createMemo(() => getCoordinatorRunForTask(props.task().id));
  const pendingPrompts = createMemo(
    () =>
      run()?.promptQueue.filter((prompt) => isCoordinatorPendingPromptStatus(prompt.status)) ?? [],
  );

  return (
    <ScalablePanel panelId={`${props.task().id}:coordinator`}>
      <div
        style={{
          height: '100%',
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
          padding: '8px',
          background: theme.taskPanelBg,
          color: theme.fg,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            gap: '8px',
            'font-size': sf(11),
            color: theme.fgMuted,
          }}
        >
          <span>Coordinator</span>
          <Show when={run()}>
            {(snapshot) => (
              <span style={{ color: statusColor(snapshot().status) }}>{snapshot().status}</span>
            )}
          </Show>
        </div>
        <Show when={run()} fallback={<div style={{ color: theme.fgSubtle }}>Starting...</div>}>
          {(snapshot) => (
            <div
              style={{
                display: 'grid',
                'grid-template-columns': '1fr',
                gap: '4px',
                overflow: 'auto',
                'font-size': sf(11),
              }}
            >
              <For each={snapshot().subtasks}>
                {(subtask) => (
                  <div
                    style={{
                      display: 'grid',
                      'grid-template-columns': 'minmax(0, 1fr) auto',
                      gap: '8px',
                      'align-items': 'center',
                      'min-height': '22px',
                    }}
                  >
                    <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                      {subtask.assignment}
                    </span>
                    <span style={{ color: statusColor(subtask.status) }}>{subtask.status}</span>
                  </div>
                )}
              </For>
              <For each={pendingPrompts()}>
                {(prompt) => (
                  <div
                    style={{
                      display: 'grid',
                      'grid-template-columns': 'minmax(0, 1fr) auto',
                      gap: '8px',
                      color: theme.fgSubtle,
                    }}
                  >
                    <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                      Prompt to {prompt.targetTaskId}
                    </span>
                    <span style={{ color: statusColor(prompt.status) }}>{prompt.status}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>
    </ScalablePanel>
  );
}

export function createTaskCoordinatorSection(props: TaskCoordinatorSectionProps): PanelChild {
  return {
    id: 'coordinator',
    minSize: 72,
    initialSize: 120,
    content: () => <TaskCoordinatorSection {...props} />,
  };
}
