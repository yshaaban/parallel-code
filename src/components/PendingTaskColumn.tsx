import { Show, onMount, type JSX } from 'solid-js';
import {
  dismissPendingTaskCreation,
  retryPendingTaskCreation,
  type PendingTaskCreation,
} from '../app/task-creation-optimism';
import { theme } from '../lib/theme';
import { ProjectRootBadge } from './TaskContextBadges';

interface PendingTaskColumnProps {
  pending: PendingTaskCreation;
}

// Provisional task column shown while the backend createTask round trip is in
// flight. Mirrors the TaskPanel closing-overlay treatment: a calm dim shell
// with one status line, plus error + Retry/Dismiss when creation fails.
export function PendingTaskColumn(props: PendingTaskColumnProps): JSX.Element {
  let columnRef: HTMLDivElement | undefined;

  onMount(() => {
    columnRef?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });

  return (
    <div
      ref={columnRef}
      data-pending-task-id={props.pending.pendingId}
      data-pending-task-state={props.pending.state.kind}
      style={{
        height: '100%',
        padding: 'var(--space-xs) var(--space-2xs) var(--space-sm)',
      }}
    >
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          'align-items': 'center',
          'justify-content': 'center',
          gap: '12px',
          height: '100%',
          background: theme.taskContainerBg,
          'border-radius': '12px',
          border: `1px solid ${theme.border}`,
          color: theme.fg,
          padding: 'var(--space-lg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            'max-width': '280px',
          }}
        >
          <span
            style={{
              'font-size': '13px',
              color: theme.fg,
              'font-weight': '600',
              'min-width': '0',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            {props.pending.name}
          </span>
          <Show when={props.pending.gitIsolation === 'current-branch'}>
            <ProjectRootBadge />
          </Show>
        </div>
        <Show when={props.pending.state.kind === 'creating'}>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'font-size': '13px',
              color: theme.fgMuted,
            }}
          >
            <span class="inline-spinner" aria-hidden="true" />
            {props.pending.taskMode === 'terminal'
              ? 'Creating terminal task...'
              : 'Creating task...'}
          </div>
          <div style={{ 'font-size': '11px', color: theme.fgSubtle }}>
            {props.pending.launchLabel}
          </div>
        </Show>
        <Show when={props.pending.state.kind === 'error' ? props.pending.state : null}>
          {(errorState) => (
            <>
              <div style={{ 'font-size': '13px', color: theme.error, 'font-weight': '600' }}>
                Create failed
              </div>
              <div
                style={{
                  'font-size': '11px',
                  color: theme.fgMuted,
                  'max-width': '260px',
                  'text-align': 'center',
                  'word-break': 'break-word',
                }}
              >
                {errorState().message}
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                <button
                  onClick={() => retryPendingTaskCreation(props.pending.pendingId)}
                  style={{
                    background: theme.bgElevated,
                    border: `1px solid ${theme.border}`,
                    color: theme.fg,
                    padding: '6px 16px',
                    'border-radius': '6px',
                    cursor: 'pointer',
                    'font-size': '12px',
                  }}
                >
                  Retry
                </button>
                <button
                  onClick={() => dismissPendingTaskCreation(props.pending.pendingId)}
                  style={{
                    background: theme.bgElevated,
                    border: `1px solid ${theme.border}`,
                    color: theme.fgMuted,
                    padding: '6px 16px',
                    'border-radius': '6px',
                    cursor: 'pointer',
                    'font-size': '12px',
                  }}
                >
                  Dismiss
                </button>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
