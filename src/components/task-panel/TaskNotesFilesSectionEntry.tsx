import { ErrorBoundary, Suspense, type JSX } from 'solid-js';

import { lazyNamed } from '../../lib/lazy-named';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import type { PanelChild } from '../ResizablePanel';
import type { TaskNotesFilesSectionProps } from './TaskNotesFilesSection';

const TaskNotesFilesSection = lazyNamed(
  () => import('./TaskNotesFilesSection'),
  'TaskNotesFilesSection',
);

function TaskNotesFilesSectionState(props: {
  error?: unknown;
  reset?: () => void;
  state: 'error' | 'loading';
}): JSX.Element {
  const failed = () => props.state === 'error';
  return (
    <div
      aria-busy={failed() ? undefined : 'true'}
      role={failed() ? 'alert' : 'status'}
      title={failed() && props.error !== undefined ? String(props.error) : undefined}
      style={{
        height: '100%',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        gap: '8px',
        background: theme.taskPanelBg,
        color: failed() ? theme.error : theme.fgSubtle,
        ...typography.meta,
      }}
    >
      <span>{failed() ? 'Notes and files are temporarily unavailable.' : 'Loading notes…'}</span>
      {failed() && props.reset ? (
        <button type="button" onClick={props.reset}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Keeps secondary task content out of the renderer's first-parse path. */
export function createTaskNotesFilesSection(props: TaskNotesFilesSectionProps): PanelChild {
  return {
    id: 'notes-files',
    initialSize: 150,
    minSize: 60,
    content: () => (
      <ErrorBoundary
        fallback={(error, reset) => (
          <TaskNotesFilesSectionState error={error} reset={reset} state="error" />
        )}
      >
        <Suspense fallback={<TaskNotesFilesSectionState state="loading" />}>
          <TaskNotesFilesSection {...props} />
        </Suspense>
      </ErrorBoundary>
    ),
  };
}
