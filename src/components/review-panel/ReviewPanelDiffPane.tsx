import { Show, type JSX } from 'solid-js';

import type { ReviewSession } from '../../app/review-session';
import type { TaskReviewDiffRequest } from '../../app/review-diffs';
import type { AskAboutCodeMessage } from '../../domain/ask-about-code';
import type { ParsedFileDiff } from '../../lib/unified-diff-parser';
import { theme } from '../../lib/theme';
import type { ChangedFile, FileDiffResult } from '../../ipc/types';
import { MonacoDiffEditor } from '../MonacoDiffEditor';
import { ReviewSidebar, type ReviewSidebarProps } from '../ReviewSidebar';
import { ScrollingDiffView } from '../ScrollingDiffView';

interface ReviewPanelDiffPaneProps {
  diff: FileDiffResult | null;
  emptyMessage: string;
  loading: boolean;
  monacoRevealLine: number | null;
  parsedDiffFiles: ParsedFileDiff[];
  reviewDiffRequest: TaskReviewDiffRequest;
  reviewSession: ReviewSession;
  reviewSidebarProps: ReviewSidebarProps;
  selectedFile: ChangedFile | undefined;
  showSidebar: boolean;
  sideBySide: boolean;
  startAskSession: (
    requestId: string,
    prompt: string,
    cwd: string,
    onMessage: (message: AskAboutCodeMessage) => void,
  ) => Promise<{
    cancel: () => Promise<void>;
    cleanup: () => void;
  }>;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  css: 'css',
  go: 'go',
  html: 'html',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  sh: 'shell',
  ts: 'typescript',
  tsx: 'typescript',
  yaml: 'yaml',
  yml: 'yaml',
};

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext';
}

export function ReviewPanelDiffPane(props: ReviewPanelDiffPaneProps): JSX.Element {
  return (
    <div style={{ flex: '1', overflow: 'hidden', display: 'flex' }}>
      <Show
        when={!props.loading && props.diff && props.selectedFile}
        fallback={
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              height: '100%',
              color: theme.fgMuted,
              'font-size': '12px',
              'font-family': "'JetBrains Mono', monospace",
            }}
          >
            {props.emptyMessage}
          </div>
        }
      >
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            flex: '1',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '4px 8px',
              'font-size': '11px',
              'font-family': "'JetBrains Mono', monospace",
              color: theme.fgMuted,
              'border-bottom': `1px solid ${theme.border}`,
              'flex-shrink': '0',
            }}
          >
            {props.selectedFile?.path}
          </div>
          <Show
            when={!props.sideBySide}
            fallback={
              <MonacoDiffEditor
                oldContent={props.diff?.oldContent ?? ''}
                newContent={props.diff?.newContent ?? ''}
                language={getLanguage(props.selectedFile?.path ?? '')}
                onRevealLine={() => props.reviewSession.setScrollTarget(null)}
                revealLine={props.monacoRevealLine}
                sideBySide={props.sideBySide}
              />
            }
          >
            <ScrollingDiffView
              files={props.parsedDiffFiles}
              request={props.reviewDiffRequest}
              reviewSession={props.reviewSession}
              scrollToPath={props.selectedFile?.path ?? null}
              startAskSession={props.startAskSession}
            />
          </Show>
        </div>
        <Show when={props.showSidebar}>
          <ReviewSidebar {...props.reviewSidebarProps} />
        </Show>
      </Show>
    </div>
  );
}
