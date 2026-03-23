import { For, Show, createEffect, createMemo, type JSX } from 'solid-js';

import { getChangedFileDisplayEntries } from '../../lib/changed-file-display';
import {
  getChangedFileStatusCategory,
  type ChangedFileStatusCategory,
} from '../../domain/git-status';
import type { ChangedFile } from '../../ipc/types';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import { scrollSelectedRowIntoView } from '../file-list-scroll';

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
  const fileDisplays = createMemo(() => getChangedFileDisplayEntries(props.files));
  const rowRefs: Array<HTMLDivElement | undefined> = [];

  createEffect(() => {
    scrollSelectedRowIntoView(rowRefs, props.selectedIndex);
  });

  return (
    <div
      style={{
        width: '188px',
        'min-width': '132px',
        'border-right': `1px solid ${theme.border}`,
        overflow: 'auto',
        'flex-shrink': '0',
      }}
    >
      <For each={props.files}>
        {(file, index) => {
          const display = () => fileDisplays()[index()];

          return (
            <div
              ref={(el) => {
                rowRefs[index()] = el;
              }}
              onClick={() => props.onSelect(index())}
              style={{
                padding: '2px 6px',
                cursor: 'pointer',
                background: index() === props.selectedIndex ? theme.accent + '30' : 'transparent',
                'border-left':
                  index() === props.selectedIndex
                    ? `2px solid ${theme.accent}`
                    : '2px solid transparent',
                ...typography.monoMeta,
                display: 'flex',
                'align-items': 'center',
                gap: '4px',
                'white-space': 'nowrap',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  color: getStatusColor(file),
                  ...typography.metaStrong,
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
                {display()?.name ?? file.path}
              </span>
              <Show when={display()?.disambig}>
                {(currentDisambig) => (
                  <span
                    style={{
                      color: theme.fgMuted,
                      ...typography.meta,
                      'flex-shrink': '0',
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                    }}
                  >
                    {currentDisambig()}
                  </span>
                )}
              </Show>
              <span
                style={{
                  'margin-left': 'auto',
                  color: theme.fgMuted,
                  ...typography.meta,
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
          );
        }}
      </For>
      <Show when={props.files.length === 0}>
        <div
          style={{
            padding: '10px 8px',
            color: theme.fgMuted,
            ...typography.monoMeta,
            'text-align': 'center',
          }}
        >
          {props.emptyMessage}
        </div>
      </Show>
    </div>
  );
}
