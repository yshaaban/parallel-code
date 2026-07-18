import { ErrorBoundary, Suspense, type JSX } from 'solid-js';
import { sf } from '../../lib/fontScale';
import { lazyNamed } from '../../lib/lazy-named';
import { theme } from '../../lib/theme';
import type { PanelChild } from '../ResizablePanel';
import { ScalablePanel } from '../ScalablePanel';
import type { TaskCoordinatorSectionProps } from './TaskCoordinatorSection';

const TaskCoordinatorSection = lazyNamed(
  () => import('./TaskCoordinatorSection'),
  'TaskCoordinatorSection',
);

function CoordinatorSectionState(
  props: TaskCoordinatorSectionProps & {
    error?: unknown;
    state: 'error' | 'loading';
  },
): JSX.Element {
  const isError = () => props.state === 'error';
  return (
    <ScalablePanel panelId={`${props.task().id}:coordinator`}>
      <div
        aria-busy={isError() ? undefined : 'true'}
        data-coordinator-section-state={props.state}
        role={isError() ? 'alert' : 'status'}
        title={isError() && props.error !== undefined ? String(props.error) : undefined}
        style={{
          height: '100%',
          display: 'flex',
          'align-items': 'center',
          padding: '6px 8px',
          background: theme.taskPanelBg,
          color: isError() ? theme.error : theme.fgSubtle,
          'font-size': sf(11),
        }}
      >
        {isError() ? 'Coordinator controls unavailable.' : 'Loading coordinator…'}
      </div>
    </ScalablePanel>
  );
}

/**
 * Stable TaskPanel integration boundary for the coordinator feature.
 *
 * The coordinator inspector changes independently and is only rendered for
 * coordinator tasks, so keep its implementation out of the default task-panel
 * startup chunk while preserving the existing PanelChild contract.
 */
export function createTaskCoordinatorSection(props: TaskCoordinatorSectionProps): PanelChild {
  return {
    content: () => (
      <ErrorBoundary
        fallback={(error) => <CoordinatorSectionState {...props} error={error} state="error" />}
      >
        <Suspense fallback={<CoordinatorSectionState {...props} state="loading" />}>
          <TaskCoordinatorSection {...props} />
        </Suspense>
      </ErrorBoundary>
    ),
    fixed: true,
    id: 'coordinator',
    initialSize: 44,
    maxSize: 64,
    minSize: 40,
  };
}
