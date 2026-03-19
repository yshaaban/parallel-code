import { For, Show, type JSX } from 'solid-js';

import {
  getChangedFileStatusCategory,
  type ChangedFileStatusCategory,
} from '../../domain/git-status';
import type { ChangedFile } from '../../ipc/types';
import { theme } from '../../lib/theme';

interface ReviewPanelFileListProps {
  emptyMessage: string;
  files: ReadonlyArray<ChangedFile>;
  onSelect: (index: number) => void;
  selectedIndex: number;
}

const REVIEW_FILE_STATUS_COLORS: Record<ChangedFileStatusCategory, string> = {
  added: '#4ec94e',
  deleted: '#e55',
  modified: '#e8a838',
};

const REVIEW_FILE_STATUS_ICONS: Record<ChangedFileStatusCategory, string> = {
  added: '+',
  deleted: '-',
  modified: 'M',
};

function getFileStatusCategory(file: ChangedFile): ChangedFileStatusCategory {
  return getChangedFileStatusCategory(file.status);
}

function getStatusColor(file: ChangedFile): string {
  return REVIEW_FILE_STATUS_COLORS[getFileStatusCategory(file)];
}

function getStatusIcon(file: ChangedFile): string {
  return REVIEW_FILE_STATUS_ICONS[getFileStatusCategory(file)];
}

export function ReviewPanelFileList(props: ReviewPanelFileListProps): JSX.Element {
  return (
    <div
      style={{
        width: '200px',
        'min-width': '140px',
        'border-right': `1px solid ${theme.border}`,
        overflow: 'auto',
        'flex-shrink': '0',
      }}
    >
      <For each={props.files}>
        {(file, index) => (
          <div
            onClick={() => props.onSelect(index())}
            style={{
              padding: '3px 8px',
              cursor: 'pointer',
              background: index() === props.selectedIndex ? theme.accent + '30' : 'transparent',
              'border-left':
                index() === props.selectedIndex
                  ? `2px solid ${theme.accent}`
                  : '2px solid transparent',
              'font-size': '11px',
              'font-family': "'JetBrains Mono', monospace",
              display: 'flex',
              'align-items': 'center',
              gap: '6px',
              'white-space': 'nowrap',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                color: getStatusColor(file),
                'font-weight': 'bold',
                'flex-shrink': '0',
                width: '12px',
                'text-align': 'center',
              }}
            >
              {getStatusIcon(file)}
            </span>
            <span
              style={{
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
              }}
              title={file.path}
            >
              {file.path.split('/').pop()}
            </span>
            <span
              style={{
                'margin-left': 'auto',
                color: theme.fgMuted,
                'font-size': '9px',
                'flex-shrink': '0',
              }}
            >
              <Show when={file.lines_added > 0}>
                <span style={{ color: '#4ec94e' }}>+{file.lines_added}</span>
              </Show>
              <Show when={file.lines_removed > 0}>
                <span style={{ color: '#e55', 'margin-left': '2px' }}>-{file.lines_removed}</span>
              </Show>
            </span>
          </div>
        )}
      </For>
      <Show when={props.files.length === 0}>
        <div
          style={{
            padding: '12px',
            color: theme.fgMuted,
            'font-size': '11px',
            'text-align': 'center',
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          {props.emptyMessage}
        </div>
      </Show>
    </div>
  );
}
