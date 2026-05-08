import { For, Show, createEffect, createMemo, type JSX } from 'solid-js';

import { getChangedFileDisplayEntries } from '../../lib/changed-file-display';
import {
  getChangedFileStatusCategory,
  type ChangedFileStatusCategory,
} from '../../domain/git-status';
import type { ReviewCommitSummary } from '../../domain/review-commit-history';
import type { ChangedFile } from '../../ipc/types';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import { scrollSelectedRowIntoView } from '../file-list-scroll';

interface ReviewPanelFileListProps {
  commitHistoryError?: string | null;
  emptyMessage: string;
  files: ReadonlyArray<ChangedFile>;
  commits?: ReadonlyArray<ReviewCommitSummary>;
  onSelect: (index: number) => void;
  onSelectCommit?: (hash: string | null) => void;
  selectedCommitHash?: string | null;
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

function isAllFilesCommitSelection(selectedCommitHash: string | null | undefined): boolean {
  return selectedCommitHash === null || selectedCommitHash === undefined;
}

function getCommitButtonBackground(active: boolean): string {
  return active ? `${theme.accent}25` : 'transparent';
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
      <Show when={props.commits && props.commits.length > 0}>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '4px',
            padding: '6px',
            'border-bottom': `1px solid ${theme.border}`,
          }}
        >
          <button
            type="button"
            onClick={() => props.onSelectCommit?.(null)}
            style={{
              background: getCommitButtonBackground(
                isAllFilesCommitSelection(props.selectedCommitHash),
              ),
              border: `1px solid ${theme.border}`,
              'border-radius': '6px',
              color: theme.fg,
              cursor: 'pointer',
              padding: '4px 6px',
              'text-align': 'left',
              ...typography.metaStrong,
            }}
          >
            All files
          </button>
          <For each={props.commits}>
            {(commit) => (
              <button
                type="button"
                onClick={() => props.onSelectCommit?.(commit.hash)}
                title={commit.subject}
                style={{
                  background: getCommitButtonBackground(props.selectedCommitHash === commit.hash),
                  border: `1px solid ${theme.border}`,
                  'border-radius': '6px',
                  color: theme.fgMuted,
                  cursor: 'pointer',
                  padding: '4px 6px',
                  'text-align': 'left',
                  overflow: 'hidden',
                  ...typography.monoMeta,
                }}
              >
                <span style={{ color: theme.fg, 'margin-right': '6px' }}>{commit.shortHash}</span>
                <span
                  style={{
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {commit.subject || '(no subject)'}
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.commitHistoryError}>
        {(commitHistoryError) => (
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: '6px',
              color: theme.error,
              'border-bottom': `1px solid ${theme.border}`,
              ...typography.meta,
            }}
          >
            Commit history unavailable: {commitHistoryError()}
          </div>
        )}
      </Show>
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
