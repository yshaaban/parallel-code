import { For, Show } from 'solid-js';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import type { TaskIgnoredDirsStatus } from './new-task-dialog/task-git-options-controller';

interface SymlinkDirPickerProps {
  dirs: string[];
  error: string | null;
  onRetry: () => void;
  selectedDirs: Set<string>;
  status: TaskIgnoredDirsStatus;
  truncated: boolean;
  onToggle: (dir: string) => void;
}

export function SymlinkDirPicker(props: SymlinkDirPickerProps) {
  const statusMessage = () => {
    switch (props.status) {
      case 'idle':
        return '';
      case 'loading':
        return 'Checking ignored files…';
      case 'unavailable':
        return `Ignored file suggestions unavailable: ${props.error ?? 'Unknown backend error'}`;
      case 'ready':
        if (props.truncated) {
          return 'Showing 128 eligible entries; additional entries were not loaded.';
        }
        if (props.dirs.length === 0) {
          return 'No eligible ignored files found.';
        }
        return props.dirs.length === 1
          ? '1 eligible entry found.'
          : `${props.dirs.length} eligible entries found.`;
    }
  };

  return (
    <fieldset
      data-nav-field="symlink-dirs"
      style={{ border: '0', margin: '0', padding: '0', 'min-width': '0' }}
    >
      <legend
        style={{
          padding: '0',
          'font-size': '11px',
          color: theme.fgMuted,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
        }}
      >
        Share ignored files with this worktree
      </legend>
      <p
        style={{
          color: theme.fgSubtle,
          margin: '6px 0 8px',
          ...typography.meta,
        }}
      >
        Selected entries are linked from the project root. Their names are added to the repo's
        shared <code>.git/info/exclude</code> and remain ignored for all worktrees.
      </p>
      <Show when={props.status === 'ready' && props.dirs.length > 0}>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '4px',
            padding: '8px 10px',
            background: theme.bgElevated,
            'border-radius': '6px',
            border: `1px solid ${theme.border}`,
            'box-sizing': 'border-box',
            'max-height': '160px',
            'overflow-y': 'auto',
          }}
        >
          <For each={props.dirs}>
            {(dir) => {
              const checked = () => props.selectedDirs.has(dir);
              return (
                <label
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                    'font-size': '12px',
                    'font-family': "'JetBrains Mono', monospace",
                    color: theme.fg,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    aria-label={dir}
                    type="checkbox"
                    checked={checked()}
                    onChange={() => props.onToggle(dir)}
                    style={{ 'accent-color': theme.accent }}
                  />
                  {dir}
                </label>
              );
            }}
          </For>
        </div>
      </Show>
      <div
        role="status"
        aria-live="polite"
        style={{
          color: props.status === 'unavailable' ? theme.warning : theme.fgSubtle,
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          'margin-top': '6px',
          ...typography.meta,
        }}
      >
        <span>{statusMessage()}</span>
        <Show when={props.status === 'unavailable'}>
          <button
            type="button"
            class="btn-secondary"
            onClick={() => props.onRetry()}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              color: theme.fg,
              cursor: 'pointer',
              padding: '4px 8px',
              ...typography.metaStrong,
            }}
          >
            Retry
          </button>
        </Show>
      </div>
    </fieldset>
  );
}
