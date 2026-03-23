import { Show, type JSX } from 'solid-js';

import { ReviewCommentsToggle } from '../ReviewSidebar';
import { IconButton } from '../IconButton';
import { isReviewDiffMode, type ReviewDiffMode } from '../../store/types';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';

interface ReviewPanelToolbarProps {
  canSelectNextFile: boolean;
  canSelectPreviousFile: boolean;
  commentCount: number;
  fileCount: number;
  mode: ReviewDiffMode;
  onNext: () => void;
  onOpenFullscreen?: () => void;
  onPrevious: () => void;
  onSetMode: (mode: ReviewDiffMode) => void;
  onToggleComments: () => void;
  onToggleSideBySide: () => void;
  sideBySide: boolean;
  sidebarOpen: boolean;
  showOpenFullscreen: boolean;
  totalAdded: number;
  totalRemoved: number;
}

function createHeaderButtonStyle(active = false): Record<string, string> {
  return {
    background: active ? `color-mix(in srgb, ${theme.accent} 14%, transparent)` : 'transparent',
    border: `1px solid ${theme.border}`,
    color: active ? theme.accent : theme.fg,
    padding: '2px',
    cursor: 'pointer',
    'border-radius': '4px',
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    opacity: active ? '1' : '0.92',
  };
}

export function ReviewPanelToolbar(props: ReviewPanelToolbarProps): JSX.Element {
  function handleModeChange(value: string): void {
    if (!isReviewDiffMode(value)) {
      return;
    }

    props.onSetMode(value);
  }

  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '6px',
        padding: '3px 6px',
        'border-bottom': `1px solid ${theme.border}`,
        'flex-shrink': '0',
        ...typography.monoMeta,
      }}
    >
      <select
        value={props.mode}
        onChange={(event) => handleModeChange(event.currentTarget.value)}
        style={{
          background: theme.bg,
          color: theme.fg,
          border: `1px solid ${theme.border}`,
          'border-radius': '3px',
          padding: '1px 4px',
          ...typography.monoMeta,
        }}
      >
        <option value="all">All changes</option>
        <option value="staged">Staged</option>
        <option value="unstaged">Unstaged</option>
        <option value="branch">Branch</option>
      </select>

      <span style={{ color: theme.fgMuted }}>
        {props.fileCount} file{props.fileCount !== 1 ? 's' : ''}
      </span>
      <span style={{ color: '#4ec94e' }}>+{props.totalAdded}</span>
      <span style={{ color: '#e55' }}>-{props.totalRemoved}</span>

      <ReviewCommentsToggle
        count={props.commentCount}
        onToggle={props.onToggleComments}
        open={props.sidebarOpen}
      />

      <div style={{ 'margin-left': 'auto', display: 'flex', gap: '3px' }}>
        <button
          onClick={() => props.onPrevious()}
          disabled={!props.canSelectPreviousFile}
          title="Previous file"
          style={{
            ...createHeaderButtonStyle(),
            cursor: props.canSelectPreviousFile ? 'pointer' : 'default',
            opacity: props.canSelectPreviousFile ? '0.92' : '0.4',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
          </svg>
        </button>
        <button
          onClick={() => props.onNext()}
          disabled={!props.canSelectNextFile}
          title="Next file"
          style={{
            ...createHeaderButtonStyle(),
            cursor: props.canSelectNextFile ? 'pointer' : 'default',
            opacity: props.canSelectNextFile ? '0.92' : '0.4',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
        <button
          onClick={() => props.onToggleSideBySide()}
          title={props.sideBySide ? 'Show unified diff' : 'Show split diff'}
          style={createHeaderButtonStyle(props.sideBySide)}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="2.25"
              y="2.25"
              width="4.5"
              height="11.5"
              rx="0.75"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <rect
              x="9.25"
              y="2.25"
              width="4.5"
              height="11.5"
              rx="0.75"
              stroke="currentColor"
              stroke-width="1.5"
            />
          </svg>
        </button>
        <Show when={props.showOpenFullscreen && props.onOpenFullscreen}>
          <IconButton
            size="sm"
            title="Open review fullscreen"
            onClick={() => props.onOpenFullscreen?.()}
            icon={
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M2.75 2h3.5a.75.75 0 0 1 0 1.5H4.56l2.97 2.97a.75.75 0 1 1-1.06 1.06L3.5 4.56v1.69a.75.75 0 0 1-1.5 0V2.75A.75.75 0 0 1 2.75 2Zm7 0h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V4.56l-2.97 2.97a.75.75 0 0 1-1.06-1.06l2.97-2.97H9.75a.75.75 0 0 1 0-1.5ZM6.47 8.47a.75.75 0 0 1 1.06 1.06L4.56 12.5h1.69a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75v-3.5a.75.75 0 0 1 1.5 0v1.69l2.97-2.97Zm3.06 0 2.97 2.97V9.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.69L8.47 9.53a.75.75 0 1 1 1.06-1.06Z" />
              </svg>
            }
          />
        </Show>
      </div>
    </div>
  );
}
